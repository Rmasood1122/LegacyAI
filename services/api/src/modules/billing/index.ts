// PUBLIC SURFACE of the billing module (backend Part 4).
//
// PHASE 1: INTERFACE STUB ONLY. No billing logic, no payments, no metering.
// The identity module calls checkLimit() from the policy decision point so that the
// wiring exists and is tested; the stub always answers "within limits".
//
// TODO (Phase 4 - nothing below is built):
//   [ ] Choose a hosted payment processor (depends on the country of business registration).
//       Card data must never touch our servers.
//   [ ] Plans and prices; fill plan_limits beyond the single "pilot" row.
//   [ ] Real checkLimit(): compare usage against plan_limits (max_person_cards, max_admin_cards).
//   [ ] Usage metering per card / per department.
//   [ ] Invoicing and receipts.
//   [ ] Renewal trigger: on successful payment, call identity-access renew() for the company card.
//   [ ] Dunning: what happens between a failed payment and the 14-day grace window.
//   [ ] Webhook receiver for the processor (signature verification, idempotency).
//   [ ] Tax handling.

export interface PlanLimitQuery {
  tenantId: string;
  planCode: string;
  action: string;
}

export interface PlanLimitAnswer {
  allowed: boolean;
  reason?: string;
}

export interface BillingPort {
  /** Asked by the policy decision point before any action is allowed. */
  checkLimit(query: PlanLimitQuery): Promise<PlanLimitAnswer>;
}

export class StubBilling implements BillingPort {
  async checkLimit(_query: PlanLimitQuery): Promise<PlanLimitAnswer> {
    return { allowed: true };
  }
}
