// Writes every tenant's current audit chain head OUTSIDE the database, one JSON object per line.
//
//   local file:    npm run audit:anchor -- --out ./anchors.jsonl
//   Cloud Storage: node dist/cli/anchor-audit-head.js --gcs-bucket <bucket>      (the scheduled job)
//
// The file is the EXTERNAL record. `audit:verify --anchors <file>` compares the database
// against it, which is what catches a rewrite of the whole chain.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, type App } from '../app.ts';
import { listTenants, loadConfig, PLATFORM_TENANT_ID } from '../modules/platform/index.ts';

export interface AnchorLine {
  tenant_id: string;
  seq: number;
  row_hash: string;
  anchored_at: string;
}

/** Reads every tenant's chain head. Writes nothing. */
export async function readHeads(app: App, now: Date): Promise<AnchorLine[]> {
  const tenants = await app.db.withTenantTx(PLATFORM_TENANT_ID, (tx) => listTenants(tx, 100_000, null), { platformScope: true });
  const lines: AnchorLine[] = [];
  for (const t of tenants) {
    const head = await app.db.withTenantTx(t.id, async (tx) => {
      const { rows } = await tx.query<{ last_seq: string; last_hash: Buffer }>(
        'SELECT last_seq::text AS last_seq, last_hash FROM audit_chain_heads WHERE tenant_id = $1', [t.id]);
      return rows[0] && Number(rows[0].last_seq) > 0 ? { seq: Number(rows[0].last_seq), row_hash: rows[0].last_hash.toString('hex') } : null;
    });
    if (head) lines.push({ tenant_id: t.id, seq: head.seq, row_hash: head.row_hash, anchored_at: now.toISOString() });
  }
  return lines;
}

/** Records in the database that these heads were stored at `objectUri`. Call ONLY after the external write succeeded. */
export async function recordAnchors(app: App, lines: AnchorLine[], objectUri: string): Promise<void> {
  for (const l of lines) {
    await app.db.withTenantTx(l.tenant_id, (tx) => tx.query(
      'INSERT INTO audit_anchors (tenant_id, seq, row_hash, object_uri) VALUES ($1, $2, $3, $4)',
      [l.tenant_id, l.seq, Buffer.from(l.row_hash, 'hex'), objectUri]));
  }
}

export function renderAnchors(lines: AnchorLine[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : '');
}

/**
 * Uploads to Cloud Storage using the identity of the Cloud Run job (metadata server).
 * ifGenerationMatch=0 = "only if the object does not exist": an anchor is never overwritten.
 * NOT PROVEN LOCALLY - this needs a real Google Cloud job to run.
 */
async function uploadToGcs(bucket: string, objectName: string, body: string): Promise<void> {
  const tokenRes = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
    headers: { 'Metadata-Flavor': 'Google' },
  });
  if (!tokenRes.ok) throw new Error('could not get an access token from the metadata server');
  const { access_token: token } = (await tokenRes.json()) as { access_token?: string };
  if (typeof token !== 'string' || token === '') throw new Error('metadata server returned no access token');
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&ifGenerationMatch=0&name=${encodeURIComponent(objectName)}`;
  const res = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-ndjson' }, body });
  if (!res.ok) throw new Error(`anchor upload failed with HTTP ${res.status}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  const out = value('--out');
  const bucket = value('--gcs-bucket');
  if ((out === undefined) === (bucket === undefined) || (bucket !== undefined && !/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(bucket))) {
    console.error('usage: audit:anchor -- --out <file.jsonl>   OR   --gcs-bucket <bucket-name>');
    process.exit(2);
  }
  const now = new Date();
  const name = `anchors-${now.toISOString().replace(/[:.]/g, '-')}.jsonl`;
  const app = await createApp(loadConfig(process.env));
  try {
    const lines = await readHeads(app, now);
    // Order matters: the external copy is written FIRST. The database only records an anchor
    // that really exists outside it.
    if (bucket !== undefined) {
      await uploadToGcs(bucket, `anchors/${name}`, renderAnchors(lines));
      await recordAnchors(app, lines, `gs://${bucket}/anchors/${name}`);
      console.log(JSON.stringify({ anchored_tenants: lines.length, object: `gs://${bucket}/anchors/${name}` }));
    } else {
      const file = out as string;
      // 'wx' = fail if the file exists: an anchor file is never overwritten.
      writeFileSync(file, renderAnchors(lines), { flag: 'wx' });
      await recordAnchors(app, lines, `file:${path.basename(file)}`);
      console.log(JSON.stringify({ anchored_tenants: lines.length, file }));
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : 'anchor failed');
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}
