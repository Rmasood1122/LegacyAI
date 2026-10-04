// What the knowledge side holds from a person - job roles, verified items, completed interviews - for the
// retirement radar of the identity module. That module reads no knowledge table: it asks through this function
// (plugged in by app.ts), and every number here is narrowed by the ASKING card's own rights:
//   job roles            gap:read        (what getRolePeople shows the card)
//   verified items       knowledge:read  (department, sensitivity, own - as the item list)
//   completed interviews interview:read
// A card without the right gets null for that field - not zero, which would read as "nothing captured".
// Labels and counts only, within the API login's column grants (docs/phase2/02-data-model.md).
import type { Authorizer, PersonHoldings, PersonHoldingsLoader } from '../../identity-access/index.ts';

const ROLE_PERSON = { type: 'person', tenantExpr: 'p.tenant_id', departmentExpr: 'p.department_id' };
const ITEM = {
  type: 'knowledge_item', tenantExpr: 'k.tenant_id', departmentExpr: 'k.department_id', sensitivityExpr: 'k.sensitivity',
  ownerPersonExpr: 'k.owner_person_id', verifiedExpr: `k.status IN ('verified', 'corrected')`,
};
const INTERVIEW = { type: 'interview', tenantExpr: 'i.tenant_id', ownerPersonExpr: 'i.expert_person_id' };
/** The policy module's way of saying "this card may see nothing of this kind". */
const NOTHING = 'FALSE';

export function personHoldingsLoader(authorizer: Authorizer): PersonHoldingsLoader {
  return async (tx, subject, personIds, ctx) => {
    const ids = [...new Set(personIds)];
    const out = new Map<string, PersonHoldings>(ids.map((id) => [id, { job_roles: null, verified_items: null, interviews_completed: null }]));
    if (ids.length === 0) return out;
    const entry = (id: string): PersonHoldings => out.get(id) as PersonHoldings;

    const roles = await authorizer.filter(tx, subject, 'gap:read', ROLE_PERSON, ctx, 2);
    if (roles.sql !== NOTHING) {
      for (const id of ids) entry(id).job_roles = [];
      const { rows } = await tx.query<{ person_id: string; job_role: string }>(
        // eslint-disable-next-line no-restricted-syntax -- filter.sql is built by the policy module from code constants; all values are bound
        `SELECT j.person_id, j.job_role
           FROM person_job_roles j JOIN people p ON p.tenant_id = j.tenant_id AND p.id = j.person_id
          WHERE j.person_id = ANY($1::uuid[]) AND j.relation = 'holder' AND ${roles.sql} ORDER BY j.job_role`,
        [ids, ...roles.params]);
      for (const r of rows) entry(r.person_id).job_roles?.push(r.job_role);
    }

    const items = await authorizer.filter(tx, subject, 'knowledge:read', ITEM, ctx, 2);
    if (items.sql !== NOTHING) {
      for (const id of ids) entry(id).verified_items = 0;
      const { rows } = await tx.query<{ person_id: string; n: number }>(
        // eslint-disable-next-line no-restricted-syntax -- filter.sql is built by the policy module from code constants; all values are bound
        `SELECT k.owner_person_id AS person_id, count(*)::int AS n FROM knowledge_items k
          WHERE k.owner_person_id = ANY($1::uuid[]) AND k.status IN ('verified', 'corrected') AND ${items.sql}
          GROUP BY k.owner_person_id`,
        [ids, ...items.params]);
      for (const r of rows) entry(r.person_id).verified_items = r.n;
    }

    const interviews = await authorizer.filter(tx, subject, 'interview:read', INTERVIEW, ctx, 2);
    if (interviews.sql !== NOTHING) {
      for (const id of ids) entry(id).interviews_completed = 0;
      const { rows } = await tx.query<{ person_id: string; n: number }>(
        // eslint-disable-next-line no-restricted-syntax -- filter.sql is built by the policy module from code constants; all values are bound
        `SELECT i.expert_person_id AS person_id, count(*)::int AS n FROM interviews i
          WHERE i.expert_person_id = ANY($1::uuid[]) AND i.status = 'completed' AND ${interviews.sql}
          GROUP BY i.expert_person_id`,
        [ids, ...interviews.params]);
      for (const r of rows) entry(r.person_id).interviews_completed = r.n;
    }
    return out;
  };
}
