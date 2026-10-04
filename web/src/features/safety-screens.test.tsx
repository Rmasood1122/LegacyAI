// Phase 4 step 2 on the screens: the anomaly-lock rules and the list of locks, the leaving date and the
// retirement radar, and department templates - with a stand-in API. Synthetic data only.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { AnomalySettings, Card, TenantSettings, TopicTemplate } from '../api/generated.ts';
import { FakeApi, makeSession, permissionsFor, problem, renderScreen, sessionValue } from '../test/harness.tsx';
import { SettingsScreen } from './admin/SettingsScreen.tsx';
import { CardsScreen } from './people/CardsScreen.tsx';
import { PeopleScreen } from './people/PeopleScreen.tsx';
import { RadarScreen } from './people/RadarScreen.tsx';
import { TopicsScreen } from './topics/TopicsScreen.tsx';

const ID = (n: number): string => `01a10174-0000-7000-8000-${String(n).padStart(12, '0')}`;
const T = '2026-10-01T09:00:00.000Z';
const page = <X,>(items: X[]) => ({ items, next_cursor: null });
const as = (...ops: Parameters<typeof permissionsFor>) => sessionValue(makeSession(permissionsFor(...ops)));
const person = (n: number, name: string) => ({ id: ID(n), display_name: name, email: null, department_id: null, status: 'active' as const, created_at: T });
const card = (over: Partial<Card> = {}): Card => ({
  id: ID(30), kind: 'person', card_number: 'LGY-0000-0000-0000-0030', state: 'active', person_id: ID(7), issued_at: T, activated_at: T, expires_at: '2099-01-01T00:00:00.000Z',
  grace_until: '2099-02-01T00:00:00.000Z', renewal_due: '2098-12-01T00:00:00.000Z', renewal_count: 0, locked: false, lock_reason: null, replaced_by_card_id: null,
  replaces_card_id: null, roles: [{ role_key: 'successor', department_id: null, assigned_at: T }], ...over,
});

describe('settings: unusual use of a card', () => {
  const tenantSettings: TenantSettings = {
    card_validity_days: 365, grace_days: 30, renewal_notice_days: 30, sc_lockout_threshold: 5, session_idle_minutes: 30, session_absolute_hours: 12,
    enabled_roles: ['company_owner', 'admin', 'expert', 'successor'], pilot_reviewer_grant: true, allowed_factor_types: ['passkey', 'totp'],
  };
  const tenant = { id: ID(40), name: 'Synthetic Co', slug: 'synthetic-co', status: 'active' as const, plan_code: 'pilot', region: 'eu', created_at: T };
  const rules: AnomalySettings = {
    enabled: true, denials_enabled: true, denials_threshold: 20, denials_window_minutes: 10, second_address_enabled: false, second_address_window_minutes: 15,
    updated_at: null,
  };

  it('shows the rules, says what the second-address rule compares, and sends only what was changed', async () => {
    const user = userEvent.setup();
    let current = rules;
    const api = new FakeApi({
      getCurrentTenant: () => tenant, getTenantSettings: () => tenantSettings, getAnomalySettings: () => current,
      updateAnomalySettings: () => { current = { ...rules, denials_threshold: 8, updated_at: T }; return current; },
    });
    renderScreen(<SettingsScreen />, { api, session: as('getCurrentTenant', 'getTenantSettings', 'updateTenantSettings') });
    expect(await screen.findByText('Unusual use of a card')).toBeTruthy();
    expect(screen.getByText(/The last usable Owner card is never locked by a rule/)).toBeTruthy();
    expect(await screen.findByText(/Compares network addresses, not places/)).toBeTruthy();
    const save = screen.getByRole('button', { name: 'Save these rules' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    const threshold = screen.getByLabelText('Lock a card after this many refused actions …');
    await user.clear(threshold);
    await user.type(threshold, '8');
    await user.click(save);
    await waitFor(() => expect(api.callsTo('updateAnomalySettings')[0]?.body).toEqual({ denials_threshold: 8 }));
    expect(await screen.findByText('The rules were saved')).toBeTruthy();
  });

  it('"off" is a switch per rule; a number field that holds no number blocks saving instead of sending the old value', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({
      getCurrentTenant: () => tenant, getTenantSettings: () => tenantSettings, getAnomalySettings: () => rules,
      updateAnomalySettings: () => ({ ...rules, second_address_enabled: true, updated_at: T }),
    });
    renderScreen(<SettingsScreen />, { api, session: as('getCurrentTenant', 'getTenantSettings', 'updateTenantSettings') });
    const second = await screen.findByLabelText('Rule 2: a sign-in from a second network address') as HTMLInputElement;
    expect(second.checked).toBe(false);
    const minutes = screen.getByLabelText('… while another session of the card was used elsewhere within this many minutes') as HTMLInputElement;
    expect(minutes.disabled).toBe(true);                                             // its rule is off
    expect(minutes.value).toBe('15');                                                // and still a usable number, not 0
    await user.click(second);
    const save = screen.getByRole('button', { name: 'Save these rules' }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    // typed a number, then cleared the field: the draft still holds the old number, so nothing may be saved
    const threshold = screen.getByLabelText('Lock a card after this many refused actions …');
    await user.clear(threshold);
    await user.type(threshold, '30');
    await user.clear(threshold);
    expect(screen.getByText(/Nothing can be saved until you do/)).toBeTruthy();
    expect(save.disabled).toBe(true);
    await user.type(threshold, '20');                                                // back to the saved value
    expect(save.disabled).toBe(false);
    await user.click(save);
    await waitFor(() => expect(api.callsTo('updateAnomalySettings')[0]?.body).toEqual({ second_address_enabled: true }));
  });

  it('a card that may only read the settings sees the rules but cannot change them; the API\'s refusal of a value is shown', async () => {
    const user = userEvent.setup();
    const reader = new FakeApi({ getCurrentTenant: () => tenant, getTenantSettings: () => tenantSettings, getAnomalySettings: () => rules });
    const first = renderScreen(<SettingsScreen />, { api: reader, session: as('getCurrentTenant', 'getTenantSettings') });
    expect(await screen.findByLabelText('… within this many minutes')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save these rules' })).toBeNull();
    first.unmount();

    const api = new FakeApi({
      getCurrentTenant: () => tenant, getTenantSettings: () => tenantSettings, getAnomalySettings: () => rules,
      updateAnomalySettings: () => { throw problem(422, 'denials_threshold must be a whole number from 5 to 500', 'invalid'); },
    });
    renderScreen(<SettingsScreen />, { api, session: as('getCurrentTenant', 'getTenantSettings', 'updateTenantSettings') });
    await user.click(await screen.findByLabelText('Lock cards that are used in an unusual way'));
    await user.click(screen.getByRole('button', { name: 'Save these rules' }));
    expect(await screen.findByText('denials_threshold must be a whole number from 5 to 500')).toBeTruthy();
    expect(api.callsTo('updateAnomalySettings')[0]?.body).toEqual({ enabled: false });
  });
});

describe('cards: locked by an anomaly rule', () => {
  it('the list says why a card is locked and shows the recent times a rule fired, with a way to the card', async () => {
    const api = new FakeApi({
      listCards: () => page([card({ locked: true, lock_reason: 'anomaly' }), card({ id: ID(31), card_number: 'LGY-0000-0000-0000-0031', locked: true, lock_reason: 'sc_attempts' })]),
      listAnomalyEvents: () => page([
        { id: ID(60), card_id: ID(30), card_number: 'LGY-****-****-****-0030', occurred_at: T, outcome: 'locked' as const, rule: 'denials' as const, count: 20 },
        { id: ID(61), card_id: ID(32), card_number: 'LGY-****-****-****-0032', occurred_at: T, outcome: 'not_locked_last_owner' as const, rule: 'second_address' as const, count: 1 },
        { id: ID(62), card_id: ID(33), card_number: 'LGY-****-****-****-0033', occurred_at: T, outcome: 'locked' as const, rule: 'unknown' as const, count: null },
      ]),
    });
    renderScreen(<CardsScreen />, { api, session: as('listCards', 'getCard', 'unlockCard', 'listAnomalyEvents') });
    expect(await screen.findByText('Locked by an anomaly rule')).toBeTruthy();
    expect(screen.getByText('Locked after wrong codes')).toBeTruthy();
    const table = await screen.findByRole('table', { name: 'Anomaly locks' });
    expect(within(table).getByText('Many refused actions in a short time')).toBeTruthy();
    expect(within(table).getByText('Sign-in from a second network address')).toBeTruthy();
    expect(within(table).getByText('Not locked: the last usable Owner card')).toBeTruthy();
    // a rule or a count this screen does not know is said to be unknown, never shown as something it is not
    expect(within(table).getByText('A rule this screen does not know')).toBeTruthy();
    expect(within(table).getByText('not recorded')).toBeTruthy();
    expect(within(table).getAllByText('Card was locked')).toHaveLength(2);
    expect(within(table).getByRole('link', { name: 'LGY-****-****-****-0030' })).toBeTruthy();
    expect(within(table).getAllByRole('link')).toHaveLength(3);
  });

  it('a card that cannot unlock cards is not shown the list of locks', async () => {
    const api = new FakeApi({ listCards: () => page([card()]) });
    renderScreen(<CardsScreen />, { api, session: as('listCards') });
    expect(await screen.findByText('LGY-0000-0000-0000-0030')).toBeTruthy();
    expect(screen.queryByText('Cards locked by an anomaly rule')).toBeNull();
    expect(api.callsTo('listAnomalyEvents')).toEqual([]);
  });
});

describe('people: a planned leaving date', () => {
  const leaving = (date: string | null) => ({ person_id: ID(7), leaving_on: date, months_left: date === null ? null : 8, stage: date === null ? null : 12 as const, updated_at: date === null ? null : T });

  it('is set on the person, and removed only after a second click', async () => {
    const user = userEvent.setup();
    let stored: string | null = null;
    const api = new FakeApi({
      listPeople: () => page([person(7, 'Synthetic Expert')]), listDepartments: () => ({ items: [] }),
      getLeavingDate: () => leaving(stored),
      setLeavingDate: ({ body }) => { stored = (body as { leaving_on: string }).leaving_on; return leaving(stored); },
      clearLeavingDate: () => { stored = null; return undefined; },
    });
    renderScreen(<PeopleScreen />, { api, session: as('listPeople', 'updatePerson', 'listDepartments') });
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(await screen.findByText('Planned leaving date')).toBeTruthy();
    expect(screen.getByText(/Only they and Synthetic Expert can see it/)).toBeTruthy();
    const save = screen.getByRole('button', { name: 'Save the date' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await user.type(screen.getByLabelText('Leaves on'), '2027-06-30');
    await user.click(save);
    await waitFor(() => expect(api.callsTo('setLeavingDate')[0]).toMatchObject({ path: { person_id: ID(7) }, body: { leaving_on: '2027-06-30' } }));
    expect(await screen.findByText(/Leaves on 2027-06-30 — less than a year \(about 8 months\)/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Remove the date…' }));
    expect(api.callsTo('clearLeavingDate')).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Yes, remove Synthetic Expert’s leaving date' }));
    await waitFor(() => expect(api.callsTo('clearLeavingDate')[0]).toMatchObject({ path: { person_id: ID(7) } }));
  });

  it('a card that may read people but not change them is shown no leaving date at all', async () => {
    const api = new FakeApi({ listPeople: () => page([person(7, 'Synthetic Expert')]), listDepartments: () => ({ items: [] }) });
    renderScreen(<PeopleScreen />, { api, session: as('listPeople', 'listDepartments') });
    expect(await screen.findByText('Synthetic Expert')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(api.callsTo('getLeavingDate')).toEqual([]);
  });
});

describe('retirement radar', () => {
  const entry = (n: number, name: string, date: string, months: number, stage: 6 | 12 | 24) => ({
    person_id: ID(n), display_name: name, department_id: null, leaving_on: date, months_left: months, stage, job_roles: n === 7 ? ['Boiler operator'] : [],
    verified_items: n === 7 ? 4 : 0, interviews_completed: n === 7 ? 1 : 0,
  });

  it('lists who leaves soon with what is held from each, and says what the numbers do not show', async () => {
    const api = new FakeApi({
      getRetirementRadar: () => ({
        items: [entry(8, 'Synthetic Learner', '2027-01-15', 3, 6), entry(7, 'Synthetic Expert', '2027-08-01', 9, 12),
          { ...entry(9, 'Synthetic Other', '2028-01-01', 14, 24), job_roles: null, verified_items: null, interviews_completed: null }],
        next_cursor: null,
      }),
    });
    renderScreen(<RadarScreen />, { api, session: as('listPeople', 'updatePerson', 'getGapReport') });
    const table = await screen.findByRole('table', { name: 'People who leave within 24 months' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(4);
    expect(within(rows[1] as HTMLElement).getByText('Synthetic Learner')).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText('Less than six months')).toBeTruthy();
    // what the card may not read is a dash, not a zero
    expect(within(rows[3] as HTMLElement).getAllByTitle('You may not read this')).toHaveLength(3);
    expect(within(rows[3] as HTMLElement).queryByText('0')).toBeNull();
    expect(within(rows[1] as HTMLElement).getByText('none recorded')).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText('Boiler operator')).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText('about 9 months')).toBeTruthy();
    expect(screen.getByText(/does not say which topics are still\s+uncaptured/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open the gap report of a job role' })).toBeTruthy();
  });

  it('an empty radar says so; a cut-short one says so', async () => {
    const empty = renderScreen(<RadarScreen />, { api: new FakeApi({ getRetirementRadar: () => ({ items: [], next_cursor: null }) }), session: as('listPeople') });
    expect(await screen.findByText('Nobody has a leaving date in the next 24 months.')).toBeTruthy();
    empty.unmount();
    renderScreen(<RadarScreen />, {
      api: new FakeApi({ getRetirementRadar: () => ({ items: [entry(7, 'Synthetic Expert', '2027-08-01', 9, 12)], next_cursor: 'bmV4dA' }) }), session: as('listPeople'),
    });
    expect(await screen.findByText('Only the first 1 people are shown. There are more.')).toBeTruthy();
  });
});

describe('topics: department templates', () => {
  const template: TopicTemplate = {
    key: 'maintenance', name: 'Maintenance', summary: 'Keeping equipment running and repairing it.',
    topics: [{ key: 'preventive', name: 'Preventive maintenance routines', description: 'What is serviced.' }, { key: 'spares', name: 'Spare parts and suppliers', description: 'Critical spares.' }],
    roles: [{ job_role: 'Maintenance technician', topics: [{ key: 'preventive', required: true, importance: 3 }, { key: 'spares', required: true, importance: 2 }] }],
  };
  const handlers = { listTopics: () => page([]), listSources: () => page([]) };

  it('shows what a template contains before anything is added, adds it only after a second click, and reports what happened', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({
      ...handlers, listTopicTemplates: () => ({ items: [template] }),
      applyTopicTemplate: () => ({
        template_key: 'maintenance', topics_created: 1, created_topic_ids: [ID(80)], topics_existing: 1, topics_skipped: 0, links_created: 2, links_existing: 0,
      }),
    });
    renderScreen(<TopicsScreen />, { api, session: as('listTopics', 'createTopic') });
    expect(await screen.findByText('Start from a department template')).toBeTruthy();
    expect(screen.getByText(/not checked by an expert in your industry/)).toBeTruthy();
    await screen.findByRole('option', { name: 'Maintenance' });
    await user.selectOptions(screen.getByLabelText('Kind of department'), 'maintenance');
    const preview = screen.getByRole('table', { name: 'Topics of the template Maintenance' });
    expect(within(preview).getByText('Preventive maintenance routines')).toBeTruthy();
    expect(screen.getByText('Job roles: Maintenance technician (2 topics).')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Add the 2 topics and 1 job roles…' }));
    expect(api.callsTo('applyTopicTemplate')).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Yes, add the template “Maintenance”' }));
    await waitFor(() => expect(api.callsTo('applyTopicTemplate')[0]).toMatchObject({ path: { template_key: 'maintenance' } }));
    expect(await screen.findByText('The template was added')).toBeTruthy();
    expect(screen.getByText(/1 new topic; 1 existed already and were kept/)).toBeTruthy();
  });

  it('a card that may read topics but not manage them is not offered templates', async () => {
    const api = new FakeApi(handlers);
    renderScreen(<TopicsScreen />, { api, session: as('listTopics') });
    expect(await screen.findByText('No topics here.')).toBeTruthy();
    expect(screen.queryByText('Start from a department template')).toBeNull();
    expect(api.callsTo('listTopicTemplates')).toEqual([]);
  });
});
