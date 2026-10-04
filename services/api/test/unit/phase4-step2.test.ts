// Pure parts of Phase 4 step 2: which refusals count toward the anomaly lock, the lock decisions, the stages of a
// leaving date, and the built-in department templates.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  addMonths, ANOMALY_DEFAULTS, COUNTED_REASONS, countsTowardAnomaly, decodeRadarCursor, encodeRadarCursor, isRealDate, monthsLeft, NUDGE_STAGES,
  RADAR_HORIZON_MONTHS, shouldLockForDenials, shouldLockForSecondAddress, shownRule, stageOf, UNCOUNTED_REASONS, validateAnomalyPatch, validateLeavingDate,
} from '../../src/modules/identity-access/index.ts';
import { DEPARTMENT_TEMPLATES, findTemplate, templateProblems } from '../../src/modules/knowledge-gateway/internal/templates.ts';

const NOW = new Date('2026-10-04T10:00:00Z');
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

/** Every refusal reason that exists anywhere in the code: read from the source files, so a new one cannot be missed. */
function everyDenyCode(exceptFile?: string): string[] {
  const found = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && entry.name !== exceptFile) for (const m of readFileSync(full, 'utf8').matchAll(/\bDENY_[A-Z_]+\b/g)) found.add(m[0]);
    }
  };
  walk(SRC);
  return [...found].sort();
}

describe('anomaly lock: which refusals count', () => {
  it('every refusal reason in the code is classified - counted or not - and none is both', () => {
    const all = everyDenyCode();
    expect(all.length).toBeGreaterThanOrEqual(25);
    const unclassified = all.filter((c) => !COUNTED_REASONS.has(c) && !UNCOUNTED_REASONS.has(c));
    expect(unclassified, 'a new refusal reason must be listed in anomaly.ts as counted or not counted').toEqual([]);
    expect([...COUNTED_REASONS].filter((c) => UNCOUNTED_REASONS.has(c))).toEqual([]);
    // and nothing is listed that does not exist (a typo would silently never match). The file that holds the two
    // lists is left out of this scan: otherwise every listed name would "exist" simply by being listed.
    const elsewhere = everyDenyCode('anomaly.ts');
    expect([...COUNTED_REASONS, ...UNCOUNTED_REASONS].filter((c) => !elsewhere.includes(c))).toEqual([]);
  });

  it('refusals of ordinary use never count: hours, network, limit, read-only, grace, a lapsed company, not found', () => {
    for (const reason of [
      'DENY_CARD_HOURS', 'DENY_CARD_NETWORK', 'DENY_CARD_LIMIT', 'DENY_CARD_READ_ONLY', 'DENY_GRACE_READ_ONLY', 'DENY_CARD_EXPIRED',
      'DENY_TENANT_GRACE_READ_ONLY', 'DENY_TENANT_EXPIRED', 'DENY_TENANT_INACTIVE', 'DENY_RESOURCE_NOT_FOUND', 'DENY_PLAN_LIMIT',
    ]) expect(countsTowardAnomaly(reason), reason).toBe(false);
    expect(countsTowardAnomaly('DENY_SOMETHING_NEW')).toBe(false);                // unknown = not counted
    // verifying one's own work: the screens offer the button and expect the refusal
    expect(countsTowardAnomaly('DENY_SELF_REVIEW')).toBe(false);
    // a request a page of another address made the browser send is refused before the policy; that refusal is not counted
    expect(countsTowardAnomaly('DENY_FETCH_SITE')).toBe(false);
  });

  it('probing counts, by its reason alone (no request header can switch the counting off)', () => {
    for (const reason of ['DENY_DEFAULT', 'DENY_SCOPE', 'DENY_SENSITIVITY', 'DENY_RANK', 'DENY_PLATFORM_ONLY', 'DENY_SELF_ACTION',
      'DENY_LAST_OWNER', 'DENY_COMPANY_CARD']) {
      expect(countsTowardAnomaly(reason), reason).toBe(true);
    }
    expect(countsTowardAnomaly.length).toBe(1);                                   // the reason is the only input
  });

  it('the lock decisions are plain functions of a count and the settings', () => {
    const on = { ...ANOMALY_DEFAULTS, enabled: true };
    expect(shouldLockForDenials(19, on)).toBe(false);
    expect(shouldLockForDenials(20, on)).toBe(true);
    expect(shouldLockForDenials(500, { ...on, denials_enabled: false })).toBe(false);
    expect(shouldLockForDenials(500, { ...on, enabled: false })).toBe(false);
    expect(shouldLockForSecondAddress(1, on)).toBe(false);                        // off by default
    expect(shouldLockForSecondAddress(1, { ...on, second_address_enabled: true })).toBe(true);
    expect(shouldLockForSecondAddress(0, { ...on, second_address_enabled: true })).toBe(false);
    expect(shouldLockForSecondAddress(3, { ...on, second_address_enabled: true, enabled: false })).toBe(false);
  });

  it('settings: ranges are enforced, "off" is a switch and never a number; a stored rule this code does not know is shown as unknown', () => {
    expect(() => validateAnomalyPatch({ denials_threshold: 5, denials_window_minutes: 60, second_address_window_minutes: 1 })).not.toThrow();
    for (const bad of [{ denials_threshold: 4 }, { denials_threshold: 501 }, { denials_window_minutes: 0 }, { second_address_window_minutes: 0 },
      { second_address_window_minutes: 121 }, { denials_threshold: 5.5 }, { enabled: 'yes' as unknown as boolean }]) {
      expect(() => validateAnomalyPatch(bad), JSON.stringify(bad)).toThrow();
    }
    expect(shownRule('denials')).toBe('denials');
    expect(shownRule('second_address')).toBe('second_address');
    expect(shownRule('something_newer')).toBe('unknown');
    expect(shownRule(undefined)).toBe('unknown');
  });
});

describe('retirement radar: one definition of months and stages', () => {
  it.each([
    ['2026-10-03', null, 0],      // yesterday: passed
    ['2026-10-04', 6, 0],         // today
    ['2027-03-01', 6, 4],
    ['2027-04-03', 6, 5],         // one day short of six months
    ['2027-04-04', 12, 6],        // exactly six months away is stage 12
    ['2027-04-10', 12, 6],
    ['2027-09-20', 12, 11],
    ['2027-10-04', 24, 12],       // exactly twelve months
    ['2027-10-20', 24, 12],
    ['2028-09-01', 24, 22],
    ['2028-10-03', 24, 23],       // the last day on the radar
    ['2028-10-04', null, 24],     // exactly 24 months: not on the radar
    ['2040-01-01', null, 158],
  ] as const)('%s -> stage %s, %s whole months left', (date, stage, months) => {
    expect(stageOf(date, NOW)).toBe(stage);
    expect(monthsLeft(date, NOW)).toBe(months);
  });

  it('the window of the radar and the stages agree by construction: on the radar <=> the date has a stage', () => {
    const end = addMonths('2026-10-04', RADAR_HORIZON_MONTHS);
    expect(end).toBe('2028-10-04');
    for (const date of ['2026-10-04', '2027-04-04', '2028-10-03', '2028-10-04', '2029-01-01']) {
      expect(date < end, date).toBe(stageOf(date, NOW) !== null);
    }
    expect([...NUDGE_STAGES]).toEqual([6, 12, 24]);
    expect(Math.max(...NUDGE_STAGES)).toBe(RADAR_HORIZON_MONTHS);
  });

  it('months are calendar months; a month that has no such day ends on its last day', () => {
    expect(addMonths('2027-01-31', 1)).toBe('2027-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');                        // leap year
    expect(addMonths('2026-12-15', 2)).toBe('2027-02-15');
    expect(addMonths('2026-10-04', 600)).toBe('2076-10-04');
    expect(monthsLeft('2027-02-28', new Date('2027-01-31T00:00:00Z'))).toBe(1);
    expect(monthsLeft('2027-02-27', new Date('2027-01-31T00:00:00Z'))).toBe(0);
  });

  it('a leaving date must be a real day, not in the past (UTC) and at most 50 years ahead', () => {
    expect(isRealDate('2031-02-28')).toBe(true);
    for (const bad of ['2031-02-30', '2031-13-01', '2031-00-10', '31-02-01', 'soon', '2031-2-3', '']) expect(isRealDate(bad), bad).toBe(false);
    expect(() => validateLeavingDate('2026-10-04', NOW)).not.toThrow();           // today is allowed
    expect(() => validateLeavingDate('2076-10-04', NOW)).not.toThrow();           // exactly 50 years
    for (const bad of ['2026-10-03', '2076-10-05', '2031-02-30', 'soon']) expect(() => validateLeavingDate(bad, NOW), bad).toThrow();
    // "today" is the UTC day: late evening in UTC is still that day
    expect(() => validateLeavingDate('2026-10-04', new Date('2026-10-04T23:59:59Z'))).not.toThrow();
    expect(() => validateLeavingDate('2026-10-04', new Date('2026-10-05T00:00:01Z'))).toThrow();
  });

  it('the cursor of the radar carries a date and a person, and anything else is refused', () => {
    const id = '01a10174-0000-7000-8000-0000000000b1';
    expect(decodeRadarCursor(encodeRadarCursor('2027-04-04', id))).toEqual({ leaving_on: '2027-04-04', person_id: id });
    expect(decodeRadarCursor(undefined)).toBeNull();
    for (const bad of ['bm90LWEtY3Vyc29y', Buffer.from(`2027-02-30|${id}`).toString('base64url'), Buffer.from('2027-04-04|x').toString('base64url'),
      Buffer.from(`2027-04-04|${id}|more`).toString('base64url'), 'A'.repeat(300), 7]) {
      expect(() => decodeRadarCursor(bad), String(bad)).toThrow();
    }
  });
});

describe('department templates: the built-in library is consistent', () => {
  it('has 6 to 8 templates; keys, topic keys and topic names are unique; every job role refers to topics of its own template', () => {
    expect(DEPARTMENT_TEMPLATES.length).toBeGreaterThanOrEqual(6);
    expect(DEPARTMENT_TEMPLATES.length).toBeLessThanOrEqual(8);
    expect(templateProblems()).toEqual([]);
  });

  it('topic names do not collide between templates (applying two must not silently merge different topics)', () => {
    const names = DEPARTMENT_TEMPLATES.flatMap((t) => t.topics.map((x) => x.name.toLowerCase()));
    expect(new Set(names).size).toBe(names.length);
  });

  it('names and descriptions fit the database limits; template keys fit the address pattern', () => {
    for (const t of DEPARTMENT_TEMPLATES) {
      expect(t.key).toMatch(/^[a-z][a-z0-9-]{1,39}$/);
      for (const topic of t.topics) {
        expect(topic.name.length, topic.name).toBeLessThanOrEqual(120);
        expect(topic.description.length, topic.name).toBeLessThanOrEqual(500);
      }
      for (const r of t.roles) {
        expect(r.job_role).toBe(r.job_role.trim());
        expect(r.job_role.length).toBeLessThanOrEqual(120);
      }
    }
  });

  it('the checker really reports a broken template', () => {
    const broken = [{ key: 'x', name: 'X', summary: '', topics: [{ key: 'a', name: 'A', description: '' }, { key: 'a', name: 'a', description: '' }],
      roles: [{ job_role: 'R', topics: [{ key: 'missing', required: true, importance: 2 as const }] }] }];
    expect(templateProblems(broken)).toEqual(['x: duplicate topic key', 'x: duplicate topic name', 'x/R: unknown topic missing']);
    expect(findTemplate('maintenance')?.name).toBe('Maintenance');
    expect(findTemplate('nope')).toBeUndefined();
  });

  it('the library is checked when it is loaded, not only here', () => {
    const source = readFileSync(path.join(SRC, 'modules', 'knowledge-gateway', 'internal', 'templates.ts'), 'utf8');
    expect(source).toMatch(/const loadProblems = templateProblems\(\);\s+if \(loadProblems\.length > 0\) throw/);
  });
});
