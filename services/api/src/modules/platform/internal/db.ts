// Database access. The ONLY ways to run SQL are:
//   withTenantTx(tenantId, fn)  - one transaction, tenant set for that transaction only
//   withinTenant(tx, id, fn)    - the SAME transaction, switched to another tenant for a moment
//   global(text, params)        - single statements against GLOBAL tables
// Row-level security does the filtering; if the tenant is not set, tenant tables return nothing.
import pg from 'pg';
import { isUuid } from '../../../shared/crypto.ts';

export interface QueryResult<R> {
  rows: R[];
  rowCount: number;
}

export interface Tx {
  query<R = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<QueryResult<R>>;
}

export class UnsafeDatabaseRoleError extends Error {
  constructor(reason: string) {
    super(`Refusing to start: ${reason}`);
    this.name = 'UnsafeDatabaseRoleError';
  }
}

export class Database {
  readonly #pool: pg.Pool;
  /** The tenant each open transaction was started for, and whether it is currently switched away. */
  readonly #txTenant = new WeakMap<Tx, { home: string; switched: boolean }>();

  constructor(connectionString: string, poolMax: number) {
    this.#pool = new pg.Pool({
      connectionString,
      max: poolMax,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      // Client-side limit for every statement (works through transaction-mode poolers too).
      query_timeout: 20_000,
    });
    // A dropped idle connection must not crash the process.
    this.#pool.on('error', () => undefined);
  }

  /**
   * Runs `fn` inside one transaction with the tenant set for that transaction only.
   * `set_config(..., true)` is the bind-parameter form of SET LOCAL: it resets at
   * COMMIT/ROLLBACK, so it is safe with transaction-mode connection pooling.
   */
  async withTenantTx<T>(tenantId: string, fn: (tx: Tx) => Promise<T>, options: { platformScope?: boolean } = {}): Promise<T> {
    if (!isUuid(tenantId)) throw new Error('withTenantTx: tenant id is not a UUID');
    const client = await this.#pool.connect();
    const tx: Tx = {
      query: async (text, params) => {
        const res = await client.query(text, params as unknown[] | undefined);
        return { rows: res.rows, rowCount: res.rowCount ?? 0 };
      },
    };
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
      // Per-transaction, not a connection start-up parameter: transaction-mode poolers
      // (PgBouncer, as used by Neon's pooled host) reject unknown start-up parameters.
      await client.query('SELECT set_config($1, $2, true)', ['statement_timeout', '15000']);
      if (options.platformScope === true) {
        await client.query('SELECT set_config($1, $2, true)', ['app.platform_scope', 'on']);
      }
      this.#txTenant.set(tx, { home: tenantId, switched: false });
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The connection is broken; release(true) below discards it.
        client.release(true);
        throw err;
      }
      throw err;
    } finally {
      try {
        client.release();
      } catch {
        // already released above
      }
    }
  }

  /**
   * Runs `fn` with an open transaction switched to ANOTHER tenant, then switches it back.
   * Everything stays in the one transaction, so work done for both tenants commits or rolls
   * back together. Used only by platform-operator actions on a customer tenant (create a
   * tenant, renew its company card, recover an Owner). Cannot be nested, and works ONLY in a
   * transaction that was opened for the operator tenant: a customer's transaction can never
   * be switched, whatever the permission tables say.
   * Do not roll back to a savepoint taken inside `fn` after it returns: that would restore the
   * other tenant's id.
   */
  async withinTenant<T>(tx: Tx, tenantId: string, fn: () => Promise<T>): Promise<T> {
    if (!isUuid(tenantId)) throw new Error('withinTenant: tenant id is not a UUID');
    const state = this.#txTenant.get(tx);
    if (!state) throw new Error('withinTenant: not a transaction opened by withTenantTx');
    if (state.home !== PLATFORM_TENANT_ID) throw new Error('withinTenant: only a transaction of the operator tenant can be switched');
    if (state.switched) throw new Error('withinTenant: already switched to another tenant');
    state.switched = true;
    await tx.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
    let failed = true;
    try {
      const result = await fn();
      failed = false;
      return result;
    } finally {
      // Always go back, so that code which catches an error cannot keep writing as the other
      // tenant. If the transaction is already aborted this statement fails too; the original
      // error is the one that matters and the whole transaction rolls back anyway.
      try {
        await tx.query('SELECT set_config($1, $2, true)', ['app.tenant_id', state.home]);
        state.switched = false;
      } catch (err) {
        if (!failed) throw err;
      }
    }
  }

  /** One statement, no tenant. For GLOBAL tables and functions only. */
  async global<R = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<QueryResult<R>> {
    const res = await this.#pool.query(text, params as unknown[] | undefined);
    return { rows: res.rows, rowCount: res.rowCount ?? 0 };
  }

  /**
   * Start-up self-check. The API must connect with a role that cannot bypass row-level
   * security. A superuser or BYPASSRLS connection would silently disable tenant isolation,
   * so we refuse to run with one.
   */
  async assertSafeRole(): Promise<void> {
    const { rows } = await this.global<{ rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean }>(
      'SELECT rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = current_user',
    );
    const role = rows[0];
    if (!role) throw new UnsafeDatabaseRoleError('could not read the current database role');
    if (role.rolsuper) throw new UnsafeDatabaseRoleError('the database role is a superuser');
    if (role.rolbypassrls) throw new UnsafeDatabaseRoleError('the database role can bypass row-level security');
    if (role.rolcreaterole) throw new UnsafeDatabaseRoleError('the database role can create roles');
  }

  async ping(): Promise<boolean> {
    try {
      await this.global('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async migrationsCurrent(expected: string): Promise<boolean> {
    try {
      const { rows } = await this.global<{ version: string }>('SELECT max(version) AS version FROM schema_migrations');
      return rows[0]?.version === expected;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}

/** The newest migration this build of the API expects. Checked by the readiness endpoint. */
export const EXPECTED_SCHEMA_VERSION = '20261004000200';

/** The LegacyAI operator tenant (seeded by the first migration). */
export const PLATFORM_TENANT_ID = '00000000-0000-7000-8000-000000000001';
