// The screens that used to need a detour (typing a job role by heart, a link made in the database, a
// test opened by its reference) now read and write these things through the API.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { KAttemptSummary, KItemDetail, KTopic } from '../api/generated.ts';
import { FakeApi, makeSession, permissionsFor, problem, renderScreen, sessionValue } from '../test/harness.tsx';
import { QuestionsScreen } from './ask/QuestionsScreen.tsx';
import { ConsentScreen } from './consent/ConsentScreen.tsx';
import { KnowledgeItemScreen } from './knowledge/KnowledgeItemScreen.tsx';
import { ReadinessScreen } from './readiness/ReadinessScreen.tsx';
import { GapsScreen } from './topics/GapsScreen.tsx';

const ID = (n: number): string => `01a10174-0000-7000-8000-${String(n).padStart(12, '0')}`;
const T = '2026-10-01T09:00:00.000Z';
const page = <X,>(items: X[], next_cursor: string | null = null) => ({ items, next_cursor });
const as = (...ops: Parameters<typeof permissionsFor>) => sessionValue(makeSession(permissionsFor(...ops)));
const topic = (n: number, name: string): KTopic => ({ id: ID(n), name, description: '', department_id: null, sensitivity: 0, origin: 'admin', status: 'active', created_at: T });

describe('a knowledge item and its topics', () => {
  const item = (topics: KItemDetail['topics']): KItemDetail => ({
    id: ID(30), title: 'Relief valve', status: 'verified', origin: 'manual', ai_extracted: false, department_id: null, sensitivity: 0, owner_person_id: null,
    usage_count: 0, verified_at: T, stale_after: null, updated_at: T, body: 'The relief valve lifts at 6 bar.', self_verified: false, provenance: [],
    versions: [{ version_no: 1, change_kind: 'created', author_person_id: null, created_at: T, erased_at: null, current: true }], topics,
  });
  const at = { at: `/knowledge/${ID(30)}`, route: '/knowledge/:itemId' };

  it('says so when an item has no topic, and a reader gets no way to change that', async () => {
    renderScreen(<KnowledgeItemScreen />, { api: new FakeApi({ getKnowledgeItem: () => item([]) }), session: as('getKnowledgeItem'), ...at });
    expect(await screen.findByText(/Not linked to a topic/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Change the topics' })).toBeNull();
  });

  it('shows the topics and how each link was made; a reviewer replaces them with the ones ticked', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({
      getKnowledgeItem: () => item([{ topic_id: ID(70), name: 'Relief valves', link_source: 'similarity' }]),
      listTopics: () => page([topic(70, 'Relief valves'), topic(73, 'Purging')]),
      setItemTopics: () => ({ id: ID(30), topics: [] }),
    });
    renderScreen(<KnowledgeItemScreen />, { api, session: as('getKnowledgeItem', 'setItemTopics', 'listTopics'), ...at });
    expect(await screen.findByText('Found by similarity')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Change the topics' }));
    expect(((await screen.findByRole('checkbox', { name: 'Relief valves' })) as HTMLInputElement).checked).toBe(true);
    await user.click(screen.getByRole('checkbox', { name: 'Relief valves' }));
    await user.click(screen.getByRole('checkbox', { name: 'Purging' }));
    await user.click(screen.getByRole('button', { name: 'Save the topics' }));
    await waitFor(() => expect(api.callsTo('setItemTopics')[0]).toMatchObject({ path: { item_id: ID(30) }, body: { topic_ids: [ID(73)] } }));
    expect(api.callsTo('listTopics')[0]?.query).toMatchObject({ status: 'active' });
  });

  it('says what saving will add and remove, and keeps a link to a topic that is not in the list of topics in use', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({
      getKnowledgeItem: () => item([{ topic_id: ID(70), name: 'Relief valves', link_source: 'similarity' }, { topic_id: ID(75), name: 'Proposed topic', link_source: 'reviewer' }]),
      listTopics: () => page([topic(70, 'Relief valves'), topic(73, 'Purging')]),
      setItemTopics: () => ({ id: ID(30), topics: [] }),
    });
    renderScreen(<KnowledgeItemScreen />, { api, session: as('getKnowledgeItem', 'setItemTopics', 'listTopics'), ...at });
    await user.click(await screen.findByRole('button', { name: 'Change the topics' }));
    expect(((await screen.findByRole('checkbox', { name: 'Proposed topic' })) as HTMLInputElement).checked).toBe(true);   // linked, though not "in use": it has its row
    expect(screen.getByText('Nothing is changed yet.')).toBeTruthy();
    await user.click(screen.getByRole('checkbox', { name: 'Relief valves' }));
    await user.click(screen.getByRole('checkbox', { name: 'Purging' }));
    expect(screen.getByText(/Saving will add “Purging” and remove “Relief valves”/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save the topics' }));
    await waitFor(() => expect(api.callsTo('setItemTopics')[0]?.body).toEqual({ topic_ids: [ID(73), ID(75)] }));
  });

  it('when the API refuses because the card contributed the item, it says plainly that a second person must do it', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({
      getKnowledgeItem: () => item([]),
      listTopics: () => page([topic(70, 'Relief valves')]),
      setItemTopics: () => { throw problem(403, 'Not allowed', 'forbidden'); },
    });
    renderScreen(<KnowledgeItemScreen />, { api, session: as('getKnowledgeItem', 'setItemTopics', 'listTopics'), ...at });
    await user.click(await screen.findByRole('button', { name: 'Change the topics' }));
    await user.click(await screen.findByRole('checkbox', { name: 'Relief valves' }));
    await user.click(screen.getByRole('button', { name: 'Save the topics' }));
    expect(await screen.findByText('A second person must do this')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save the topics' })).toBeTruthy();     // the form stays; nothing was saved
  });

  it('does not save while the list of topics is cut short', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({ getKnowledgeItem: () => item([]), listTopics: () => page([topic(70, 'Relief valves')], 'more') });
    renderScreen(<KnowledgeItemScreen />, { api, session: as('getKnowledgeItem', 'setItemTopics', 'listTopics'), ...at });
    await user.click(await screen.findByRole('button', { name: 'Change the topics' }));
    await screen.findByRole('checkbox', { name: 'Relief valves' });
    expect((screen.getByRole('button', { name: 'Save the topics' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Show more topics' })).toBeTruthy();
  });
});

describe('job roles', () => {
  const report = { job_role: 'Boiler operator', topics: [] };

  it('offers the job roles that have topics; choosing one shows its report', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({
      listJobRoles: () => page([{ job_role: 'Boiler operator', topic_count: 2 }, { job_role: 'Line lead', topic_count: 1 }]),
      getGapReport: () => report,
    });
    renderScreen(<GapsScreen />, { api, session: as('getGapReport', 'listJobRoles') });
    await user.click(await screen.findByRole('button', { name: 'Boiler operator (2 topics)' }));
    expect(screen.getByRole('button', { name: 'Line lead (1 topic)' })).toBeTruthy();
    await waitFor(() => expect(api.callsTo('getGapReport')[0]?.query).toEqual({ job_role: 'Boiler operator' }));
  });

  it('starts the people form from the people set now, and says how many there are', async () => {
    const user = userEvent.setup();
    const person = (n: number, name: string) => ({ id: ID(n), display_name: name, email: null, department_id: null, status: 'active' as const, created_at: T });
    const api = new FakeApi({
      listJobRoles: () => page([]),
      getGapReport: () => report,
      listPeople: () => page([person(7, 'Synthetic Holder'), person(8, 'Synthetic Follower'), person(9, 'Synthetic Other')]),
      getRolePeople: () => ({ job_role: 'Boiler operator', people: [{ person_id: ID(7), relation: 'holder' }, { person_id: ID(8), relation: 'successor' }] }),
      setRolePeople: () => ({ job_role: 'Boiler operator', people: [] }),
    });
    renderScreen(<GapsScreen />, { api, session: as('getGapReport', 'setRolePeople', 'listPeople', 'getRolePeople') });
    await user.type(screen.getByLabelText('Job role'), 'Boiler operator');
    await user.click(screen.getByRole('button', { name: 'Show' }));
    expect(await screen.findByText(/2 people are set now/)).toBeTruthy();
    expect(((await screen.findByLabelText('Synthetic Holder')) as HTMLSelectElement).value).toBe('holder');
    expect((screen.getByLabelText('Synthetic Follower') as HTMLSelectElement).value).toBe('successor');
    expect((screen.getByLabelText('Synthetic Other') as HTMLSelectElement).value).toBe('');
    // taking one person out and saving keeps the other
    await user.selectOptions(screen.getByLabelText('Synthetic Follower'), '');
    await user.click(screen.getByRole('button', { name: 'Save the people…' }));
    await user.click(screen.getByRole('button', { name: 'Yes, replace the list with this 1 person' }));
    await waitFor(() => expect(api.callsTo('setRolePeople')[0]?.body).toEqual({ people: [{ person_id: ID(7), relation: 'holder' }] }));
  });
});

describe('tests taken', () => {
  const taken = (n: number, status: KAttemptSummary['status']): KAttemptSummary => ({
    id: ID(n), learner_person_id: ID(1), job_role: 'Boiler operator', status, started_at: T, expires_at: '2099-01-01T00:00:00.000Z',
    submitted_at: status === 'in_progress' ? null : T, graded_at: status === 'graded' ? T : null,
  });

  it('lists the tests with a way back into each: continue a running one, read the report of a finished one', async () => {
    const api = new FakeApi({ listReadinessAttempts: () => page([taken(80, 'in_progress'), taken(81, 'graded')]), listJobRoles: () => page([]) });
    renderScreen(<ReadinessScreen />, { api, session: as('startReadinessAttempt', 'listReadinessAttempts', 'getReadinessAttempt', 'getReadinessReport') });
    const rows = within(await screen.findByRole('table', { name: 'Tests taken' })).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByRole('link', { name: 'Continue' }).getAttribute('href')).toBe(`/readiness/attempts/${ID(80)}`);
    expect(within(rows[0] as HTMLElement).queryByRole('link', { name: 'Report' })).toBeNull();
    expect(within(rows[1] as HTMLElement).getByRole('link', { name: 'Report' }).getAttribute('href')).toBe(`/readiness/reports/${ID(81)}`);
  });

  it('offers the job roles to pick from when starting a test, and fetches more tests with the cursor', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({
      listJobRoles: () => page([{ job_role: 'Boiler operator', topic_count: 1 }]),
      listReadinessAttempts: ({ query }) => (query?.cursor === 'next' ? page([taken(81, 'graded')]) : page([taken(80, 'graded')], 'next')),
    });
    renderScreen(<ReadinessScreen />, { api, session: as('startReadinessAttempt', 'listReadinessAttempts', 'listJobRoles') });
    await user.click(await screen.findByRole('button', { name: 'Boiler operator' }));
    expect((screen.getByLabelText('For which job role?') as HTMLInputElement).value).toBe('Boiler operator');
    await user.click(await screen.findByRole('button', { name: 'Show more tests' }));
    await waitFor(() => expect(within(screen.getByRole('table', { name: 'Tests taken' })).getAllByRole('row')).toHaveLength(3));
    expect(api.callsTo('listReadinessAttempts').map((c) => c.query?.cursor)).toEqual([undefined, 'next']);
  });
});

describe('lists that used to stop at one page', () => {
  it('questions: the next page is fetched with the cursor', async () => {
    const user = userEvent.setup();
    const question = (n: number, text: string) => ({ id: ID(n), question: text, expert_person_id: ID(1), status: 'answered', decline_reason: null, answer_item_id: null, created_at: T, answered_at: T, expires_at: T });
    const api = new FakeApi({
      listExpertQuestions: ({ query }) => (query?.cursor === 'older' ? page([question(96, 'An older question?')]) : page([question(95, 'A newer question?')], 'older')),
    });
    renderScreen(<QuestionsScreen />, { api, session: as('listExpertQuestions') });
    expect(await screen.findByText('A newer question?')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Show more questions' }));
    expect(await screen.findByText('An older question?')).toBeTruthy();
  });

  it('my consents: the next page is fetched with the cursor', async () => {
    const user = userEvent.setup();
    const consent = (n: number, scope: string) => ({
      id: ID(n), person_id: ID(1), scope, purpose: 'Synthetic', policy_version: 't1', granted_at: T, expires_at: null, superseded_at: T, withdrawn_at: null,
      withdrawal_status: 'none', legal_hold: false,
    });
    const api = new FakeApi({
      listMyConsents: ({ query }) => (query?.cursor === 'older' ? page([consent(51, 'documents')]) : page([consent(50, 'own_words')], 'older')) as never,
    });
    renderScreen(<ConsentScreen />, { api, session: as('listMyConsents') });
    await user.click(await screen.findByRole('button', { name: 'Show more consents' }));
    await waitFor(() => expect(within(screen.getByRole('table', { name: 'My consents' })).getAllByRole('row')).toHaveLength(3));
    expect(api.callsTo('listMyConsents').map((c) => c.query?.cursor)).toEqual([undefined, 'older']);
  });
});
