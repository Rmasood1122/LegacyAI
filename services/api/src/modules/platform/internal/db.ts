// Database access. The ONLY ways to run SQL are:
//   withTenantTx(tenantId, fn)  - one transaction, tenant set for that transaction only
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

  constructor(connectionString: string, poolMax: number) {
    this.#pool = new pg.Pool({
      connectionString,
      max: poolMax,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 15_000,
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
      if (options.platformScope === true) {
        await client.query('SELECT set_config($1, $2, true)', ['app.platform_scope', 'on']);
      }
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
export const EXPECTED_SCHEMA_VERSION = '20261002000500';

/** The LegacyAI operator tenant (seeded by the first migration). */
export const PLATFORM_TENANT_ID = '00000000-0000-7000-8000-000000000001';
