// Audit log: append-only, hash-chained per tenant. TAMPER-EVIDENT, not tamper-proof.
//
// The database trigger computes each row's hash. The verifier below recomputes it
// INDEPENDENTLY in TypeScript (it does not call the database function), so a change to
// either side that breaks agreement is caught by the tests.
import { sha256 } from '../../../shared/crypto.ts';
import type { Tx } from './db.ts';

export type AuditDetailValue = string | number | boolean | null;

export interface AuditEntry {
  tenantId: string;
  actorCardId?: string | null;
  /** 'operator': a LegacyAI platform operator acting on a customer tenant; actorCardId is the operator's card. */
  actorKind: 'card' | 'system' | 'anonymous' | 'service' | 'operator';
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  decision: 'allow' | 'deny' | 'event';
  reasonCode: string;
  requestId?: string | null;
  ip?: string | null;
  details?: Record<string, AuditDetailValue>;
}

// Only these keys may appear in `details`. Anything else is a programming error and is
// rejected, so a secret or a name cannot be written to the audit log by accident.
export const ALLOWED_DETAIL_KEYS: ReadonlySet<string> = new Set([
  'outcome', 'status', 'state_from', 'state_to', 'role_key', 'reason', 'scope', 'resource_type', 'operation',
  'factor_type', 'credential_id', 'new_card_id', 'old_card_id', 'person_id', 'export_id', 'rows', 'idempotent_replay',
  'restriction_type', 'limit_key', 'changed', 'target_tenant_id', 'session_reason', 'count', 'anchor_seq', 'obligations',
  'verification_ref', 'target_card_id',
  // Phase 2 (the same list is held in the database table audit_detail_keys; a test keeps them equal)
  'source_id', 'chunk_count', 'redactions', 'item_id', 'version_no', 'feature', 'model', 'cost_micro_usd', 'task_id',
  'consent_id', 'attempt_id', 'candidates', 'approved', 'policy_disagreements', 'sensitivity_from', 'sensitivity_to',
  'department_from', 'department_to', 'interview_id', 'topic_id',
  // Phase 4 (answer feedback): the opinion and whether the question was shared - never the comment or the question
  'verdict', 'question_shared',
  // Phase 4 (anomaly lock, retirement radar, department templates): which rule, which stage, which template
  'rule', 'stage', 'template_key',
  // Phase 4 (billing): which invoice, how much (a whole number), which currency, how many seats, what was switched,
  // what the provider reported - never anything about a payment card (none is stored)
  'invoice_id', 'amount_minor', 'currency', 'seats', 'auto_renew', 'payment_outcome',
]);

const FORBIDDEN_VALUE = /\b\d{16}\b/;

export function canonicalDetails(details: Record<string, AuditDetailValue> | undefined): string {
  if (!details) return '{}';
  const out: Record<string, AuditDetailValue> = {};
  for (const key of Object.keys(details).sort()) {
    if (!ALLOWED_DETAIL_KEYS.has(key)) throw new Error(`audit: detail key "${key}" is not on the allow-list`);
    const value = details[key] as AuditDetailValue;
    if (typeof value === 'string' && (value.length > 200 || FORBIDDEN_VALUE.test(value))) {
      throw new Error(`audit: detail "${key}" has a value that is too long or looks like a card number`);
    }
    out[key] = value;
  }
  return JSON.stringify(out);
}

/**
 * Every audit row - from this API and from the Python service - is written through the one
 * database function `audit_write()`, which enforces the detail-key allow-list in the database
 * and leaves sequence numbers and hashes to the chain trigger. The checks here run first so a
 * programming error is caught with a clear message before it reaches the database.
 */
export async function writeAudit(tx: Tx, entry: AuditEntry): Promise<void> {
  await tx.query(
    'SELECT audit_write($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
    [
      entry.tenantId, entry.actorCardId ?? null, entry.actorKind, entry.action, entry.resourceType ?? null,
      entry.resourceId ?? null, entry.decision, entry.reasonCode, entry.requestId ?? null, entry.ip ?? null,
      canonicalDetails(entry.details),
    ],
  );
}

export interface AuditRow {
  tenant_id: string;
  seq: string;
  occurred_at: Date;
  occurred_us: string;
  actor_card_id: string | null;
  actor_kind: string;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  decision: string;
  reason_code: string;
  request_id: string | null;
  ip: string | null;
  details: string;
  prev_hash: Buffer;
  row_hash: Buffer;
}

const ROW_COLUMNS = `tenant_id, seq::text AS seq, occurred_at, (extract(epoch FROM occurred_at) * 1000000)::bigint::text AS occurred_us,
  actor_card_id, actor_kind, action, resource_type, resource_id, decision, reason_code, request_id, ip, details, prev_hash, row_hash`;

/** FROZEN FORMAT - must match audit_field() in the database: "<byte length>:<value>" or "-1:" for NULL. */
function field(value: string | null): string {
  return value === null ? '-1:' : `${Buffer.byteLength(value, 'utf8')}:${value}`;
}

export function computeRowHash(row: AuditRow): Buffer {
  const canonical =
    field(row.tenant_id) + field(row.seq) + field(row.occurred_us) + field(row.actor_card_id) + field(row.actor_kind) +
    field(row.action) + field(row.resource_type) + field(row.resource_id) + field(row.decision) +
    field(row.reason_code) + field(row.request_id) + field(row.ip) + field(row.details);
  return sha256(Buffer.concat([row.prev_hash, Buffer.from(canonical, 'utf8')]));
}

export interface VerifyResult {
  ok: boolean;
  /** false when the row limit stopped the check before the end of the requested range. */
  complete: boolean;
  rows_checked: number;
  head_seq: number;
  head_hash: string | null;
  first_broken_seq: number | null;
  broken_reason: string | null;
  last_anchor: { seq: number; anchored_at: string; matches: boolean } | null;
}

const ZERO_HASH = Buffer.alloc(32);

/** Recomputes the chain for the tenant of the current transaction and reports the first broken row. */
export async function verifyChain(tx: Tx, tenantId: string, fromSeq = 1, toSeq?: number, maxRows = Number.MAX_SAFE_INTEGER): Promise<VerifyResult> {
  const result: VerifyResult = {
    ok: true, complete: true, rows_checked: 0, head_seq: 0, head_hash: null, first_broken_seq: null, broken_reason: null, last_anchor: null,
  };
  const fail = (seq: number, reason: string): void => {
    if (result.ok) {
      result.ok = false;
      result.first_broken_seq = seq;
      result.broken_reason = reason;
    }
  };

  const headRow = await tx.query<{ last_seq: string; last_hash: Buffer }>(
    'SELECT last_seq::text AS last_seq, last_hash FROM audit_chain_heads WHERE tenant_id = $1', [tenantId]);
  const headSeq = headRow.rows[0] ? Number(headRow.rows[0].last_seq) : 0;

  let expectedSeq = Math.max(1, fromSeq);
  let prevHash: Buffer = ZERO_HASH;
  if (expectedSeq > 1) {
    const prev = await tx.query<{ row_hash: Buffer }>(
      'SELECT row_hash FROM audit_log WHERE tenant_id = $1 AND seq = $2', [tenantId, expectedSeq - 1]);
    if (prev.rows[0]) prevHash = prev.rows[0].row_hash;
    // A start beyond the end of the chain is an empty range, not a broken chain.
    else if (expectedSeq - 1 <= headSeq) fail(expectedSeq - 1, 'row_missing');
  }

  const BATCH = 1000;
  let lastSeq = expectedSeq - 1;
  let lastHash: Buffer = prevHash;
  for (;;) {
    const upper = toSeq ?? Number.MAX_SAFE_INTEGER;
    const remaining = maxRows - result.rows_checked;
    if (remaining <= 0) {
      result.complete = false;
      break;
    }
    const { rows } = await tx.query<AuditRow>(
      `SELECT ${ROW_COLUMNS} FROM audit_log WHERE tenant_id = $1 AND seq > $2 AND seq <= $3 ORDER BY audit_log.seq ASC LIMIT $4`,
      [tenantId, lastSeq, upper, Math.min(BATCH, remaining)],
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      const seq = Number(row.seq);
      result.rows_checked += 1;
      if (seq !== expectedSeq) fail(expectedSeq, 'sequence_gap');
      if (!row.prev_hash.equals(lastHash)) fail(seq, 'prev_hash_mismatch');
      if (!computeRowHash(row).equals(row.row_hash)) fail(seq, 'row_hash_mismatch');
      lastSeq = seq;
      lastHash = row.row_hash;
      expectedSeq = seq + 1;
    }
    if (rows.length < Math.min(BATCH, remaining)) break;
  }

  // The head row is written only by the trigger. A deleted tail shows up as a mismatch here.
  if (headRow.rows[0]) {
    result.head_seq = headSeq;
    result.head_hash = headRow.rows[0].last_hash.toString('hex');
    if (toSeq === undefined && result.complete) {
      if (headSeq !== lastSeq && !(result.rows_checked === 0 && fromSeq > headSeq + 1)) fail(lastSeq + 1, 'head_seq_mismatch');
      else if (headSeq === lastSeq && lastSeq > 0 && !headRow.rows[0].last_hash.equals(lastHash)) fail(lastSeq, 'head_hash_mismatch');
    }
  } else {
    // Every tenant gets audit rows from the moment it is created, so a tenant with NO head row
    // has had its audit trail removed.
    fail(Math.max(lastSeq, 1), 'head_missing');
  }

  const anchor = await tx.query<{ seq: string; row_hash: Buffer; anchored_at: Date }>(
    'SELECT seq::text AS seq, row_hash, anchored_at FROM audit_anchors WHERE tenant_id = $1 ORDER BY audit_anchors.seq DESC, anchored_at DESC LIMIT 1',
    [tenantId],
  );
  if (anchor.rows[0]) {
    const a = anchor.rows[0];
    const at = await tx.query<{ row_hash: Buffer }>(
      'SELECT row_hash FROM audit_log WHERE tenant_id = $1 AND seq = $2', [tenantId, a.seq]);
    const matches = at.rows[0] !== undefined && at.rows[0].row_hash.equals(a.row_hash);
    result.last_anchor = { seq: Number(a.seq), anchored_at: a.anchored_at.toISOString(), matches };
    if (!matches) fail(Number(a.seq), 'anchor_mismatch');
  }
  return result;
}

/** Compares the database against anchors read from OUTSIDE the database (the write-once-style bucket). */
export async function verifyAgainstExternalAnchors(
  tx: Tx,
  tenantId: string,
  anchors: ReadonlyArray<{ tenant_id: string; seq: number; row_hash: string }>,
): Promise<{ ok: boolean; mismatched_seq: number | null }> {
  for (const a of anchors.filter((x) => x.tenant_id === tenantId)) {
    const { rows } = await tx.query<{ row_hash: Buffer }>(
      'SELECT row_hash FROM audit_log WHERE tenant_id = $1 AND seq = $2', [tenantId, a.seq]);
    if (!rows[0] || rows[0].row_hash.toString('hex') !== a.row_hash) return { ok: false, mismatched_seq: a.seq };
  }
  return { ok: true, mismatched_seq: null };
}

export interface AuditFilters {
  actor_card_id?: string;
  action?: string;
  resource_type?: string;
  resource_id?: string;
  decision?: string;
}

export async function queryAudit(
  tx: Tx, tenantId: string, filters: AuditFilters, limit: number, beforeSeq: number | null,
): Promise<AuditRow[]> {
  const { rows } = await tx.query<AuditRow>(
    `SELECT ${ROW_COLUMNS} FROM audit_log
      WHERE tenant_id = $1
        AND ($2::uuid IS NULL OR actor_card_id = $2::uuid)
        AND ($3::text IS NULL OR action = $3)
        AND ($4::text IS NULL OR resource_type = $4)
        AND ($5::text IS NULL OR resource_id = $5)
        AND ($6::text IS NULL OR decision = $6)
        AND ($7::bigint IS NULL OR seq < $7::bigint)
      ORDER BY audit_log.seq DESC LIMIT $8`,
    [
      tenantId, filters.actor_card_id ?? null, filters.action ?? null, filters.resource_type ?? null,
      filters.resource_id ?? null, filters.decision ?? null, beforeSeq, limit,
    ],
  );
  return rows;
}

export function toApiAuditEvent(row: AuditRow): Record<string, unknown> {
  return {
    seq: Number(row.seq),
    occurred_at: row.occurred_at.toISOString(),
    actor_card_id: row.actor_card_id,
    actor_kind: row.actor_kind,
    action: row.action,
    resource_type: row.resource_type,
    resource_id: row.resource_id,
    decision: row.decision,
    reason_code: row.reason_code,
    request_id: row.request_id,
    ip: row.ip,
    details: JSON.parse(row.details) as Record<string, unknown>,
    prev_hash: row.prev_hash.toString('hex'),
    row_hash: row.row_hash.toString('hex'),
  };
}

/** Records that the current chain head was copied to the external bucket. */
export async function recordAnchor(tx: Tx, tenantId: string, objectUri: string): Promise<{ seq: number; row_hash: string } | null> {
  const head = await tx.query<{ last_seq: string; last_hash: Buffer }>(
    'SELECT last_seq::text AS last_seq, last_hash FROM audit_chain_heads WHERE tenant_id = $1', [tenantId]);
  const h = head.rows[0];
  if (!h || Number(h.last_seq) === 0) return null;
  await tx.query('INSERT INTO audit_anchors (tenant_id, seq, row_hash, object_uri) VALUES ($1, $2, $3, $4)', [
    tenantId, h.last_seq, h.last_hash, objectUri,
  ]);
  return { seq: Number(h.last_seq), row_hash: h.last_hash.toString('hex') };
}

export async function countAuditRows(tx: Tx, tenantId: string): Promise<number> {
  const { rows } = await tx.query<{ last_seq: string }>(
    'SELECT last_seq::text AS last_seq FROM audit_chain_heads WHERE tenant_id = $1', [tenantId]);
  return rows[0] ? Number(rows[0].last_seq) : 0;
}
