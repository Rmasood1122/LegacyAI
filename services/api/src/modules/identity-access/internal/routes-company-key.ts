// Bring-your-own-key (feature 21; docs/phase4/08-bring-your-own-key.md, decision D35): the platform operator sets or
// clears a company's own encryption key, at the company's request, once the company has given the platform access to
// that key at its key service. Never the company's own Owner: holding an Owner card is not proof of control over a key
// service, and a wrong key would lock the company out of its own secrets.
//
// As everywhere: handlers make no access decisions. tenant:encryption_key is a platform permission.
import { problems } from '../../../shared/errors.ts';
import type { CardSubject, ResourceRef } from '../../../shared/policy-types.ts';
import { getTenant, writeAudit, type Database, type RouteDef, type TenantSealing, type Tx } from '../../platform/index.ts';

const targetTenant = async ({ subject, params }: { subject: CardSubject; params: { tenant_id: string } }): Promise<ResourceRef> => ({
  type: 'tenant', id: params.tenant_id, tenant_id: subject.tenant_id,
});

/** What is shown: the reference and its version, never the wrapped key. */
async function view(tx: Tx, sealing: TenantSealing, tenantId: string): Promise<Record<string, unknown>> {
  const versions = await sealing.versions(tx, tenantId);
  const live = versions.find((v) => v.retired_at === null) ?? null;
  return {
    tenant_id: tenantId,
    key_service: sealing.keyService,
    key_ref: live?.key_ref ?? null,
    version: live?.version ?? null,
    since: live?.created_at.toISOString() ?? null,
    earlier_versions: versions.filter((v) => v.retired_at !== null).length,
  };
}

export function companyKeyRoutes(deps: { db: Database; sealing: TenantSealing }): RouteDef[] {
  const { db, sealing } = deps;
  const customerTenant = async (tx: Tx, tenantId: string): Promise<void> => {
    const tenant = await getTenant(tx, tenantId);
    if (!tenant || tenant.is_platform) throw problems.notFound();
  };
  return [
    {
      operationId: 'getCompanyEncryptionKey',
      kind: 'session',
      policy: { resource: targetTenant },
      handler: async ({ tx, params }) => {
        const tenantId: string = params.tenant_id;
        return { body: await db.withinTenant(tx, tenantId, async () => {
          await customerTenant(tx, tenantId);
          return view(tx, sealing, tenantId);
        }) };
      },
    },
    {
      operationId: 'setCompanyEncryptionKey',
      kind: 'session',
      policy: { resource: targetTenant },
      handler: async ({ tx, subject, params, body, ctx }) => {
        const tenantId: string = params.tenant_id;
        const ref: string | null = body.key_ref;
        const out = await db.withinTenant(tx, tenantId, async () => {
          await customerTenant(tx, tenantId);
          const set = await sealing.setKey(tx, tenantId, ref, ctx.now);
          if (set === 'bad-ref') throw problems.unprocessable('This key service cannot use a key reference of this form');
          if (set === 'unavailable') throw problems.unprocessable("The company's key could not be used: check that the platform was given access to it at the key service");
          // the company's own log records an operator action (no reference: it names the company's key service)
          await writeAudit(tx, {
            tenantId, actorKind: 'operator', action: 'tenant:encryption_key', resourceType: 'tenant', resourceId: tenantId, decision: 'event',
            reasonCode: ref === null ? 'COMPANY_KEY_CLEARED' : 'COMPANY_KEY_SET', requestId: ctx.requestId, ip: ctx.ip,
            ...(set.version === null ? {} : { details: { key_version: set.version } }),
          });
          return view(tx, sealing, tenantId);
        });
        await writeAudit(tx, {
          tenantId: subject.tenant_id, actorCardId: subject.card_id, actorKind: 'card', action: 'tenant:encryption_key', resourceType: 'tenant',
          resourceId: tenantId, decision: 'event', reasonCode: ref === null ? 'COMPANY_KEY_CLEARED' : 'COMPANY_KEY_SET', requestId: ctx.requestId, ip: ctx.ip,
          details: { target_tenant_id: tenantId },
        });
        return { body: out };
      },
    },
  ];
}
