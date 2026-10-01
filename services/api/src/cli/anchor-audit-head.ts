// Writes every tenant's current audit chain head to a file, one JSON object per line.
// scripts/audit-anchor.sh then uploads that file to the write-once-style bucket.
//
//   npm run audit:anchor -- --out ./anchors-2026-10-02T00-00-00Z.jsonl --uri-prefix gs://my-anchor-bucket/anchors
//
// The file is the EXTERNAL record: keep it outside the database. `audit:verify --anchors`
// compares the database against it.
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  const out = value('--out');
  const prefix = value('--uri-prefix');
  if (out === undefined || prefix === undefined) {
    console.error('usage: audit:anchor -- --out <file.jsonl> --uri-prefix <gs://bucket/path>');
    process.exit(2);
  }
  const app = await createApp(loadConfig(process.env));
  try {
    const lines = await anchorAll(app, `${prefix.replace(/\/$/, '')}/${path.basename(out)}`, new Date());
    // 'wx' = fail if the file exists: an anchor file is never overwritten.
    writeFileSync(out, lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : ''), { flag: 'wx' });
    console.log(JSON.stringify({ anchored_tenants: lines.length, file: out }));
  } finally {
    await app.close();
  }
}
