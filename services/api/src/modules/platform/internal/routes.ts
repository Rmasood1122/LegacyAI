// Platform endpoints: health, readiness, own tenant + settings, audit log, data export.
import { problems } from '../../../shared/errors.ts';
import type { ResourceRef, CardSubject } from '../../../shared/policy-types.ts';
import { queryAudit, toApiAuditEvent, verifyChain, writeAudit } from './audit.ts';
import type { Config } from './config.ts';
import { EXPECTED_SCHEMA_VERSION, type Database } from './db.ts';
import type { RouteDef } from './http.ts';
import { decodeCursor, encodeCursor } from './pagination.ts';
import {
  getExportJob, getSettings, getTenant, runExport, toApiExportJob, toApiTenant, type ExportRegistry,
} from './tenants.ts';

const tenantResource = (type: string) => async ({ subject }: { subject: CardSubject }): Promise<ResourceRef> => ({
  type, id: subject.tenant_id, tenant_id: subject.tenant_id,
});
const collection = (type: string) => async ({ subject }: { subject: CardSubject }): Promise<ResourceRef> => ({
  type, tenant_id: subject.tenant_id, collection: true,
});

/** One API call checks at most this many rows, so a long chain cannot tie up a request. Continue with from_seq. */
const VERIFY_ROWS_PER_REQUEST = 20_000;

export function platformRoutes(deps: { config: Config; db: Database; exports: ExportRegistry }): RouteDef[] {
  const { config, db } = deps;
  return [
    {
      operationId: 'getHealth',
      kind: 'public',
      policy: { public: true, reason: 'Liveness probe for the hosting platform; returns no data and never touches the database.' },
      handler: async () => ({ body: { status: 'ok', version: config.version } }),
    },
    {
      operationId: 'getReady',
      kind: 'public',
      policy: { public: true, reason: 'Readiness probe; reports only three booleans.' },
      handler: async () => {
        const database = await db.ping();
        const migrations = database && (await db.migrationsCurrent(EXPECTED_SCHEMA_VERSION));
        if (!(database && migrations)) throw problems.notReady();
        return { body: { status: 'ready', checks: { database, migrations, config: true } } };
      },
    },
    {
      operationId: 'getCurrentTenant',
      kind: 'session',
      policy: { resource: tenantResource('tenant') },
      handler: async ({ tx, subject }) => {
        const tenant = await getTenant(tx, subject.tenant_id);
        if (!tenant) throw problems.notFound();
        return { body: toApiTenant(tenant) };
      },
    },
    {
      operationId: 'getTenantSettings',
      kind: 'session',
      policy: { resource: tenantResource('tenant_settings') },
      handler: async ({ tx, subject }) => ({ body: await getSettings(tx, subject.tenant_id) }),
    },
    {
      operationId: 'listAuditEvents',
      kind: 'session',
      listFilter: { unfiltered: 'the audit log is one chain per company; it is read whole or not at all' },
      policy: { resource: collection('audit') },
      handler: async ({ tx, subject, query }) => {
        const before = decodeCursor(query.cursor);
        if (before !== null && !/^[0-9]{1,15}$/.test(before)) throw problems.badRequest([{ path: 'query/cursor', message: 'invalid cursor' }]);
        const rows = await queryAudit(tx, subject.tenant_id, query, query.limit + 1, before === null ? null : Number(before));
        const page = rows.slice(0, query.limit);
        const last = page[page.length - 1];
        return {
          body: {
            items: page.map(toApiAuditEvent),
            next_cursor: rows.length > query.limit && last ? encodeCursor(last.seq) : null,
          },
        };
      },
    },
    {
      operationId: 'verifyAuditChain',
      kind: 'session',
      listFilter: { unfiltered: 'the audit chain is verified as a whole' },
      policy: { resource: collection('audit') },
      handler: async ({ tx, subject, body }) => ({
        body: await verifyChain(tx, subject.tenant_id, body.from_seq ?? 1, body.to_seq, VERIFY_ROWS_PER_REQUEST),
      }),
    },
    {
      operationId: 'createExport',
      kind: 'session',
      policy: { resource: collection('export') },
      handler: async ({ tx, subject, ctx }) => {
        const job = await runExport(tx, deps.exports, subject.tenant_id, subject.card_id, config.exportDir);
        await writeAudit(tx, {
          tenantId: subject.tenant_id, actorCardId: subject.card_id, actorKind: 'card', action: 'export:create',
          resourceType: 'export', resourceId: job.id, decision: 'event', reasonCode: 'EXPORT_CREATED',
          requestId: ctx.requestId, ip: ctx.ip, details: { export_id: job.id },
        });
        return { status: 202, body: toApiExportJob(job) };
      },
    },
    {
      operationId: 'getExport',
      kind: 'session',
      policy: {
        resource: async ({ tx, subject, params }) => {
          const job = await getExportJob(tx, params.export_id);
          return job ? { type: 'export', id: job.id, tenant_id: subject.tenant_id } : null;
        },
      },
      handler: async ({ tx, params }) => {
        const job = await getExportJob(tx, params.export_id);
        if (!job) throw problems.notFound();
        return { body: toApiExportJob(job) };
      },
    },
  ];
}
