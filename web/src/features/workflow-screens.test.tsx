// The main states of the interview, topics, gaps and readiness screens, with a stand-in API. Synthetic data only.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { KAttempt, KInterviewDetail, KQuizItem, KReport, KTopic } from '../api/generated.ts';
import { FakeApi, makeSession, permissionsFor, problem, renderScreen, sessionValue } from '../test/harness.tsx';
import { QuestionsScreen } from './ask/QuestionsScreen.tsx';
import { InterviewScreen } from './interviews/InterviewScreen.tsx';
import { InterviewsScreen } from './interviews/InterviewsScreen.tsx';
import { AttemptScreen } from './readiness/AttemptScreen.tsx';
import { QuestionBankScreen } from './readiness/QuestionBankScreen.tsx';
import { ReadinessScreen } from './readiness/ReadinessScreen.tsx';
import { ReportScreen } from './readiness/ReportScreen.tsx';
import { GapsScreen } from './topics/GapsScreen.tsx';
import { TopicsScreen } from './topics/TopicsScreen.tsx';

const ID = (n: number): string => `01a10174-0000-7000-8000-${String(n).padStart(12, '0')}`;
const ME = '01a10174-0000-7000-8000-0000000000b1';   // the person of the test session (test/harness.tsx)
const T = '2026-10-01T09:00:00.000Z';
const page = <X,>(items: X[]) => ({ items, next_cursor: null });
const as = (...ops: Parameters<typeof permissionsFor>) => sessionValue(makeSession(permissionsFor(...ops)));
const person = (n: number, name: string) => ({ id: ID(n), display_name: name, email: null, department_id: null, status: 'active' as const, created_at: T });

describe('interviews', () => {
  const interview = (over: Partial<KInterviewDetail> = {}): KInterviewDetail => ({
    id: ID(60), expert_person_id: ME, job_role: 'Boiler operator', status: 'invited', turn_count: 0, max_turns: 12, created_at: T, last_turn_at: null, completed_at: null, turns: [], ...over,
  });
  const at = { at: `/interviews/${ID(60)}`, route: '/interviews/:interviewId' };

  it('lists interviews; a card that may invite sends the person and the job role', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({
      listInterviews: () => page([interview()]),
      listPeople: () => page([person(7, 'Synthetic Expert')]),
      createInterview: () => ({ id: ID(61), status: 'invited' }),
    });
    renderScreen(<InterviewsScreen />, { api, session: as('listInterviews', 'createInterview', 'listPeople', 'getInterview') });
    expect(await screen.findByText('Invited — not started')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open the interview' })).toBeTruthy();
    await screen.findByRole('option', { name: 'Synthetic Expert' });
    await user.selectOptions(screen.getByLabelText('Who is the expert?'), ID(7));
    await user.type(screen.getByLabelText('About which job role?'), 'Boiler operator');
    await user.click(screen.getByRole('button', { name: 'Invite' }));
    expect(await screen.findByText('The invitation was created')).toBeTruthy();
    expect(api.callsTo('createInterview')[0]?.body).toEqual({ expert_person_id: ID(7), job_role: 'Boiler operator' });
  });

  it('an expert without the right to invite sees no invitation form; an empty list says so', async () => {
    const api = new FakeApi({ listInterviews: () => page([]) });
    renderScreen(<InterviewsScreen />, { api, session: as('listInterviews') });
    expect(await screen.findByText('No interviews yet.')).toBeTruthy();
    expect(screen.queryByText('Invite someone to an interview')).toBeNull();
  });

  it('the invited expert starts the interview; a missing consent is explained with the way to give it', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({ getInterview: () => interview(), acceptInterview: () => { throw problem(422, 'consent missing', 'invalid'); } });
    renderScreen(<InterviewScreen />, { api, session: as('getInterview', 'acceptInterview', 'listMyConsents'), ...at });
    await user.click(await screen.findByRole('button', { name: 'Start' }));
    expect(await screen.findByText('Your consent is needed first')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open my consent' })).toBeTruthy();
    expect(api.callsTo('acceptInterview')[0]?.path).toEqual({ interview_id: ID(60) });
  });

  it('shows the waiting question, sends the answer and says a draft item was made; finishing asks twice', async () => {
    const user = userEvent.setup();
    const running = interview({
      status: 'active', turn_count: 1,
      turns: [
        { ordinal: 1, topic_id: null, question: 'What do you check first?', kind: 'template', answer: 'The pressure gauge.', answered_at: T, erased: false },
        { ordinal: 2, topic_id: null, question: 'What do you do when the alarm sounds?', kind: 'follow_up', answer: null, answered_at: null, erased: false },
      ],
    });
    const api = new FakeApi({
      getInterview: () => running,
      answerInterviewTurn: () => ({ interview_id: ID(60), status: 'active', next_question: 'Anything else?', turn_count: 2, candidate_item_id: ID(62) }),
      completeInterview: () => ({ id: ID(60), status: 'completed' }),
    });
    renderScreen(<InterviewScreen />, { api, session: as('getInterview', 'acceptInterview'), ...at });
    expect((await screen.findByTestId('interview-question')).textContent).toBe('What do you do when the alarm sounds?');
    expect(screen.getByText('The pressure gauge.')).toBeTruthy();
    await user.type(screen.getByLabelText('Your answer'), 'I tell the control room.');
    await user.click(screen.getByRole('button', { name: 'Send my answer' }));
    expect(await screen.findByText('Your answer was saved as a draft knowledge item')).toBeTruthy();
    expect(api.callsTo('answerInterviewTurn')[0]?.body).toEqual({ answer: 'I tell the control room.' });
    await user.click(screen.getByRole('button', { name: 'Finish the interview…' }));
    expect(api.callsTo('completeInterview')).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Yes, finish it' }));
    await waitFor(() => expect(api.callsTo('completeInterview')).toHaveLength(1));
  });

  it('somebody else who may read the interview gets no way to answer it', async () => {
    const api = new FakeApi({ getInterview: () => interview({ status: 'active', expert_person_id: ID(99), turns: [{ ordinal: 1, topic_id: null, question: 'Q?', kind: 'template', answer: null, answered_at: null, erased: false }] }) });
    renderScreen(<InterviewScreen />, { api, session: as('getInterview', 'acceptInterview'), ...at });
    expect(await screen.findByText('In progress')).toBeTruthy();
    expect(screen.queryByLabelText('Your answer')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
  });
});

describe('topics and gaps', () => {
  const topic = (n: number, name: string, status = 'active'): KTopic => ({ id: ID(n), name, description: '', department_id: null, sensitivity: 0, origin: status === 'proposed' ? 'extracted' : 'admin', status, created_at: T });

  it('adds a topic and accepts a suggested one', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({
      listTopics: ({ query }) => page(query?.status === 'proposed' ? [topic(71, 'Purging', 'proposed')] : [topic(70, 'Relief valves')]),
      createTopic: () => topic(72, 'Pump seals'),
      updateTopic: () => topic(71, 'Purging'),
    });
    renderScreen(<TopicsScreen />, { api, session: as('createTopic', 'listTopics') });
    expect(await screen.findByText('Relief valves')).toBeTruthy();
    expect(screen.queryByText('Suggest topics from a document')).toBeNull();   // needs suggestTopics and the document list
    await user.type(screen.getByLabelText('Name'), 'Pump seals');
    await user.click(screen.getByRole('button', { name: 'Add topic' }));
    await waitFor(() => expect(api.callsTo('createTopic')[0]?.body).toEqual({ name: 'Pump seals' }));
    await user.selectOptions(screen.getByLabelText('Show'), 'proposed');
    await user.click(await screen.findByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(api.callsTo('updateTopic')[0]).toMatchObject({ path: { topic_id: ID(71) }, body: { status: 'active' } }));
  });

  it('shows the gap report of a job role and saves the role’s topics as one list', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({
      getGapReport: () => ({ job_role: 'Boiler operator', topics: [{ topic_id: ID(70), name: 'Relief valves', required: true, importance: 3, label: 'single_source', verified_items: 1, contributors: 1 }] }),
      listTopics: () => page([topic(70, 'Relief valves'), topic(73, 'Purging')]),
      setRoleTopics: () => ({ job_role: 'Boiler operator', topics: [] }),
    });
    renderScreen(<GapsScreen />, { api, session: as('getGapReport', 'setRoleTopics', 'listTopics') });
    expect(api.callsTo('getGapReport')).toEqual([]);    // nothing is asked before a job role is named
    await user.type(screen.getByLabelText('Job role'), 'Boiler operator');
    await user.click(screen.getByRole('button', { name: 'Show' }));
    expect(await screen.findByText('Rests on one person only')).toBeTruthy();
    await user.click(await screen.findByRole('checkbox', { name: 'Purging' }));
    await user.click(screen.getByRole('button', { name: 'Save the topics' }));
    await waitFor(() => expect(api.callsTo('setRoleTopics')[0]).toMatchObject({
      path: { job_role: 'Boiler operator' },
      body: { topics: [{ topic_id: ID(70), importance: 3, required: true }, { topic_id: ID(73), importance: 2, required: true }] },
    }));
    expect(screen.queryByText('People in this job role')).toBeNull();   // needs setRolePeople and the people list
  });

  it('a job role that the card may not see shows the API’s refusal', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({ getGapReport: () => { throw problem(403, 'Not allowed', 'forbidden'); } });
    renderScreen(<GapsScreen />, { api, session: as('getGapReport') });
    await user.type(screen.getByLabelText('Job role'), 'Secret role');
    await user.click(screen.getByRole('button', { name: 'Show' }));
    expect(await screen.findByText('Not allowed')).toBeTruthy();
  });
});

describe('readiness test', () => {
  type Question = KAttempt['questions'][number];
  const MCQ: Question = { answer_id: ID(81), position: 1, kind: 'mcq', stem: 'How often is the lever tested?', options: ['Monthly', 'Yearly', 'Never', 'Daily'], chosen_option: null, answer_text: null, final_score: null, decided_by: null };
  const OPEN: Question = { answer_id: ID(82), position: 2, kind: 'open', stem: 'What do you do if it sticks?', options: null, chosen_option: null, answer_text: null, final_score: null, decided_by: null };
  const attempt = (over: Partial<KAttempt> = {}): KAttempt => ({
    id: ID(80), learner_person_id: ME, job_role: 'Boiler operator', status: 'in_progress', started_at: T, expires_at: '2099-01-01T00:00:00.000Z', submitted_at: null, graded_at: null, bank_size: 3,
    questions: [MCQ, OPEN],
    ...over,
  });
  const at = { at: `/readiness/attempts/${ID(80)}`, route: '/readiness/attempts/:attemptId' };

  it('starts a test for a job role and goes to it; "no questions" is explained in plain words', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const api = new FakeApi({
      startReadinessAttempt: () => {
        calls += 1;
        if (calls === 1) throw problem(422, 'no_questions', 'invalid');
        return { id: ID(80), expires_at: T, questions: [] };
      },
    });
    renderScreen(<ReadinessScreen />, { api, session: as('startReadinessAttempt', 'getReadinessAttempt'), at: '/readiness', route: '/readiness' });
    await user.type(screen.getByLabelText('For which job role?'), 'Boiler operator');
    await user.click(screen.getByRole('button', { name: 'Start the test' }));
    expect(await screen.findByText('There is no test for this job role yet')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Start the test' }));
    expect(await screen.findByText('other screen')).toBeTruthy();
    expect(api.callsTo('startReadinessAttempt')[1]?.body).toEqual({ job_role: 'Boiler operator' });
  });

  it('while the test runs: saves answers as the learner goes, never draws a right answer, hands in after a second click', async () => {
    const user = userEvent.setup();
    // Even if the API wrongly sent the key during a running test, the screen must not draw it.
    const leaky = attempt({ questions: [{ ...MCQ, correct_option: 0 }, OPEN] });
    const api = new FakeApi({
      getReadinessAttempt: () => leaky,
      saveAttemptAnswer: () => ({ id: ID(81), position: 1 }),
      submitReadinessAttempt: () => ({ id: ID(80), status: 'graded' }),
    });
    renderScreen(<AttemptScreen />, { api, session: as('getReadinessAttempt', 'saveAttemptAnswer', 'submitReadinessAttempt'), ...at });
    await user.click(await screen.findByRole('radio', { name: 'Yearly' }));
    await waitFor(() => expect(api.callsTo('saveAttemptAnswer')[0]?.body).toEqual({ position: 1, chosen_option: 1 }));
    expect(screen.queryByText(/Right answer/)).toBeNull();
    expect(screen.queryByText(/Score/)).toBeNull();
    await user.type(screen.getByLabelText('What do you do if it sticks?'), 'Report it.');
    await user.click(screen.getByRole('button', { name: 'Save this answer' }));
    await waitFor(() => expect(api.callsTo('saveAttemptAnswer')[1]?.body).toEqual({ position: 2, answer_text: 'Report it.' }));
    await user.click(screen.getByRole('button', { name: 'Hand in the test…' }));
    expect(api.callsTo('submitReadinessAttempt')).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Yes, hand it in' }));
    await waitFor(() => expect(api.callsTo('submitReadinessAttempt')).toHaveLength(1));
  });

  it('after grading: shows the score and the key only if the API sent it; only a grader may change a score', async () => {
    const user = userEvent.setup();
    const graded = attempt({
      status: 'graded', submitted_at: T, graded_at: T,
      questions: [{ ...MCQ, chosen_option: 1, final_score: 0, decided_by: 'code', correct_option: 0 }, { ...OPEN, answer_text: 'Report it.', final_score: null }],
    });
    const api = new FakeApi({ getReadinessAttempt: () => graded, overrideQuizAnswer: () => ({ id: ID(82), status: 'graded' }) });
    const first = renderScreen(<AttemptScreen />, { api, session: as('getReadinessAttempt', 'saveAttemptAnswer'), ...at });
    expect(await screen.findByText('Monthly')).toBeTruthy();                       // the key, shown after grading
    expect(screen.getByText('Waiting to be graded by a person')).toBeTruthy();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByRole('button', { name: /Set the score/ })).toBeNull();
    first.unmount();

    renderScreen(<AttemptScreen />, { api, session: as('getReadinessAttempt', 'overrideQuizAnswer'), ...at });
    const card = (await screen.findByText('What do you do if it sticks?')).closest('.card') as HTMLElement;
    // nothing is preselected, and one click changes nothing
    const ask = within(card).getByRole('button', { name: /Set the score/ }) as HTMLButtonElement;
    expect(ask.disabled).toBe(true);
    await user.selectOptions(within(card).getByLabelText('New score'), '0.5');
    await user.click(within(card).getByRole('button', { name: /Set the score/ }));
    expect(api.callsTo('overrideQuizAnswer')).toEqual([]);
    await user.click(within(card).getByRole('button', { name: 'Yes, change the score' }));
    await waitFor(() => expect(api.callsTo('overrideQuizAnswer')[0]).toMatchObject({ path: { answer_id: ID(82) }, body: { score: 0.5 } }));
  });

  it('a state this screen does not know is treated as still running: no answer key, no scores', async () => {
    const odd = attempt({ status: 'under_review' as never, questions: [{ ...MCQ, chosen_option: 1, final_score: 0, decided_by: 'code', correct_option: 0 }] });
    const api = new FakeApi({ getReadinessAttempt: () => odd });
    renderScreen(<AttemptScreen />, { api, session: as('getReadinessAttempt', 'overrideQuizAnswer', 'getReadinessReport'), ...at });
    expect(await screen.findByText('This test is still running')).toBeTruthy();
    expect(screen.queryByText('Right answer')).toBeNull();
    expect(screen.queryByText('Score')).toBeNull();
    expect(screen.queryByRole('button', { name: /Set the score/ })).toBeNull();
  });

  it('a typed answer that is not saved blocks handing in; leaving the field saves it', async () => {
    const user = userEvent.setup();
    const running = attempt({ questions: [{ ...OPEN }] });
    const api = new FakeApi({ getReadinessAttempt: () => running, saveAttemptAnswer: () => ({ position: OPEN.position, saved: true }) as never });
    renderScreen(<AttemptScreen />, { api, session: as('getReadinessAttempt', 'saveAttemptAnswer', 'submitReadinessAttempt'), ...at });
    const box = await screen.findByLabelText(OPEN.stem);
    await user.type(box, 'Stop the boiler.');
    expect(screen.getByText('A typed answer is not saved yet')).toBeTruthy();
    expect((screen.getByRole('button', { name: /Hand in the test/ }) as HTMLButtonElement).disabled).toBe(true);
    await user.tab();                                                                // leaving the field saves
    await waitFor(() => expect(api.callsTo('saveAttemptAnswer')[0]?.body).toEqual({ position: OPEN.position, answer_text: 'Stop the boiler.' }));
    await waitFor(() => expect((screen.getByRole('button', { name: /Hand in the test/ }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByText('Saved.')).toBeTruthy();
    await user.type(box, ' Then call maintenance.');
    expect(screen.queryByText('Saved.')).toBeNull();                                 // "Saved." only while the text is the saved text
  });

  it('the report repeats the service’s statement word for word and names the gaps in the material', async () => {
    const report: KReport = {
      attempt_id: ID(80), learner_person_id: ME, job_role: 'Boiler operator', status: 'graded', started_at: T, submitted_at: T, graded_at: T, bank_size: 3,
      statement: 'This report describes one test. It is not a certificate.',
      topics: [
        { topic_id: ID(70), name: 'Relief valves', score: 0.5, note: null, questions_asked: 2, questions_in_bank: 3, ai_graded: 1, person_graded: 0 },
        { topic_id: ID(73), name: 'Purging', score: null, note: 'not enough questions to score', questions_asked: 0, questions_in_bank: 0, ai_graded: 0, person_graded: 0 },
      ],
      coverage_gaps: [{ topic_id: ID(73), name: 'Purging', gap: 'no released verified knowledge' }],
    };
    renderScreen(<ReportScreen />, { api: new FakeApi({ getReadinessReport: () => report }), session: as('getReadinessReport'), at: `/readiness/reports/${ID(80)}`, route: '/readiness/reports/:attemptId' });
    expect(await screen.findByText('This report describes one test. It is not a certificate.')).toBeTruthy();
    expect(screen.getByText('50 %')).toBeTruthy();
    expect(screen.getByText(/No score — not enough questions to score/)).toBeTruthy();
    expect(screen.getByText(/no verified knowledge for learners/)).toBeTruthy();
  });

  it('question bank: writes drafts from chosen verified items, reports skipped ones, approves, and edits', async () => {
    const user = userEvent.setup();
    const draft: KQuizItem = {
      id: ID(90), topic_id: ID(70), knowledge_item_id: ID(1), kind: 'mcq', stem: 'How often?', options: ['Monthly', 'Yearly', 'Never', 'Daily'], correct_option: 0, rubric: null,
      status: 'draft', approved_at: null, created_at: T,
    };
    const api = new FakeApi({
      listQuizQuestions: () => page([draft]),
      listKnowledgeItems: () => page([{ id: ID(1), title: 'Relief valve test' }, { id: ID(2), title: 'Purge' }] as never[]),
      generateQuizQuestions: () => ({ created: [ID(91)], refused: [{ item_id: ID(2), reason: 'answer_in_stem' }] }),
      approveQuizQuestion: () => ({ id: ID(90), status: 'approved' }),
      editQuizQuestion: () => ({ id: ID(90), status: 'draft' }),
    });
    renderScreen(<QuestionBankScreen />, { api, session: as('listQuizQuestions', 'generateQuizQuestions', 'listKnowledgeItems') });
    await user.click(await screen.findByRole('checkbox', { name: 'Relief valve test' }));
    await user.click(screen.getByRole('checkbox', { name: 'Purge' }));
    await user.click(screen.getByRole('button', { name: 'Write draft questions' }));
    expect(await screen.findByText('1 draft question written')).toBeTruthy();
    expect(screen.getByText(/would have given away its own answer/)).toBeTruthy();
    expect(api.callsTo('generateQuizQuestions')[0]?.body).toEqual({ kind: 'mcq', item_ids: [ID(1), ID(2)] });
    expect(screen.getByText('Monthly — right answer')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(api.callsTo('approveQuizQuestion')[0]?.path).toEqual({ question_id: ID(90) }));
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.clear(screen.getByLabelText('Question'));
    await user.type(screen.getByLabelText('Question'), 'How often is the lever tested?');
    await user.selectOptions(screen.getByLabelText('Which option is right?'), '1');
    await user.click(screen.getByRole('button', { name: 'Save the question' }));
    await waitFor(() => expect(api.callsTo('editQuizQuestion')[0]?.body).toEqual({ stem: 'How often is the lever tested?', options: ['Monthly', 'Yearly', 'Never', 'Daily'], correct_option: 1 }));
  });

  it('a card that may only read the bank gets no buttons', async () => {
    const api = new FakeApi({ listQuizQuestions: () => page([]) });
    renderScreen(<QuestionBankScreen />, { api, session: sessionValue(makeSession(['quiz:read'])) });
    expect(await screen.findByText('No questions here.')).toBeTruthy();
    expect(screen.queryByText('Write draft questions from verified items')).toBeNull();
  });
});

describe('questions between colleagues', () => {
  const question = { id: ID(95), question: 'What if the lever sticks?', expert_person_id: ME, status: 'open', decline_reason: null, answer_item_id: null, created_at: T, answered_at: null, expires_at: '2099-01-01T00:00:00.000Z' };

  it('an expert answers a question sent to them, or declines with a reason', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({
      listExpertQuestions: () => page([question, { ...question, id: ID(96), question: 'Payroll calendar?' }]),
      replyExpertQuestion: () => ({ id: ID(95), status: 'answered', answer_item_id: ID(97) }),
      declineExpertQuestion: () => ({ id: ID(96), status: 'declined' }),
    });
    renderScreen(<QuestionsScreen />, { api, session: as('listExpertQuestions', 'replyExpertQuestion') });
    const first = (await screen.findByText('What if the lever sticks?')).closest('.card') as HTMLElement;
    await user.type(within(first).getByLabelText('Your answer'), 'Tap it gently and report it.');
    await user.click(within(first).getByRole('button', { name: 'Send my answer' }));
    await waitFor(() => expect(api.callsTo('replyExpertQuestion')[0]).toMatchObject({ path: { question_id: ID(95) }, body: { answer: 'Tap it gently and report it.' } }));
    expect(api.callsTo('listExpertQuestions')[0]?.query).toMatchObject({ box: 'addressed' });
    const second = screen.getByText('Payroll calendar?').closest('.card') as HTMLElement;
    await user.click(within(second).getByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(api.callsTo('declineExpertQuestion')[0]).toMatchObject({ path: { question_id: ID(96) }, body: { reason: 'not_my_area' } }));
  });

  it('a card that can only ask sees its own questions and no answer form', async () => {
    const api = new FakeApi({ listExpertQuestions: () => page([{ ...question, status: 'answered', answer_item_id: ID(97) }]) });
    renderScreen(<QuestionsScreen />, { api, session: as('listExpertQuestions', 'getKnowledgeItem') });
    expect(await screen.findByText('Answered')).toBeTruthy();
    expect(api.callsTo('listExpertQuestions')[0]?.query).toMatchObject({ box: 'asked' });
    expect(screen.getByRole('link', { name: 'Read the answer' })).toBeTruthy();
    expect(screen.queryByLabelText('Your answer')).toBeNull();
  });
});
