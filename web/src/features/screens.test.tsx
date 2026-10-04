// The main states of each screen, with a stand-in API. Synthetic data only.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { KAnswer, KConsent, KItemDetail, KItemSummary, KSource, KTask } from '../api/generated.ts';
import { FakeApi, makeSession, permissionsFor, problem, renderScreen, sessionValue } from '../test/harness.tsx';
import { AskScreen } from './ask/AskScreen.tsx';
import { ConsentScreen } from './consent/ConsentScreen.tsx';
import { DocumentDetailScreen } from './documents/DocumentDetailScreen.tsx';
import { DocumentsScreen } from './documents/DocumentsScreen.tsx';
import { HomeScreen } from './home/HomeScreen.tsx';
import { KnowledgeItemScreen } from './knowledge/KnowledgeItemScreen.tsx';
import { KnowledgeScreen } from './knowledge/KnowledgeScreen.tsx';
import { ReviewScreen } from './review/ReviewScreen.tsx';

const ID = (n: number): string => `01a10174-0000-7000-8000-${String(n).padStart(12, '0')}`;
const T = '2026-10-01T09:00:00.000Z';
const page = <X,>(items: X[]) => ({ items, next_cursor: null });
const as = (...ops: Parameters<typeof permissionsFor>) => sessionValue(makeSession(permissionsFor(...ops)));

describe('ask', () => {
  const answered: KAnswer = {
    outcome: 'answered', answer: 'The relief valve lifts at 6 bar.', reason: null, confidence: 'high', contains_unverified_sources: true, can_ask_expert: false,
    answer_id: ID(90), conflict_found_by: null, conflicts: [], conflict_check_partial: false,
    citations: [
      { ref: 'S1', kind: 'item', id: ID(1), title: 'Relief valve', snippet: 'lifts at 6 bar', verification_status: 'verified', expert_display_name: 'Synthetic Expert', derived_from: [] },
      { ref: 'S2', kind: 'source', id: ID(2), title: 'Boiler notes', snippet: 'tested monthly', verification_status: 'unverified', expert_display_name: null, derived_from: [] },
    ],
  };

  it('shows the answer with its sources and whether each is verified', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({ askKnowledge: () => answered });
    renderScreen(<AskScreen />, { api, session: as('askKnowledge', 'getKnowledgeItem') });
    await user.type(screen.getByLabelText('Your question'), 'When does the relief valve lift?');
    await user.click(screen.getByRole('button', { name: 'Ask' }));
    expect(await screen.findByText('The relief valve lifts at 6 bar.')).toBeTruthy();
    expect(screen.getByText('Uses sources nobody has verified yet')).toBeTruthy();
    const sources = screen.getAllByRole('listitem');
    expect(sources).toHaveLength(2);
    expect(within(sources[0] as HTMLElement).getByText('Verified')).toBeTruthy();
    expect(within(sources[0] as HTMLElement).getByRole('link', { name: 'Relief valve' }).getAttribute('href')).toBe(`/knowledge/${ID(1)}`);
    expect(within(sources[1] as HTMLElement).getByText('Not verified')).toBeTruthy();
    // no permission to open documents -> the title is text, not a link
    expect(within(sources[1] as HTMLElement).queryByRole('link')).toBeNull();
    expect(api.callsTo('askKnowledge')[0]?.body).toEqual({ question: 'When does the relief valve lift?' });
  });

  it('says "I don\'t know" plainly, explains a conflict, and lets the person ask an expert', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({
      askKnowledge: () => ({
        outcome: 'dont_know', answer: null, reason: 'sources_conflict', confidence: null, contains_unverified_sources: false, citations: [], can_ask_expert: true,
        answer_id: ID(91), conflict_found_by: 'value_check' as const, conflict_check_partial: false,
        conflicts: [{ measure: 'pressure' as const, a: { kind: 'item' as const, id: ID(71), title: 'Handbook', value: '3.0 bar' }, b: { kind: 'source' as const, id: ID(72), title: 'Fault table', value: '3.2 bar' } }],
      }),
      listPeople: () => page([{ id: ID(7), display_name: 'Synthetic Expert', email: null, department_id: null, status: 'active' as const, created_at: T }]),
      createExpertQuestion: () => ({ id: ID(8), status: 'open', expires_at: T }),
    });
    renderScreen(<AskScreen />, { api, session: as('askKnowledge', 'createExpertQuestion', 'listPeople') });
    await user.type(screen.getByLabelText('Your question'), 'What torque?');
    await user.click(screen.getByRole('button', { name: 'Ask' }));
    expect(await screen.findByText('I don’t know')).toBeTruthy();
    expect(screen.getByText(/sources disagree/)).toBeTruthy();
    expect(screen.queryByText('Answer')).toBeNull();
    await user.selectOptions(await screen.findByLabelText('Who should answer?'), await screen.findByRole('option', { name: 'Synthetic Expert' }));
    await user.click(screen.getByRole('button', { name: 'Send my question' }));
    expect(await screen.findByText('Your question was sent')).toBeTruthy();
    expect(api.callsTo('createExpertQuestion')[0]?.body).toEqual({ expert_person_id: ID(7), question: 'What torque?' });
  });

  it('shows the API\'s error and offers no expert when the card may not ask one', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({ askKnowledge: () => { throw problem(502, 'The answer service is not available', 'unavailable'); } });
    renderScreen(<AskScreen />, { api, session: as('askKnowledge') });
    await user.type(screen.getByLabelText('Your question'), 'Anything?');
    await user.click(screen.getByRole('button', { name: 'Ask' }));
    expect(await screen.findByText('The answer service is not available')).toBeTruthy();
    expect(screen.getByText(/Reference: req-test-1/)).toBeTruthy();
    expect(screen.queryByText('Ask an expert instead')).toBeNull();
  });
});

describe('documents', () => {
  const doc = (over: Partial<KSource> = {}): KSource => ({
    id: ID(20), kind: 'document', title: 'Boiler notes', department_id: null, sensitivity: 1, contributor_person_id: null, company_document: true, status: 'ready',
    failure_code: null, mime: 'text/plain', byte_size: 120, page_count: 1, chunk_count: 3, created_at: T, ready_at: T, ...over,
  });

  it('lists documents; a card that may only read sees no form', async () => {
    const api = new FakeApi({ listSources: () => page([doc(), doc({ id: ID(21), title: 'Scan', status: 'failed', failure_code: 'no_text_layer' })]) });
    renderScreen(<DocumentsScreen />, { api, session: as('listSources') });
    expect(await screen.findByText('Boiler notes')).toBeTruthy();
    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.queryByText('Add a document')).toBeNull();
  });

  it('adds a document: describes it, sends the file with its type, and reports the result', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({
      listSources: () => page<KSource>([]),
      createSource: () => ({ id: ID(22), status: 'awaiting_content', title: 'Pump notes' }),
      uploadSourceContent: () => ({ status: 'ready', failure_code: null, chunk_count: 4, pending_chunks: 0, duplicate_of: null }),
    });
    renderScreen(<DocumentsScreen />, { api, session: as('listSources', 'createSource', 'uploadSourceContent') });
    expect(await screen.findByText('No documents yet.')).toBeTruthy();
    await user.type(screen.getByLabelText('Title'), 'Pump notes');
    const file = new File(['Synthetic pump notes.'], 'pump.md', { type: '' });
    await user.upload(screen.getByLabelText('File'), file);
    await user.click(screen.getByRole('button', { name: 'Add document' }));
    expect(await screen.findByText('The document is ready')).toBeTruthy();
    expect(screen.getByText(/4 passages/)).toBeTruthy();
    expect(api.callsTo('createSource')[0]?.body).toEqual({ title: 'Pump notes', sensitivity: 1, company_document: true });
    expect(api.callsTo('uploadSourceContent')[0]).toMatchObject({ path: { source_id: ID(22) }, contentType: 'text/markdown' });
    // no permission to list people -> the card cannot name a contributor
    expect(screen.queryByLabelText('Whose material is it?')).toBeNull();
  });

  it('when a named contributor must confirm first, it says so and sends no file', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({
      listSources: () => page<KSource>([]),
      listPeople: () => page([{ id: ID(7), display_name: 'Synthetic Expert', email: null, department_id: null, job_role: null, status: 'active' as const, created_at: T }]),
      createSource: () => ({ id: ID(24), status: 'awaiting_confirmation', title: 'Their notes' }),
    });
    renderScreen(<DocumentsScreen />, { api, session: as('listSources', 'createSource', 'uploadSourceContent', 'listPeople') });
    await user.type(await screen.findByLabelText('Title'), 'Their notes');
    await screen.findByRole('option', { name: 'Synthetic Expert' });
    await user.selectOptions(screen.getByLabelText('Whose material is it?'), ID(7));
    await user.upload(screen.getByLabelText('File'), new File(['Synthetic notes.'], 'notes.txt', { type: 'text/plain' }));
    await user.click(screen.getByRole('button', { name: 'Add document' }));
    expect(await screen.findByText('Waiting for the contributor to confirm')).toBeTruthy();
    expect(screen.getByText(/Nothing was uploaded yet/)).toBeTruthy();
    expect(screen.queryByText('The document was received')).toBeNull();
    expect(api.callsTo('uploadSourceContent')).toEqual([]);
    expect(api.callsTo('createSource')[0]?.body).toEqual({ title: 'Their notes', sensitivity: 1, contributor_person_id: ID(7) });
  });

  it('when sending the file fails, trying again sends it to the SAME document instead of creating a second one', async () => {
    const user = userEvent.setup();
    let uploads = 0;
    const api = new FakeApi({
      listSources: () => page<KSource>([]),
      createSource: () => ({ id: ID(25), status: 'awaiting_content', title: 'Pump notes' }),
      uploadSourceContent: () => {
        uploads += 1;
        if (uploads === 1) throw problem(503, 'The service is busy', 'unavailable');
        return { status: 'ready', failure_code: null, chunk_count: 2, pending_chunks: 0, duplicate_of: null };
      },
    });
    renderScreen(<DocumentsScreen />, { api, session: as('listSources', 'createSource', 'uploadSourceContent') });
    await user.type(await screen.findByLabelText('Title'), 'Pump notes');
    await user.upload(screen.getByLabelText('File'), new File(['Synthetic pump notes.'], 'pump.txt', { type: 'text/plain' }));
    await user.click(screen.getByRole('button', { name: 'Add document' }));
    expect(await screen.findByText('The service is busy')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Add document' }));
    expect(await screen.findByText('The document is ready')).toBeTruthy();
    expect(api.callsTo('createSource')).toHaveLength(1);
    expect(api.callsTo('uploadSourceContent').map((c) => c.path?.source_id)).toEqual([ID(25), ID(25)]);
  });

  it('refuses a file type before sending anything, and explains a failed upload', async () => {
    const user = userEvent.setup({ applyAccept: false });
    const api = new FakeApi({
      listSources: () => page<KSource>([]),
      createSource: () => ({ id: ID(23), status: 'awaiting_content', title: 'Scan' }),
      uploadSourceContent: () => ({ status: 'failed', failure_code: 'no_text_layer', chunk_count: null, pending_chunks: null, duplicate_of: null }),
    });
    renderScreen(<DocumentsScreen />, { api, session: as('listSources', 'createSource', 'uploadSourceContent') });
    await user.type(await screen.findByLabelText('Title'), 'Scan');
    await user.upload(screen.getByLabelText('File'), new File(['x'], 'photo.png', { type: 'image/png' }));
    expect(screen.getByText('Choose a .txt, .md or .pdf file.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Add document' }) as HTMLButtonElement).disabled).toBe(true);
    await user.upload(screen.getByLabelText('File'), new File(['%PDF'], 'scan.pdf', { type: 'application/pdf' }));
    await user.click(screen.getByRole('button', { name: 'Add document' }));
    expect(await screen.findByText('The document could not be used')).toBeTruthy();
    expect(screen.getByText(/no text in it/)).toBeTruthy();
  });

  it('shows what was blanked out, and withdraws only after a second click', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({
      getSource: () => ({ ...doc(), redactions: [{ type: 'PERSON', count: 3, low_confidence: 1 }] }),
      withdrawSource: () => ({ id: ID(20), status: 'withdrawn', items_withdrawn: 1, items_back_in_review: 2 }),
    });
    renderScreen(<DocumentDetailScreen />, { api, session: as('getSource', 'withdrawSource'), at: `/documents/${ID(20)}`, route: '/documents/:sourceId' });
    expect(await screen.findByText('Person')).toBeTruthy();
    expect(screen.getByText(/not perfect/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Withdraw…' }));
    expect(api.callsTo('withdrawSource')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Yes, withdraw it' }));
    expect(await screen.findByText('The document was withdrawn')).toBeTruthy();
    expect(api.callsTo('withdrawSource')[0]?.path).toEqual({ source_id: ID(20) });
  });
});

describe('knowledge', () => {
  const summary = (over: Partial<KItemSummary> = {}): KItemSummary => ({
    id: ID(30), title: 'Relief valve', status: 'in_review', origin: 'manual', ai_extracted: false, department_id: null, sensitivity: 1, owner_person_id: null,
    usage_count: 0, verified_at: null, stale_after: null, updated_at: T, ...over,
  });
  const detail = (over: Partial<KItemDetail> = {}): KItemDetail => ({
    ...summary(), body: 'The relief valve lifts at 6 bar.', self_verified: false, provenance: [], topics: [], conflicts: [],
    versions: [{ version_no: 1, change_kind: 'created', author_person_id: null, created_at: T, erased_at: null, current: true }], ...over,
  });
  const at = { at: `/knowledge/${ID(30)}`, route: '/knowledge/:itemId' };

  it('lists items, filters by state, and writes a new one', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({
      listKnowledgeItems: () => page([summary(), summary({ id: ID(31), title: 'Drafted', status: 'candidate', ai_extracted: true })]),
      createKnowledgeItem: () => ({ id: ID(32), status: 'candidate' }),
    });
    renderScreen(<KnowledgeScreen />, { api, session: as('listKnowledgeItems', 'createKnowledgeItem') });
    expect(await screen.findByText('Relief valve')).toBeTruthy();
    expect(screen.getByText('Drafted by AI')).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('Show'), 'verified');
    await waitFor(() => expect(api.callsTo('listKnowledgeItems').at(-1)?.query).toEqual({ limit: 50, status: 'verified' }));
    await user.click(screen.getByRole('button', { name: 'Write a new item' }));
    await user.type(screen.getByLabelText('Title'), 'Pump seal');
    await user.type(screen.getByLabelText('What should a successor know?'), 'Replace the seal every 2,000 hours.');
    await user.click(screen.getByRole('button', { name: 'Save as draft' }));
    await waitFor(() => expect(api.callsTo('createKnowledgeItem')[0]?.body).toEqual({
      title: 'Pump seal', body: 'Replace the seal every 2,000 hours.', sensitivity: 1,
      contributor_person_id: '01a10174-0000-7000-8000-0000000000b1',   // the signed-in person is named as the writer
    }));
  });

  it('a reviewer can verify or reject an item in review; the author\'s card sees neither button', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({ getKnowledgeItem: () => detail(), verifyKnowledgeItem: () => ({ id: ID(30), status: 'verified' }) });
    const first = renderScreen(<KnowledgeItemScreen />, { api, session: as('getKnowledgeItem', 'verifyKnowledgeItem', 'rejectKnowledgeItem'), ...at });
    expect(await screen.findByText('The relief valve lifts at 6 bar.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(api.callsTo('verifyKnowledgeItem')[0]?.path).toEqual({ item_id: ID(30) }));
    first.unmount();

    renderScreen(<KnowledgeItemScreen />, { api: new FakeApi({ getKnowledgeItem: () => detail() }), session: as('getKnowledgeItem', 'createKnowledgeItem'), ...at });
    expect(await screen.findByText('The relief valve lifts at 6 bar.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Verify' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
  });

  it('explains the second-reviewer rule when the API refuses a verification', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({ getKnowledgeItem: () => detail(), verifyKnowledgeItem: () => { throw problem(403, 'Not allowed', 'forbidden'); } });
    renderScreen(<KnowledgeItemScreen />, { api, session: as('getKnowledgeItem', 'verifyKnowledgeItem'), ...at });
    await user.click(await screen.findByRole('button', { name: 'Verify' }));
    expect(await screen.findByText(/second reviewer is needed/)).toBeTruthy();
  });

  it('a draft can be sent for review; a verified item can be corrected or reopened', async () => {
    const user = userEvent.setup();
    const draft = new FakeApi({ getKnowledgeItem: () => detail({ status: 'candidate' }), submitKnowledgeItem: () => ({ id: ID(30), status: 'in_review' }) });
    const first = renderScreen(<KnowledgeItemScreen />, { api: draft, session: as('getKnowledgeItem', 'submitKnowledgeItem'), ...at });
    await user.click(await screen.findByRole('button', { name: 'Send for review' }));
    await waitFor(() => expect(draft.callsTo('submitKnowledgeItem')).toHaveLength(1));
    first.unmount();

    const api = new FakeApi({
      getKnowledgeItem: () => detail({ status: 'verified', verified_at: T }),
      proposeItemVersion: () => ({ id: ID(30), status: 'in_review', version_no: 2 }),
      reopenKnowledgeItem: () => ({ id: ID(30), status: 'in_review' }),
    });
    renderScreen(<KnowledgeItemScreen />, { api, session: as('getKnowledgeItem', 'proposeItemVersion', 'reopenKnowledgeItem'), ...at });
    await user.click(await screen.findByRole('button', { name: 'Correct the text' }));
    const box = screen.getByLabelText('Corrected text');
    await user.clear(box);
    await user.type(box, 'The relief valve lifts at 6.5 bar.');
    await user.click(screen.getByRole('button', { name: 'Save the correction' }));
    await waitFor(() => expect(api.callsTo('proposeItemVersion')[0]).toEqual({ path: { item_id: ID(30) }, body: { body: 'The relief valve lifts at 6.5 bar.' } }));
    await user.click(screen.getByRole('button', { name: 'Reopen for review' }));
    await waitFor(() => expect(api.callsTo('reopenKnowledgeItem')).toHaveLength(1));
  });
});

describe('review queue', () => {
  const task = (n: number, over: Partial<KTask> = {}): KTask => ({
    id: ID(40 + n), kind: 'verify_item', subject_type: 'knowledge_item', subject_id: ID(30), department_id: null, sensitivity: 1, priority: 1, status: 'open',
    assigned_to_card_id: null, created_at: T, due_at: '2099-01-01T00:00:00.000Z', first_response_at: null, resolved_at: null, resolution: null, ...over,
  });

  it('lists tasks with a link to the thing to review; takes one; handles several at once', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({
      listReviewTasks: () => page([task(1), task(2, { kind: 'redaction_review', subject_type: 'source', subject_id: ID(20) })]),
      assignReviewTask: () => task(1, { status: 'assigned' }),
      bulkReviewTasks: () => ({ results: [{ task_id: ID(41), outcome: 'done' as const }, { task_id: ID(42), outcome: 'refused' as const }] }),
    });
    renderScreen(<ReviewScreen />, { api, session: as('listReviewTasks', 'assignReviewTask', 'dismissReviewTask', 'getKnowledgeItem', 'getSource') });
    expect((await screen.findByRole('link', { name: 'Verify a knowledge item' })).getAttribute('href')).toBe(`/knowledge/${ID(30)}`);
    expect(screen.getByRole('link', { name: 'Check an uncertain redaction' }).getAttribute('href')).toBe(`/documents/${ID(20)}`);
    await user.click(screen.getAllByRole('button', { name: 'Take' })[0] as HTMLElement);
    await waitFor(() => expect(api.callsTo('assignReviewTask')[0]).toEqual({ path: { task_id: ID(41) }, body: {} }));
    for (const box of screen.getAllByRole('checkbox')) await user.click(box);
    await user.click(screen.getByRole('button', { name: 'Dismiss selected' }));
    expect(await screen.findByText(/Done for 1; 1 could not be changed/)).toBeTruthy();
    expect(api.callsTo('bulkReviewTasks')[0]?.body).toEqual({ action: 'dismiss', task_ids: [ID(41), ID(42)] });
  });

  it('a card that may only read the queue gets no action buttons', async () => {
    const api = new FakeApi({ listReviewTasks: () => page([task(1)]) });
    renderScreen(<ReviewScreen />, { api, session: as('listReviewTasks') });
    expect(await screen.findByText('Verify a knowledge item')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Take' })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    // ... and no link to a screen this card may not open (it would only say "not available")
    expect(screen.queryByRole('link', { name: 'Verify a knowledge item' })).toBeNull();
  });

  it('says when the list is cut short, and fetches the next part with the cursor', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({
      listReviewTasks: ({ query }) => (query?.cursor === 'next-1'
        ? { items: [task(2, { kind: 'stale_item' })], next_cursor: null }
        : { items: [task(1)], next_cursor: 'next-1' }),
    });
    renderScreen(<ReviewScreen />, { api, session: as('listReviewTasks') });
    expect(await screen.findByText(/Only the first 1 tasks are shown/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Show more tasks' }));
    expect(await screen.findByText('Re-check an old item')).toBeTruthy();
    expect(screen.getByText('Verify a knowledge item')).toBeTruthy();
    expect(api.callsTo('listReviewTasks').at(-1)?.query).toEqual({ status: 'open', limit: 50, cursor: 'next-1' });
    expect(screen.queryByText(/Only the first/)).toBeNull();
  });
});

describe('my consent', () => {
  const consent = (over: Partial<KConsent> = {}): KConsent => ({
    id: ID(50), person_id: ID(7), scope: 'documents', purpose: 'p', policy_version: 'web-2026-10', granted_at: T, expires_at: null, superseded_at: null,
    withdrawn_at: null, withdrawal_status: 'none', legal_hold: false, ...over,
  });

  it('gives consent only after the box is ticked, with the words that were shown', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({ listMyConsents: () => page<KConsent>([]), giveConsent: () => consent({ scope: 'own_words' }) });
    renderScreen(<ConsentScreen />, { api, session: as('listMyConsents', 'giveConsent') });
    expect(await screen.findByText('You have not given any consent.')).toBeTruthy();
    const give = screen.getByRole('button', { name: 'Give consent' }) as HTMLButtonElement;
    expect(give.disabled).toBe(true);
    await user.click(screen.getByRole('checkbox'));
    await user.click(give);
    await waitFor(() => expect(api.callsTo('giveConsent')).toHaveLength(1));
    const body = api.callsTo('giveConsent')[0]?.body as { scope: string; purpose: string; policy_version: string };
    expect(body.scope).toBe('own_words');
    expect(body.policy_version).toBe('web-2026-10');
    expect(screen.getByText(new RegExp(body.purpose.slice(0, 30)))).toBeTruthy();
  });

  it('withdraws after a second click and shows the state of each consent', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({
      listMyConsents: () => page([consent(), consent({ id: ID(51), scope: 'own_words', withdrawn_at: T, withdrawal_status: 'held' })]),
      withdrawConsent: () => consent({ withdrawn_at: T, withdrawal_status: 'hidden' }),
    });
    renderScreen(<ConsentScreen />, { api, session: as('listMyConsents', 'withdrawConsent') });
    expect(await screen.findByText('Active')).toBeTruthy();
    expect(screen.getByText(/kept under a legal hold/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Withdraw…' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Withdraw…' }));
    expect(api.callsTo('withdrawConsent')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Yes, withdraw and erase' }));
    expect(await screen.findByText('Your consent was withdrawn')).toBeTruthy();
    expect(api.callsTo('withdrawConsent')[0]?.path).toEqual({ consent_id: ID(50) });
  });

  it('lists my contributions and can only make them MORE restricted', async () => {
    const user = userEvent.setup();
    const mine: KItemSummary = {
      id: ID(60), title: 'Pump seal', status: 'verified', origin: 'manual', ai_extracted: false, department_id: null, sensitivity: 2, owner_person_id: ID(7),
      usage_count: 3, verified_at: T, stale_after: null, updated_at: T,
    };
    const api = new FakeApi({ listMyConsents: () => page<KConsent>([]), listMyContributions: () => page([mine]), restrictContribution: () => ({ id: ID(60), sensitivity: 3 }) });
    renderScreen(<ConsentScreen />, { api, session: as('listMyConsents', 'listMyContributions', 'restrictContribution') });
    expect(await screen.findByText('Pump seal')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Limit “Pump seal” to Internal/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Limit “Pump seal” to Confidential' }));
    await waitFor(() => expect(api.callsTo('restrictContribution')[0]).toEqual({ path: { item_id: ID(60) }, body: { sensitivity: 3 } }));
  });
});

describe('home', () => {
  it('shows only what the card may do, and counts what is waiting', async () => {
    const api = new FakeApi({ listReviewTasks: () => page([{ id: ID(41) } as KTask, { id: ID(42) } as KTask]) });
    renderScreen(<HomeScreen />, { api, session: as('askKnowledge', 'listReviewTasks') });
    expect(await screen.findByText('2 open tasks.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Ask' })).toBeTruthy();
    expect(screen.queryByText('Documents')).toBeNull();
    expect(screen.queryByText('Knowledge')).toBeNull();
  });

  it('does not present a cut-short count of waiting questions as exact', async () => {
    const api = new FakeApi({
      listExpertQuestions: () => ({ items: [{ id: ID(51), status: 'open' }, { id: ID(52), status: 'open' }], next_cursor: 'more' }) as never,
    });
    renderScreen(<HomeScreen />, { api, session: as('listExpertQuestions') });
    expect(await screen.findByText(/At least 2 colleagues are waiting/)).toBeTruthy();
  });

  it('a card with no knowledge rights is told so, and nothing is requested for it', () => {
    const { api } = renderScreen(<HomeScreen />, { session: sessionValue(makeSession([])) });
    expect(screen.getByText('Nothing to do here yet')).toBeTruthy();
    expect(api.calls).toHaveLength(0);
  });
});
