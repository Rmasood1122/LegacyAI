// Retirement radar (feature 11): when a person plans to leave, and the nudges that follow from it.
//
// The date is personal data. It lives in its own table (never in the people list), is read through the
// person's own access rule, and goes with the person: it is removed when the person is marked as departed,
// and by the sweep once it lies more than KEEP_PAST_DAYS in the past. The audit trail records THAT it changed
// and which nudge stage was reached - never the date.
//
// ONE definition of time for everything here (the API's answers, the radar's window, the sweep):
//   "today"  = the current calendar day in UTC (a leaving date has no time and no zone);
//   "months" = calendar months, counted with addMonths() below - the same day of the month N months on, or
//              the last day of that month when it has no such day (31 January + 1 month = 28 or 29 February).
import { problems } from '../../../shared/errors.ts';
import { writeAudit, type Notifier, type Tx } from '../../platform/index.ts';

/** Months before the leaving date at which the people who look after knowledge capture are nudged, nearest first. */
export const NUDGE_STAGES = [6, 12, 24] as const;
export type NudgeStage = typeof NUDGE_STAGES[number];
/** The radar shows people who leave in less than this many months. It is the furthest stage. */
export const RADAR_HORIZON_MONTHS = 24;
/** A leaving date further away than this is refused as a typing mistake. */
export const MAX_YEARS_AHEAD = 50;
/** A date that has passed is kept this long (the person may not have been marked as departed yet), then removed. */
export const KEEP_PAST_DAYS = 30;

/** `now` as a calendar date in UTC. */
export const today = (now: Date): string => now.toISOString().slice(0, 10);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const daysIn = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();   // month 1-12
const pad = (n: number, width: number): string => String(n).padStart(width, '0');

/** Is this text a real calendar day (not 2026-02-30)? Pure. */
export function isRealDate(text: string): boolean {
  if (!DATE.test(text)) return false;
  const [y, m, d] = [Number(text.slice(0, 4)), Number(text.slice(5, 7)), Number(text.slice(8, 10))];
  return m >= 1 && m <= 12 && d >= 1 && d <= daysIn(y, m);
}

/** The calendar day `months` months after `date` (see the top of this file for month ends). Pure. */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = [Number(date.slice(0, 4)), Number(date.slice(5, 7)), Number(date.slice(8, 10))];
  const index = y * 12 + (m - 1) + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(Math.min(d, daysIn(year, month)), 2)}`;
}

/** The day `days` days before `date`. Pure. */
export function minusDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Whole calendar months from today until the date: the largest N with today + N months <= the date.
 * 0 for a date less than a month away, and for one that has passed. Pure.
 */
export function monthsLeft(leavingOn: string, now: Date): number {
  const from = today(now);
  if (leavingOn <= from) return 0;
  let n = (Number(leavingOn.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + (Number(leavingOn.slice(5, 7)) - Number(from.slice(5, 7)));
  while (n > 0 && addMonths(from, n) > leavingOn) n -= 1;
  return n;
}

/**
 * The stage a date is in now: 6 = less than 6 months away, 12 = less than 12, 24 = less than 24;
 * null = 24 months away or more, or already passed. "Exactly 6 months away" is stage 12. Pure.
 */
export function stageOf(leavingOn: string, now: Date): NudgeStage | null {
  const from = today(now);
  if (leavingOn < from) return null;
  for (const stage of NUDGE_STAGES) if (leavingOn < addMonths(from, stage)) return stage;
  return null;
}

/** The first day that is NOT on the radar any more: today + RADAR_HORIZON_MONTHS. The radar's query and stageOf() agree by construction. */
export const radarEnd = (now: Date): string => addMonths(today(now), RADAR_HORIZON_MONTHS);

/** Refuses a leaving date that is not a real day, lies in the past, or is absurdly far ahead. Pure. */
export function validateLeavingDate(leavingOn: string, now: Date): void {
  if (!isRealDate(leavingOn)) throw problems.unprocessable('leaving_on is not a real calendar date');
  if (leavingOn < today(now) || leavingOn > addMonths(today(now), MAX_YEARS_AHEAD * 12)) {
    throw problems.unprocessable(`leaving_on must be between today (UTC) and ${MAX_YEARS_AHEAD} years from now`);
  }
}

export async function getLeavingDate(tx: Tx, tenantId: string, personId: string): Promise<{ leaving_on: string; updated_at: string } | null> {
  const { rows } = await tx.query<{ leaving_on: string; updated_at: Date }>(
    'SELECT leaving_on::text AS leaving_on, updated_at FROM person_leaving WHERE tenant_id = $1 AND person_id = $2', [tenantId, personId]);
  return rows[0] ? { leaving_on: rows[0].leaving_on, updated_at: rows[0].updated_at.toISOString() } : null;
}

export async function setLeavingDate(tx: Tx, tenantId: string, personId: string, leavingOn: string, actorCardId: string, now: Date): Promise<void> {
  await tx.query(
    `INSERT INTO person_leaving (tenant_id, person_id, leaving_on, updated_at, updated_by_card_id) VALUES ($1, $2, $3::date, $4, $5)
     ON CONFLICT (tenant_id, person_id) DO UPDATE SET leaving_on = $3::date, updated_at = $4, updated_by_card_id = $5`,
    [tenantId, personId, leavingOn, now, actorCardId]);
  // A changed date starts its nudges again: stages that no longer apply must not linger, new ones are due from the new date.
  await tx.query('DELETE FROM retirement_nudges WHERE tenant_id = $1 AND person_id = $2', [tenantId, personId]);
}

export async function clearLeavingDate(tx: Tx, tenantId: string, personId: string): Promise<boolean> {
  // nudges go with the date (ON DELETE CASCADE)
  return (await tx.query('DELETE FROM person_leaving WHERE tenant_id = $1 AND person_id = $2', [tenantId, personId])).rowCount > 0;
}

/**
 * Creates the nudges that are due and not yet recorded - for one company, or for ONE person of it when `personId`
 * is given (setting a date must not run the whole company's sweep inside a request). Each (person, stage) is
 * created once: running this again changes nothing. A date that has passed loses its nudges; one that passed more
 * than KEEP_PAST_DAYS ago is removed. Returns how many nudges were created.
 */
export async function sweepRetirementNudges(
  tx: Tx, tenantId: string, now: Date, notifier: Notifier, requestId: string, personId: string | null = null,
): Promise<number> {
  const from = today(now);
  await tx.query(
    `DELETE FROM person_leaving WHERE tenant_id = $1 AND leaving_on < $2::date AND ($3::uuid IS NULL OR person_id = $3::uuid)`,
    [tenantId, minusDays(from, KEEP_PAST_DAYS), personId]);
  await tx.query(
    `DELETE FROM retirement_nudges n USING person_leaving l
      WHERE n.tenant_id = $1 AND l.tenant_id = n.tenant_id AND l.person_id = n.person_id AND l.leaving_on < $2::date
        AND ($3::uuid IS NULL OR n.person_id = $3::uuid)`,
    [tenantId, from, personId]);
  const { rows } = await tx.query<{ person_id: string; leaving_on: string }>(
    `SELECT l.person_id, l.leaving_on::text AS leaving_on
       FROM person_leaving l JOIN people p ON p.tenant_id = l.tenant_id AND p.id = l.person_id
      WHERE l.tenant_id = $1 AND p.status = 'active' AND l.leaving_on >= $2::date AND l.leaving_on < $3::date
        AND ($4::uuid IS NULL OR l.person_id = $4::uuid)
      ORDER BY l.leaving_on LIMIT 5000`,
    [tenantId, from, radarEnd(now), personId]);
  let created = 0;
  for (const row of rows) {
    const stage = stageOf(row.leaving_on, now);
    if (stage === null) continue;
    // Only the stage the date is in NOW is recorded: a date set three months ahead gives one nudge, not three.
    const inserted = await tx.query(
      'INSERT INTO retirement_nudges (tenant_id, person_id, stage, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
      [tenantId, row.person_id, stage, now]);
    if (inserted.rowCount === 0) continue;
    created += 1;
    await writeAudit(tx, {
      tenantId, actorKind: 'system', action: 'person:retirement_nudge', resourceType: 'person', resourceId: row.person_id,
      decision: 'event', reasonCode: 'RETIREMENT_NUDGE', requestId, ip: '', details: { stage },
    });
    await notifier.notify({ type: 'retirement_nudge', tenantId });
  }
  return created;
}
