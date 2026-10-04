// Features 23 and 22 on the screens: a conflict is shown with both values, a reader can say an answer was wrong,
// reviewers see items in conflict and old items, and the quality page shows the counts. Synthetic data only.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { KAnswer, KAnswerFeedback, KItemDetail, KQualitySummary, KQualityWeek, KTask } from '../api/generated.ts';
import { FakeApi, problem, makeSession, permissionsFor, renderScreen, sessionValue } from '../test/harness.tsx';
import { AskScreen } from './ask/AskScreen.tsx';
import { KnowledgeItemScreen } from './knowledge/KnowledgeItemScreen.tsx';
import { ConflictsScreen } from './quality/ConflictsScreen.tsx';
import { share, totals } from './quality/hooks.ts';
import { QualityScreen } from './quality/QualityScreen.tsx';

const ID = (n: number): string => `01a10174-0000-7000-8000-${String(n).padStart(12, '0')}`;
const T = '2026-10-01T09:00:00.000Z';
const as = (...ops: Parameters<typeof permissionsFor>) => sessionValue(makeSession(permissionsFor(...ops)));

const refused: KAnswer = {
  outcome: 'dont_know', answer: null, reason: 'sources_conflict', confidence: null, contains_unverified_sources: false, citations: [], can_ask_expert: false,
  answer_id: ID(91), conflict_found_by: 'value_check', conflict_check_partial: false,
  conflicts: [{ measure: 'pressure', a: { kind: 'item', id: ID(71), title: 'Handbook 2019', value: '3.0 bar' },
                b: { kind: 'source', id: ID(72), title: 'Fault table', value: '3.2 bar' } }],
};
const answered: KAnswer = {
  outcome: 'answered', answer: 'The alarm is set at 3.0 bar.', reason: null, confidence: 'medium', contains_unverified_sources: false, can_ask_expert: false,
  citations: [], answer_id: ID(92), conflict_found_by: null, conflicts: [], conflict_check_partial: false,
};

async function askSomething(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText('Your question'), 'At what pressure does the alarm come?');
  await user.click(screen.getByRole('button', { name: 'Ask' }));
}

describe('ask: a conflict found in the sources', () => {
  it('shows both values with the names of their sources, and says how it was noticed', async () => {
    const user = userEvent.setup();
    renderScreen(<AskScreen />, { api: new FakeApi({ askKnowledge: () => refused }), session: as('askKnowledge') });
    await askSomething(user);
    expect(await screen.findByText('I don’t know')).toBeTruthy();
    const line = screen.getByText(/Handbook 2019/).closest('li');
    expect(line?.textContent).toContain('3.0 bar');
    expect(line?.textContent).toContain('Fault table');
    expect(line?.textContent).toContain('3.2 bar');
    expect(screen.getByText('Found by comparing the values the sources state.')).toBeTruthy();
    // an empty list must not be read as "the sources agree": the limits of the comparison are said on the screen
    expect(screen.getByText(/does not catch contradictions in ordinary prose/)).toBeTruthy();
    expect(screen.queryByText('Answer')).toBeNull();
  });

  it('links each side to its source when the card may open it, says who found it, and when the comparison was partial', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({ askKnowledge: () => ({ ...refused, conflict_found_by: 'ai_model' as const, conflicts: [], conflict_check_partial: true }) });
    const { unmount } = renderScreen(<AskScreen />, { api, session: as('askKnowledge') });
    await askSomething(user);
    expect(await screen.findByText('The AI model reported that its sources disagree.')).toBeTruthy();
    expect(screen.getByText(/too large to compare completely/)).toBeTruthy();
    unmount();
    renderScreen(<AskScreen />, { api: new FakeApi({ askKnowledge: () => refused }), session: as('askKnowledge', 'getKnowledgeItem', 'getSource') });
    await askSomething(userEvent.setup());
    expect((await screen.findByRole('link', { name: 'Handbook 2019' })).getAttribute('href')).toBe(`/knowledge/${ID(71)}`);
    expect(screen.getByRole('link', { name: 'Fault table' }).getAttribute('href')).toBe(`/documents/${ID(72)}`);
  });
});

const opinion = (over: Partial<KAnswerFeedback> = {}): KAnswerFeedback => ({
  id: ID(95), answer_id: ID(92), verdict: 'wrong', comment: null, question_shared: false, question: null, created_at: T, outcome: 'answered',
  reason: null, confidence: 'medium', contains_unverified_sources: false, ...over,
});
const mayGiveFeedback = ['askKnowledge', 'putAnswerFeedback', 'withdrawAnswerFeedback'] as const;

describe('ask: saying what you think of an answer', () => {
  it('"wrong" asks for a few words and sends them for that one answer; the question is NOT shared unless the box is ticked', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({ askKnowledge: () => answered, putAnswerFeedback: () => opinion({ comment: 'The gauge shows 3.2.' }) });
    renderScreen(<AskScreen />, { api, session: as(...mayGiveFeedback) });
    await askSomething(user);
    const share = await screen.findByRole('checkbox', { name: 'Let reviewers see my question' });
    expect((share as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText(/the owner and the administrators of your company can read the question/)).toBeTruthy();   // who would see it
    await user.click(screen.getByRole('button', { name: 'It is wrong…' }));
    expect(api.callsTo('putAnswerFeedback')).toEqual([]);                           // nothing is sent until the reader confirms
    await user.type(screen.getByLabelText('What is wrong? (optional)'), 'The gauge shows 3.2.');
    await user.click(screen.getByRole('button', { name: 'Report as wrong' }));
    expect(await screen.findByText(/A reviewer will look at this answer\./)).toBeTruthy();
    expect(screen.getByText(/Your question is not shown to anyone\./)).toBeTruthy();
    expect(api.callsTo('putAnswerFeedback')).toEqual([
      { path: { knowledge_answer_id: ID(92) }, body: { verdict: 'wrong', share_question: false, comment: 'The gauge shows 3.2.' } }]);
  });

  it('"helpful" is one click and sends no comment; ticking the box shares the question', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({ askKnowledge: () => answered, putAnswerFeedback: () => opinion({ verdict: 'helpful', question_shared: true, question: 'x' }) });
    renderScreen(<AskScreen />, { api, session: as(...mayGiveFeedback) });
    await askSomething(user);
    await user.click(await screen.findByRole('checkbox', { name: 'Let reviewers see my question' }));
    await user.click(screen.getByRole('button', { name: 'Helpful' }));
    expect(await screen.findByText(/Your opinion was recorded\./)).toBeTruthy();
    expect(screen.getByText(/Your question is shown with it/)).toBeTruthy();
    expect(api.callsTo('putAnswerFeedback')[0]?.body).toEqual({ verdict: 'helpful', share_question: true });
  });

  it('an opinion can be taken back, and the reader can then say something else', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({ askKnowledge: () => answered, putAnswerFeedback: () => opinion(), withdrawAnswerFeedback: () => undefined as never });
    renderScreen(<AskScreen />, { api, session: as(...mayGiveFeedback) });
    await askSomething(user);
    await user.click(await screen.findByRole('button', { name: 'It is wrong…' }));
    await user.click(screen.getByRole('button', { name: 'Report as wrong' }));
    await user.click(await screen.findByRole('button', { name: 'Take it back' }));
    expect(await screen.findByText('Your opinion was removed.')).toBeTruthy();
    expect(api.callsTo('withdrawAnswerFeedback')).toEqual([{ path: { knowledge_answer_id: ID(92) } }]);
    expect(screen.getByRole('button', { name: 'Helpful' })).toBeTruthy();           // the choice is offered again
  });

  it('shows the opinion this card gave earlier (for example before the page was loaded again), and lets it be taken back', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({
      askKnowledge: () => answered, getAnswerFeedback: () => opinion({ verdict: 'unhelpful' }), withdrawAnswerFeedback: () => undefined as never,
    });
    renderScreen(<AskScreen />, { api, session: as(...mayGiveFeedback, 'getAnswerFeedback') });
    await askSomething(user);
    expect(await screen.findByText(/You said: /)).toBeTruthy();                      // nothing was clicked: it was read back
    expect(api.callsTo('getAnswerFeedback')[0]).toEqual({ path: { knowledge_answer_id: ID(92) } });
    expect(screen.queryByRole('button', { name: 'Helpful' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Take it back' }));
    expect(await screen.findByText('Your opinion was removed.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Helpful' })).toBeTruthy();
  });

  it('offers the choice when the card has said nothing about this answer yet ("not found" is not an error to show)', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({ askKnowledge: () => answered, getAnswerFeedback: () => { throw problem(404, 'Not found', 'not_found'); } });
    renderScreen(<AskScreen />, { api, session: as(...mayGiveFeedback, 'getAnswerFeedback') });
    await askSomething(user);
    expect(await screen.findByRole('button', { name: 'Helpful' })).toBeTruthy();
    expect(screen.queryByText('Not found')).toBeNull();
  });

  it('a refused question can be marked too (the right to ask is the right to say what you think of the answer)', async () => {
    const user = userEvent.setup();
    renderScreen(<AskScreen />, { api: new FakeApi({ askKnowledge: () => refused }), session: as('askKnowledge') });
    await askSomething(user);
    expect(await screen.findByRole('button', { name: 'Not helpful' })).toBeTruthy();
  });

  it('an answer without a record (none is given) offers no feedback', async () => {
    const user = userEvent.setup();
    renderScreen(<AskScreen />, { api: new FakeApi({ askKnowledge: () => ({ ...answered, answer_id: null }) }), session: as('askKnowledge') });
    await askSomething(user);
    expect(await screen.findByText('The alarm is set at 3.0 bar.')).toBeTruthy();
    expect(screen.queryByText('Was this useful?')).toBeNull();
  });
});

describe('a knowledge item that disagrees with another verified item', () => {
  const item = (conflicts: KItemDetail['conflicts']): KItemDetail => ({
    id: ID(30), title: 'CO2 alarm', status: 'verified', origin: 'manual', ai_extracted: false, department_id: null, sensitivity: 1, owner_person_id: null,
    usage_count: 0, verified_at: T, stale_after: null, updated_at: T, body: 'The CO2 low-pressure alarm is set at 3.0 bar.', self_verified: false, provenance: [],
    versions: [{ version_no: 1, change_kind: 'created', author_person_id: null, created_at: T, erased_at: null, current: true }], topics: [], conflicts,
  });
  const at = { at: `/knowledge/${ID(30)}`, route: '/knowledge/:itemId' };

  it('names the other item with a link and shows both values', async () => {
    const api = new FakeApi({
      getKnowledgeItem: () => item([{
        restricted: false, measure: 'pressure', this: { kind: 'item', id: ID(30), title: 'CO2 alarm', value: '3.0 bar' },
        other: { kind: 'item', id: ID(31), title: 'Fault table', value: '3.2 bar' }, detected_at: T,
      }]),
    });
    renderScreen(<KnowledgeItemScreen />, { api, session: as('getKnowledgeItem'), ...at });
    expect(await screen.findByText('This item disagrees with another verified item')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Fault table' });
    expect(link.getAttribute('href')).toBe(`/knowledge/${ID(31)}`);
    expect(link.closest('li')?.textContent).toContain('This item says 3.0 bar.');
    expect(link.closest('li')?.textContent).toContain('says 3.2 bar.');
  });

  it('says only that a conflict exists when the other item may not be read, and nothing at all when there is none', async () => {
    const hidden = new FakeApi({
      getKnowledgeItem: () => item([{ restricted: true, measure: null, this: null, other: null, detected_at: null }]),
    });
    const { unmount } = renderScreen(<KnowledgeItemScreen />, { api: hidden, session: as('getKnowledgeItem'), ...at });
    const note = await screen.findByText('It disagrees with an item you may not read. What that item says is not shown.');
    // nothing about the other item: no value of either side, no kind of measure
    expect(note.closest('ul')?.textContent).not.toMatch(/bar|pressure|says 3/);
    expect(screen.queryByText(/3.2 bar/)).toBeNull();
    unmount();
    renderScreen(<KnowledgeItemScreen />, { api: new FakeApi({ getKnowledgeItem: () => item([]) }), session: as('getKnowledgeItem'), ...at });
    expect(await screen.findByText('The CO2 low-pressure alarm is set at 3.0 bar.')).toBeTruthy();
    expect(screen.queryByText('This item disagrees with another verified item')).toBeNull();
  });
});

const task = (n: number, kind: string): KTask => ({
  id: ID(n), kind, subject_type: 'knowledge_item', subject_id: ID(n + 100), department_id: null, sensitivity: 1, priority: 1, status: 'open',
  assigned_to_card_id: null, created_at: T, due_at: '2099-01-01T00:00:00.000Z', first_response_at: null, resolved_at: null, resolution: null,
});

describe('conflicts and old items', () => {
  it('asks the review queue for the two kinds and links each task to its item', async () => {
    const api = new FakeApi({
      listReviewTasks: ({ query }) => ({ items: query?.kind === 'item_conflict' ? [task(1, 'item_conflict'), task(2, 'item_conflict')] : [task(3, 'stale_item')], next_cursor: null }),
    });
    renderScreen(<ConflictsScreen />, { api, session: as('listReviewTasks', 'getKnowledgeItem') });
    const conflicts = within(await screen.findByRole('table', { name: 'Items in conflict' }));
    expect(conflicts.getAllByRole('link').map((l) => l.getAttribute('href'))).toEqual([`/knowledge/${ID(101)}`, `/knowledge/${ID(102)}`]);
    const old = within(await screen.findByRole('table', { name: 'Old items' }));
    expect(old.getAllByRole('link')).toHaveLength(1);
    expect(api.callsTo('listReviewTasks').map((c) => c.query?.kind).sort()).toEqual(['item_conflict', 'stale_item']);
    expect(api.callsTo('listReviewTasks').every((c) => c.query?.status === 'open')).toBe(true);
  });

  it('says so when there is nothing, and what the comparison cannot find', async () => {
    renderScreen(<ConflictsScreen />, { api: new FakeApi({ listReviewTasks: () => ({ items: [], next_cursor: null }) }), session: as('listReviewTasks') });
    expect(await screen.findByText('No conflict is known between verified items.')).toBeTruthy();
    expect(await screen.findByText('No item is waiting for a fresh look.')).toBeTruthy();
    expect(screen.getByText('What the comparison cannot find')).toBeTruthy();
  });
});

const week = (start: string, over: Partial<KQualityWeek> = {}): KQualityWeek => ({
  week_start: start, questions: 0, answered: 0, search_only: 0, dont_know: 0, dont_know_no_relevant_sources: 0, dont_know_not_grounded: 0,
  dont_know_low_confidence: 0, dont_know_sources_conflict: 0, conflicts_found_by_value_check: 0, conflicts_found_by_ai_model: 0, citations_removed: 0,
  answers_naming_an_unknown_source: 0, answers_containing_unverified_sources: 0, feedback_helpful: 0, feedback_unhelpful: 0, feedback_wrong: 0, ...over,
});
const said = (n: number, over: Partial<KAnswerFeedback> = {}): KAnswerFeedback => ({
  id: ID(n), answer_id: ID(n + 100), verdict: 'wrong', comment: 'The gauge shows 3.2.', created_at: T, question_shared: true,
  question: 'At what pressure does the alarm come?', outcome: 'answered', reason: null, confidence: 'medium', contains_unverified_sources: false, ...over,
});

describe('answer quality', () => {
  const summary: KQualitySummary = {
    kept_for_days: 90, waiting_for_review: { item_conflicts: 2, stale_items: 1, answers_marked_wrong: 3 },
    weeks: [
      week('2026-09-28', { questions: 30, answered: 20, dont_know: 9, search_only: 1, dont_know_sources_conflict: 4, conflicts_found_by_value_check: 3,
                           conflicts_found_by_ai_model: 1, dont_know_no_relevant_sources: 5, citations_removed: 2, answers_containing_unverified_sources: 5,
                           feedback_wrong: 3, feedback_helpful: 6 }),
      week('2026-09-21', { questions: 10, answered: 10, feedback_helpful: 1 }),
    ],
  };

  it('adds the weeks up, shows every share with the numbers it comes from, and says what it cannot tell', async () => {
    const api = new FakeApi({ getQualitySummary: () => summary, listAnswerFeedback: () => ({ items: [said(1)], next_cursor: null }) });
    renderScreen(<QualityScreen />, { api, session: as('getQualitySummary', 'listAnswerFeedback', 'listReviewTasks') });
    expect(await screen.findByText('30 of 40 (75 %)')).toBeTruthy();                       // answered
    expect(screen.getByText('9 of 40 (23 %)')).toBeTruthy();                               // refused
    expect(screen.getByText('4 (found by comparing values: 3, reported by the AI model: 1)')).toBeTruthy();
    expect(screen.getByText('5 of 30 (17 %)')).toBeTruthy();                               // answers using an unverified source
    expect(screen.getByText('7 / 0 / 3')).toBeTruthy();
    expect(screen.getByText(/kept for 90 days/)).toBeTruthy();
    const weeks = within(screen.getByRole('table', { name: 'Answer quality by week' })).getAllByRole('row');
    expect(weeks).toHaveLength(3);
    expect(weeks[1]?.textContent).toContain('2026-09-28');
    expect(screen.getByRole('link', { name: 'Open conflicts and old items' }).getAttribute('href')).toBe('/conflicts');
    expect(screen.getByText('What this page cannot tell you')).toBeTruthy();
    expect(api.callsTo('getQualitySummary')[0]?.query).toEqual({ weeks: 8 });
  });

  it('lists what readers said: wrong ones first, all of them on request, the next part with the cursor', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({
      getQualitySummary: () => ({ ...summary, weeks: [] }),
      listAnswerFeedback: ({ query }) => (query?.cursor === 'next'
        ? { items: [said(2, { comment: null })], next_cursor: null }
        : { items: [said(1, query?.verdict === undefined ? { verdict: 'helpful', comment: null } : {})], next_cursor: query?.verdict === 'wrong' ? 'next' : null }),
    });
    renderScreen(<QualityScreen />, { api, session: as('getQualitySummary', 'listAnswerFeedback') });
    const table = await screen.findByRole('table', { name: 'Readers’ feedback' });
    expect(within(table).getByText('The gauge shows 3.2.')).toBeTruthy();
    expect(api.callsTo('listAnswerFeedback')[0]?.query).toEqual({ limit: 25, verdict: 'wrong' });
    await user.click(screen.getByRole('button', { name: 'Show more entries' }));
    await waitFor(() => expect(within(screen.getByRole('table', { name: 'Readers’ feedback' })).getAllByRole('row')).toHaveLength(3));
    await user.click(screen.getByLabelText('Only answers marked wrong'));
    expect(await screen.findByText('Helpful')).toBeTruthy();
    expect(api.callsTo('listAnswerFeedback').at(-1)?.query).toEqual({ limit: 25 });
    expect(screen.getByText('Nothing was recorded in this time.')).toBeTruthy();
  });
});

describe('quality numbers', () => {
  it('a share is written with its numbers, and no percentage is invented from nothing', () => {
    expect(share(3, 12)).toBe('3 of 12 (25 %)');
    expect(share(0, 0)).toBe('0 of 0');
    expect(totals([week('a', { questions: 2, answered: 1 }), week('b', { questions: 3, answered: 3 })]).answered).toBe(4);
  });
});
