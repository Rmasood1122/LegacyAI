// Tenants, tenant settings and the tenant data export skeleton (feature 30).
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isUuid } from '../../../shared/crypto.ts';
import { problems } from '../../../shared/errors.ts';
import type { RoleKey } from '../../../shared/policy-types.ts';
import type { Tx } from './db.ts';

export interface TenantRow {
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'suspended' | 'closed';
  is_platform: boolean;
  plan_code: string;
  region: string;
  created_at: Date;
}

export interface TenantSettings {
  card_validity_days: number;
  grace_days: number;
  renewal_notice_days: number;
  sc_lockout_threshold: number;
  session_idle_minutes: number;
  session_absolute_hours: number;
  enabled_roles: RoleKey[];
  pilot_reviewer_grant: boolean;
  allowed_factor_types: Array<'passkey' | 'totp'>;
}

const TENANT_COLUMNS = 'id, name, slug, status, is_platform, plan_code, region, created_at';
const SETTINGS_COLUMNS = `card_validity_days, grace_days, renewal_notice_days, sc_lockout_threshold, session_idle_minutes,
  session_absolute_hours, enabled_roles, pilot_reviewer_grant, allowed_factor_types`;

export async function getTenant(tx: Tx, tenantId: string): Promise<TenantRow | null> {
  const { rows } = await tx.query<TenantRow>(`SELECT ${TENANT_COLUMNS} FROM tenants WHERE id = $1`, [tenantId]);
  return rows[0] ?? null;
}

export async function getSettings(tx: Tx, tenantId: string): Promise<TenantSettings> {
  const { rows } = await tx.query<TenantSettings>(`SELECT ${SETTINGS_COLUMNS} FROM tenant_settings WHERE tenant_id = $1`, [tenantId]);
  const row = rows[0];
  // No settings row means we cannot know the lockout threshold or timeouts: stop rather than guess.
  if (!row) throw new Error('tenant settings are missing');
  return row;
}

/** Must be called inside withTenantTx(newTenantId): the INSERT is checked by row-level security. */
export async function createTenant(tx: Tx, p: { id: string; name: string; slug: string }): Promise<TenantRow> {
  try {
    const { rows } = await tx.query<TenantRow>(
      `INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3) RETURNING ${TENANT_COLUMNS}`, [p.id, p.name, p.slug]);
    await tx.query('INSERT INTO tenant_settings (tenant_id) VALUES ($1)', [p.id]);
    return rows[0] as TenantRow;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw problems.conflict('slug-taken', 'That tenant slug is already in use');
    throw err;
  }
}

/** Requires a transaction opened with platformScope (read-only cross-tenant listing). */
export async function listTenants(tx: Tx, limit: number, afterId: string | null): Promise<TenantRow[]> {
  const { rows } = await tx.query<TenantRow>(
    `SELECT ${TENANT_COLUMNS} FROM tenants WHERE ($1::uuid IS NULL OR id > $1::uuid) ORDER BY id ASC LIMIT $2`,
    [afterId, limit],
  );
  return rows;
}

const SETTING_KEYS: ReadonlyArray<keyof TenantSettings> = [
  'card_validity_days', 'grace_days', 'renewal_notice_days', 'sc_lockout_threshold', 'session_idle_minutes',
  'session_absolute_hours', 'enabled_roles', 'pilot_reviewer_grant', 'allowed_factor_types',
];

export async function updateSettings(
  tx: Tx, tenantId: string, patch: Partial<TenantSettings>, actorCardId: string,
): Promise<TenantSettings> {
  const current = await getSettings(tx, tenantId);
  const next: TenantSettings = { ...current };
  for (const key of SETTING_KEYS) {
    if (patch[key] !== undefined) (next as unknown as Record<string, unknown>)[key] = patch[key];
  }
  if (!next.enabled_roles.includes('company_owner')) {
    throw problems.unprocessable('The Company Owner role cannot be disabled');
  }
  try {
    await tx.query(
      `UPDATE tenant_settings SET card_validity_days = $2, grace_days = $3, renewal_notice_days = $4,
         sc_lockout_threshold = $5, session_idle_minutes = $6, session_absolute_hours = $7, enabled_roles = $8,
         pilot_reviewer_grant = $9, allowed_factor_types = $10, updated_at = now(), updated_by_card_id = $11
       WHERE tenant_id = $1`,
      [
        tenantId, next.card_validity_days, next.grace_days, next.renewal_notice_days, next.sc_lockout_threshold,
        next.session_idle_minutes, next.session_absolute_hours, next.enabled_roles, next.pilot_reviewer_grant,
        next.allowed_factor_types, actorCardId,
      ],
    );
  } catch (err) {
    // The database CHECK constraints are the last word on ranges (e.g. lockout threshold 3-5).
    if ((err as { code?: string }).code === '23514') throw problems.unprocessable('A setting is outside its allowed range');
    throw err;
  }
  return next;
}

export function toApiTenant(t: TenantRow): Record<string, unknown> {
  return {
    id: t.id, name: t.name, slug: t.slug, status: t.status, plan_code: t.plan_code, region: t.region,
    created_at: t.created_at.toISOString(),
  };
}

export async function getPlan(tx: Tx, planCode: string): Promise<{ plan_code: string; max_person_cards: number | null; max_admin_cards: number | null }> {
  const { rows } = await tx.query<{ plan_code: string; max_person_cards: number | null; max_admin_cards: number | null }>(
    'SELECT plan_code, max_person_cards, max_admin_cards FROM plan_limits WHERE plan_code = $1', [planCode]);
  return rows[0] ?? { plan_code: planCode, max_person_cards: null, max_admin_cards: null };
}

// ------------------------------------------------------------------- data export

/** A table a module agrees to include in tenant exports, with an explicit column allow-list. */
export interface ExportTable {
  table: string;
  columns: string[];
  orderBy: string;
}

const IDENT = /^[a-z_][a-z0-9_]*$/;

export class ExportRegistry {
  readonly #tables: ExportTable[] = [];

  register(t: ExportTable): void {
    // Table and column names become part of SQL text, so they must be plain identifiers
    // coming from code - never from a request.
    for (const ident of [t.table, t.orderBy, ...t.columns]) {
      if (!IDENT.test(ident)) throw new Error(`export: "${ident}" is not a plain identifier`);
    }
    this.#tables.push(t);
  }

  list(): readonly ExportTable[] {
    return this.#tables;
  }
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = value instanceof Date ? value.toISOString() : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function jsonValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString('hex');
  return value;
}

export interface ExportJobRow {
  id: string;
  status: string;
  format: string;
  manifest: Record<string, unknown> | null;
  created_at: Date;
  completed_at: Date | null;
}

/**
 * Writes the tenant's own rows to JSON Lines + CSV files with a manifest of row counts
 * and SHA-256 checksums. Runs under row-level security, so it cannot include another
 * tenant's rows. Phase 1 skeleton: synchronous, writes to a local directory.
 */
export async function runExport(
  tx: Tx, registry: ExportRegistry, tenantId: string, requestedByCardId: string, baseDir: string,
): Promise<ExportJobRow> {
  if (!isUuid(tenantId)) throw new Error('export: tenant id is not a UUID');
  const created = await tx.query<{ id: string }>(
    `INSERT INTO export_jobs (tenant_id, requested_by_card_id, status) VALUES ($1, $2, 'running') RETURNING id`,
    [tenantId, requestedByCardId],
  );
  const jobId = (created.rows[0] as { id: string }).id;
  const dir = path.join(baseDir, tenantId, jobId);
  await mkdir(dir, { recursive: true });

  const files: Array<{ table: string; rows: number; jsonl_sha256: string; csv_sha256: string }> = [];
  for (const t of registry.list()) {
    // eslint-disable-next-line no-restricted-syntax -- identifiers validated by ExportRegistry.register; values are bound
    const { rows } = await tx.query<Record<string, unknown>>(`SELECT ${t.columns.join(', ')} FROM ${t.table} WHERE tenant_id = $1 ORDER BY ${t.orderBy}`, [tenantId]);
    const jsonl = rows.map((r) => JSON.stringify(Object.fromEntries(t.columns.map((c) => [c, jsonValue(r[c])])))).join('\n') + (rows.length ? '\n' : '');
    const csv = [t.columns.join(','), ...rows.map((r) => t.columns.map((c) => csvCell(jsonValue(r[c]))).join(','))].join('\n') + '\n';
    await writeFile(path.join(dir, `${t.table}.jsonl`), jsonl, 'utf8');
    await writeFile(path.join(dir, `${t.table}.csv`), csv, 'utf8');
    files.push({
      table: t.table,
      rows: rows.length,
      jsonl_sha256: createHash('sha256').update(jsonl).digest('hex'),
      csv_sha256: createHash('sha256').update(csv).digest('hex'),
    });
  }
  const manifest = { tenant_id: tenantId, export_id: jobId, format: 'jsonl+csv', files };
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  const done = await tx.query<ExportJobRow>(
    `UPDATE export_jobs SET status = 'done', manifest = $2, completed_at = now() WHERE id = $1
     RETURNING id, status, format, manifest, created_at, completed_at`,
    [jobId, JSON.stringify(manifest)],
  );
  return done.rows[0] as ExportJobRow;
}

export async function getExportJob(tx: Tx, id: string): Promise<ExportJobRow | null> {
  const { rows } = await tx.query<ExportJobRow>(
    'SELECT id, status, format, manifest, created_at, completed_at FROM export_jobs WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export function toApiExportJob(j: ExportJobRow): Record<string, unknown> {
  return {
    id: j.id, status: j.status, format: j.format, manifest: j.manifest,
    created_at: j.created_at.toISOString(), completed_at: j.completed_at ? j.completed_at.toISOString() : null,
  };
}
