// The two operations that APPROVE what somebody wrote can only be registered through approvalRoute(), whose resource
// must name the writers. A plain gatewayRoute() for them is refused when the routes are built (decision D28).
import { describe, expect, it } from 'vitest';
import { APPROVAL_OPERATIONS, approvalRoute, gatewayRoute, type GatewayDeps } from '../../src/modules/knowledge-gateway/internal/common.ts';
import type { RouteDef } from '../../src/modules/platform/index.ts';
import type { ApprovalRef } from '../../src/shared/policy-types.ts';

const deps = {} as GatewayDeps;
const plan = async () => ({ result: { status: 200, body: {} } });
const TENANT = '01a10174-0000-7000-8000-0000000000aa';
const args = { tx: {} as never, subject: {} as never, params: {}, body: {}, query: {}, ctx: {} as never };

describe('approval routes', () => {
  it('the list holds exactly the two approve operations', () => {
    expect([...APPROVAL_OPERATIONS].sort()).toEqual(['approveQuizQuestion', 'approveScenario']);
  });

  it('gatewayRoute() refuses to register an approve operation', () => {
    for (const op of APPROVAL_OPERATIONS) expect(() => gatewayRoute(deps, op, async () => null, plan)).toThrow(/approvalRoute/);
  });

  it('approvalRoute() refuses any other operation', () => {
    expect(() => approvalRoute(deps, 'retireScenario', async () => null, plan)).toThrow(/APPROVAL_OPERATIONS/);
  });

  it('a resource without its writers never reaches the policy, even if the type is bypassed', async () => {
    const good: ApprovalRef = { type: 'scenario', id: TENANT, tenant_id: TENANT, sensitivity: 0, approval: true, not_by: { person_ids: [], card_ids: [] } };
    const ok = approvalRoute(deps, 'approveScenario', async () => good, plan);
    const bad = approvalRoute(deps, 'approveScenario', async () => ({ type: 'scenario', id: TENANT, tenant_id: TENANT, sensitivity: 0 }) as never, plan);
    if (ok.kind !== 'gateway' || bad.kind !== 'gateway') throw new Error('expected gateway routes');
    const load = (r: RouteDef) => (r.policy as { resource: (a: typeof args) => Promise<unknown> }).resource(args);
    await expect(load(ok)).resolves.toMatchObject({ approval: true });
    await expect(load(bad)).rejects.toThrow(/must name who may not approve/);
    await expect(load(approvalRoute(deps, 'approveScenario', async () => null, plan))).resolves.toBeNull();   // "not found" stays "not found"
  });
});
