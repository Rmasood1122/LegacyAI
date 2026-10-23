// THE PLAN CATALOGUE (decision D38, 2026-10-23: the prices selected at the founder's request after the comparison in
// docs/phase4/05-billing.md, "Prices"; the founder can change them here).
//
// Rules the code relies on:
//   - a price is a whole number in the SMALLEST unit of the currency (cents), never a fraction;
//   - a price is per seat and per YEAR. A company pays for its term, which is the company card's validity period
//     (decision D29; 90 days by default, at most 366): the price of one seat for a term is the yearly price times the
//     term's days divided by 365, rounded to the nearest cent (half a cent up) - computed once per seat, then times
//     the seats, so that every invoice is "seats x the price per seat shown";
//   - a plan code here must also exist in the database table plan_limits (tenants.plan_code refers to it).
// Taxes are NOT handled anywhere: an amount is what the catalogue says, nothing is added (decision D33).
//
// The Business plan (USD 300 per seat per year, from 25 seats) is not here yet: no route can put a company on another
// plan, so it would be unreachable. It comes with the operator's "change a company's plan" (docs, D38).

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
  /** Per seat, per YEAR, in the smallest unit of `currency`. 0 = nothing to pay. */
  pricePerSeatPerYearMinor: number;
  currency: string;
}

/**
 * False since the prices were selected (D38). While it is true, the screen says the prices are placeholders and a live
 * Stripe key is refused at start-up: real money is never taken at an invented price (D37).
 */
export const CATALOGUE_IS_PLACEHOLDER = false;

/** The year the yearly price is divided by. A 366-day term (the longest a card allows) costs 366/365 of a year. */
export const DAYS_PER_YEAR = 365;

export const PLANS: readonly Plan[] = [
  // the default plan of a new company ('pilot' is its code since Phase 1; the name is what people see)
  { code: 'pilot', name: 'Team', pricePerSeatPerYearMinor: 15_000, currency: 'USD' },
  { code: 'free', name: 'Pilot (free)', pricePerSeatPerYearMinor: 0, currency: 'USD' },
];

export function planOf(code: string): Plan | null {
  return PLANS.find((p) => p.code === code) ?? null;
}

/** The price of ONE seat for a term of `termDays` days. Whole numbers only; refuses anything that is not. Pure. */
export function seatPriceForTerm(plan: Plan, termDays: number): number {
  if (!Number.isInteger(termDays) || termDays < 1 || termDays > 366) throw new Error('seatPriceForTerm: the term must be 1 to 366 whole days');
  if (!Number.isSafeInteger(plan.pricePerSeatPerYearMinor) || plan.pricePerSeatPerYearMinor < 0) throw new Error('seatPriceForTerm: the price must be a whole number');
  const scaled = plan.pricePerSeatPerYearMinor * termDays;
  if (!Number.isSafeInteger(scaled)) throw new Error('seatPriceForTerm: the price is too large');
  // whole-number rounding, half up: no floating-point division decides a cent
  return Math.floor((scaled * 2 + DAYS_PER_YEAR) / (DAYS_PER_YEAR * 2));
}

/** What one term costs: the price of a seat for the term, times seats. Whole numbers only; refuses anything that is not. */
export function amountDue(plan: Plan, seats: number, termDays: number): number {
  if (!Number.isInteger(seats) || seats < 1) throw new Error('amountDue: seats must be a whole number of at least 1');
  const amount = seatPriceForTerm(plan, termDays) * seats;
  if (!Number.isSafeInteger(amount)) throw new Error('amountDue: the amount is too large');
  return amount;
}

/** The price of `seats` seats for one term of `termDays` days, as money. */
export function priceFor(plan: Plan, seats: number, termDays: number): Money {
  return { amountMinor: amountDue(plan, seats, termDays), currency: plan.currency };
}

/** The catalogue is checked once at start-up: a broken entry stops the service instead of producing a wrong invoice. */
export function catalogueProblems(plans: readonly Plan[] = PLANS): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const p of plans) {
    if (!/^[a-z_]{1,40}$/.test(p.code)) problems.push(`plan code "${p.code}" is not a short lower-case word`);
    if (seen.has(p.code)) problems.push(`plan "${p.code}" is listed twice`);
    seen.add(p.code);
    if (!Number.isSafeInteger(p.pricePerSeatPerYearMinor) || p.pricePerSeatPerYearMinor < 0) problems.push(`plan "${p.code}": the price must be a whole number of at least 0`);
    if (!/^[A-Z]{3}$/.test(p.currency)) problems.push(`plan "${p.code}": the currency must be three capital letters`);
  }
  return problems;
}
