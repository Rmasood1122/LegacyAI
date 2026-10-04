// THE PLAN CATALOGUE - PLACEHOLDER VALUES.
//
// Every name, price and currency below was invented so that the renewal logic has something to compute with.
// NONE OF IT IS A BUSINESS DECISION. The founder sets the real plans and prices (docs/phase4/05-billing.md,
// decision D30) before any real payment provider is connected.
//
// Rules the code relies on:
//   - a price is a whole number in the SMALLEST unit of the currency (cents), never a fraction;
//   - a price is per seat and per term; the term is the company's card validity period (decision D29);
//   - a plan code here must also exist in the database table plan_limits (tenants.plan_code refers to it).
// Taxes are NOT handled anywhere: an amount is what the catalogue says, nothing is added (decision D33).

/** Money is always a whole number in the SMALLEST unit of its currency, together with that currency. Never a fraction. */
export interface Money {
  amountMinor: number;
  currency: string;
}

export function sameMoney(a: Money, b: Money): boolean {
  return Number.isSafeInteger(a.amountMinor) && a.amountMinor === b.amountMinor && a.currency === b.currency;
}

export interface Plan {
  code: string;
  name: string;
  /** Per seat, per term, in the smallest unit of `currency`. 0 = nothing to pay. */
  pricePerSeatMinor: number;
  currency: string;
}

export const PLANS: readonly Plan[] = [
  { code: 'free', name: 'Free (placeholder)', pricePerSeatMinor: 0, currency: 'USD' },
  { code: 'pilot', name: 'Pilot (placeholder)', pricePerSeatMinor: 1500, currency: 'USD' },
];

export function planOf(code: string): Plan | null {
  return PLANS.find((p) => p.code === code) ?? null;
}

/** What one term costs: price per seat times seats. Whole numbers only; refuses anything that is not. */
export function amountDue(plan: Plan, seats: number): number {
  if (!Number.isInteger(seats) || seats < 1) throw new Error('amountDue: seats must be a whole number of at least 1');
  if (!Number.isInteger(plan.pricePerSeatMinor) || plan.pricePerSeatMinor < 0) throw new Error('amountDue: the price must be a whole number');
  const amount = plan.pricePerSeatMinor * seats;
  if (!Number.isSafeInteger(amount)) throw new Error('amountDue: the amount is too large');
  return amount;
}

/** The price of `seats` seats for one term, as money. */
export function priceFor(plan: Plan, seats: number): Money {
  return { amountMinor: amountDue(plan, seats), currency: plan.currency };
}

/** The catalogue is checked once at start-up: a broken entry stops the service instead of producing a wrong invoice. */
export function catalogueProblems(plans: readonly Plan[] = PLANS): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const p of plans) {
    if (!/^[a-z_]{1,40}$/.test(p.code)) problems.push(`plan code "${p.code}" is not a short lower-case word`);
    if (seen.has(p.code)) problems.push(`plan "${p.code}" is listed twice`);
    seen.add(p.code);
    if (!Number.isInteger(p.pricePerSeatMinor) || p.pricePerSeatMinor < 0) problems.push(`plan "${p.code}": the price must be a whole number of at least 0`);
    if (!/^[A-Z]{3}$/.test(p.currency)) problems.push(`plan "${p.code}": the currency must be three capital letters`);
  }
  return problems;
}
