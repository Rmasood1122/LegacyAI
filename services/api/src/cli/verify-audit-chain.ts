// Recomputes the audit hash chain and reports the first broken row.
//
//   npm run audit:verify -- --tenant all
//   npm run audit:verify -- --tenant <tenant-id> --anchors ./anchors.jsonl
//
// --anchors takes a file of chain heads that was stored OUTSIDE the database (the anchor
// bucket). Without it, someone with full database control could rewrite the whole chain
// consistently and this command would not notice; with it, they would be caught.
// Exit code: 0 = every chain intact, 1 = at least one problem, 2 = bad arguments.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp, type App } from '../app.ts';
import { listTenants, loadConfig, PLATFORM_TENANT_ID, verifyAgainstExternalAnchors, verifyChain, type VerifyResult } from '../modules/platform/index.ts';
import { isUuid } from '../shared/crypto.ts';

export interface ExternalAnchor {
  tenant_id: string;
  seq: number;
  row_hash: string;
}

export interface ChainReport extends VerifyResult {
  tenant_id: string;
  external_anchor_ok: boolean | null;
  external_anchor_mismatch_seq: number | null;
}

export function parseAnchors(text: string): ExternalAnchor[] {
  return text.split('\n').filter((l) => l.trim() !== '').map((line, i) => {
    const a = JSON.parse(line) as Partial<ExternalAnchor>;
    if (!isUuid(a.tenant_id) || !Number.isSafeInteger(a.seq) || typeof a.row_hash !== 'string' || !/^[0-9a-f]{64}$/.test(a.row_hash)) {
      throw new Error(`anchors file: line ${i + 1} is not a valid anchor`);
    }
    return a as ExternalAnchor;
  });
}

export async function verifyAll(app: App, tenant: string, anchors: ExternalAnchor[] | null): Promise<ChainReport[]> {
  const ids = tenant === 'all'
    ? (await app.db.withTenantTx(PLATFORM_TENANT_ID, (tx) => listTenants(tx, 100_000, null), { platformScope: true })).map((t) => t.id)
    : [tenant];
  const reports: ChainReport[] = [];
  for (const id of ids) {
    reports.push(await app.db.withTenantTx(id, async (tx) => {
      const chain = await verifyChain(tx, id);
      const external = anchors === null ? null : await verifyAgainstExternalAnchors(tx, id, anchors);
      return {
        tenant_id: id, ...chain,
        ok: chain.ok && (external === null || external.ok),
        external_anchor_ok: external?.ok ?? null,
        external_anchor_mismatch_seq: external?.mismatched_seq ?? null,
      };
    }));
  }
  return reports;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  const tenant = value('--tenant');
  if (tenant === undefined || (tenant !== 'all' && !isUuid(tenant))) {
    console.error('usage: audit:verify -- --tenant <tenant-id|all> [--anchors <file.jsonl>]');
    process.exit(2);
  }
  const anchorsFile = value('--anchors');
  const anchors = anchorsFile === undefined ? null : parseAnchors(readFileSync(anchorsFile, 'utf8'));
  const app = await createApp(loadConfig(process.env));
  let failed = false;
  try {
    for (const r of await verifyAll(app, tenant, anchors)) {
      console.log(JSON.stringify(r));
      if (!r.ok) failed = true;
    }
  } finally {
    await app.close();
  }
  process.exit(failed ? 1 : 0);
}
