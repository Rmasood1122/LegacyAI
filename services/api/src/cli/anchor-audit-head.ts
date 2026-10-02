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
import { listTenants, loadConfig, PLATFORM_TENANT_ID, recordAnchor } from '../modules/platform/index.ts';

export interface AnchorLine {
  tenant_id: string;
  seq: number;
  row_hash: string;
  anchored_at: string;
}

export async function anchorAll(app: App, objectUri: string, now: Date): Promise<AnchorLine[]> {
  const tenants = await app.db.withTenantTx(PLATFORM_TENANT_ID, (tx) => listTenants(tx, 100_000, null), { platformScope: true });
  const lines: AnchorLine[] = [];
  for (const t of tenants) {
    const head = await app.db.withTenantTx(t.id, (tx) => recordAnchor(tx, t.id, objectUri));
    if (head) lines.push({ tenant_id: t.id, seq: head.seq, row_hash: head.row_hash, anchored_at: now.toISOString() });
  }
  return lines;
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
    if (bucket !== undefined) {
      const lines = await anchorAll(app, `gs://${bucket}/anchors/${name}`, now);
      await uploadToGcs(bucket, `anchors/${name}`, renderAnchors(lines));
      console.log(JSON.stringify({ anchored_tenants: lines.length, object: `gs://${bucket}/anchors/${name}` }));
    } else {
      const file = out as string;
      const lines = await anchorAll(app, `file:${path.basename(file)}`, now);
      // 'wx' = fail if the file exists: an anchor file is never overwritten.
      writeFileSync(file, renderAnchors(lines), { flag: 'wx' });
      console.log(JSON.stringify({ anchored_tenants: lines.length, file }));
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : 'anchor failed');
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}
