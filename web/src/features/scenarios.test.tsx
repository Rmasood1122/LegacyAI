// Scenario replay (feature 8): the rules of the editor's draft, and the main states of the four screens, with a
// stand-in API. Synthetic data only.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client.ts';
import type { KScenario, KScenarioAttempt, KScenarioAttemptStep } from '../api/generated.ts';
import { FakeApi, makeSession, permissionsFor, renderScreen, sessionValue } from '../test/harness.tsx';
import { bodyOf, draftOf, draftProblems, emptyDraft, pointsOf, type ScenarioDraft } from './scenarios/hooks.ts';
import { ScenarioBankScreen, ScenarioEditScreen } from './scenarios/ScenarioBankScreen.tsx';
import { ScenarioGradeScreen } from './scenarios/ScenarioGradeScreen.tsx';
import { ScenarioRunScreen } from './scenarios/ScenarioRunScreen.tsx';
import { ScenariosScreen } from './scenarios/ScenariosScreen.tsx';

const ID = (n: number): string => `01a10174-0000-7000-8000-${String(n).padStart(12, '0')}`;
const ME = '01a10174-0000-7000-8000-0000000000b1';   // the person of the test session (test/harness.tsx)
const T = '2026-10-01T09:00:00.000Z';
const page = <X,>(items: X[]) => ({ items, next_cursor: null });
const as = (...ops: Parameters<typeof permissionsFor>) => sessionValue(makeSession(permissionsFor(...ops)));
const POINT = 'Stop the filler at once';

const good: ScenarioDraft = {
  title: 'A dripping filling valve', situation: 'During the night shift a filling valve begins to drip.', jobRole: 'Filler operator',
  steps: [{ key: 1, prompt: 'What do you do first?', itemIds: [ID(1)], points: `${POINT}\n  \nLook at the valve` }],
};

describe('the draft of a scenario (rules without a screen)', () => {
  it('an empty draft says what is missing; a complete one has nothing to say', () => {
    const problems = draftProblems(emptyDraft());
    expect(problems).toContain('Give the scenario a title.');
    expect(problems).toContain('Step 1: tie it to at least one verified knowledge item.');
    expect(problems).toContain('Step 1: write at least one expected point.');
    expect(draftProblems(good)).toEqual([]);
  });

  it('an expected point that the learner could read - in the title, the situation or ANY question - is refused', () => {
    const leak = 'Step 1: an expected point appears word for word in the title, the situation or a question. That would give the answer away.';
    expect(draftProblems({ ...good, situation: 'A valve drips and you STOP the  filler at once.' })).toEqual([leak]);
    expect(draftProblems({ ...good, title: 'Stop the filler at once!' })).toEqual([leak]);
    expect(draftProblems({ ...good, steps: [...good.steps, { key: 2, prompt: 'After you stop the filler at once, what next?', itemIds: [ID(2)], points: 'Phone maintenance' }] })).toEqual([leak]);
  });

  it('limits: at most 6 points and 5 items per step', () => {
    const many = { key: 1, prompt: 'What do you do first?', points: Array.from({ length: 7 }, (_, i) => `Point number ${i}`).join('\n'), itemIds: [1, 2, 3, 4, 5, 6].map(ID) };
    expect(draftProblems({ ...good, steps: [many] })).toEqual(['Step 1: at most 5 items.', 'Step 1: at most 6 expected points.']);
    // two points that say the same thing (case and spacing do not make them different)
    expect(draftProblems({ ...good, steps: [{ ...many, itemIds: [ID(1)], points: ['Stop the filler', 'stop the  FILLER'].join(String.fromCharCode(10)) }] }))
      .toEqual(['Step 1: two expected points say the same thing. Each point must be different.']);
  });

  it('what is sent: trimmed text, one point per non-empty line; a stored scenario turns back into the same draft', () => {
    expect(pointsOf(' a \n\n b ')).toEqual(['a', 'b']);
    const body = bodyOf(good);
    expect(body).toEqual({
      title: 'A dripping filling valve', situation: 'During the night shift a filling valve begins to drip.', job_role: 'Filler operator',
      steps: [{ prompt: 'What do you do first?', item_ids: [ID(1)], rubric: [POINT, 'Look at the valve'] }],
    });
    const stored = scenario({ steps: [{ position: 1, prompt: 'What do you do first?', erased: false, rubric: [POINT, 'Look at the valve'], items: [{ id: ID(1), title: 'x', status: 'verified' }] }] });
    expect(bodyOf(draftOf(stored))).toEqual({ ...body, title: stored.title, situation: stored.situation, job_role: stored.job_role });
  });
});

function scenario(over: Partial<KScenario> = {}): KScenario {
  return {
    id: ID(70), title: 'A dripping filling valve', job_role: 'Filler operator', status: 'draft', flag_reason: null, written_by_me: false, created_at: T,
    updated_at: T, approved_at: null, situation: 'A filling valve begins to drip.', has_attempts: false,
    steps: [{ position: 1, prompt: 'What do you do first?', erased: false, rubric: [POINT], items: [{ id: ID(1), title: 'Dripping valve: first action', status: 'verified' }] }],
    ...over,
  };
}

function run(over: Partial<KScenarioAttempt> = {}, steps: KScenarioAttemptStep[] = [{ answer_id: ID(91), position: 1, prompt: 'What do you do first?', answer_text: null }]): KScenarioAttempt {
  return {
    id: ID(80), scenario_id: ID(70), title: 'A dripping filling valve', situation: 'A filling valve begins to drip.', job_role: 'Filler operator',
    learner_person_id: ME, status: 'in_progress', started_at: T, expires_at: T, submitted_at: null, graded_at: null, steps, ...over,
  };
}
const runAt = { at: `/scenarios/runs/${ID(80)}`, route: '/scenarios/runs/:attemptId' };

describe('scenarios for a learner', () => {
  it('lists what is offered, starts a run, and lists the runs so far', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({
      listOfferedScenarios: () => ({ items: [{ id: ID(70), title: 'A dripping filling valve', situation: 'A filling valve begins to drip.', job_role: 'Filler operator', step_count: 2 }], truncated: false }),
      listScenarioAttempts: () => page([{ id: ID(80), scenario_id: ID(70), title: 'A dripping filling valve', job_role: 'Filler operator', learner_person_id: ME, status: 'graded' as const, started_at: T, submitted_at: T, graded_at: T }]),
      startScenarioAttempt: () => ({ id: ID(81), scenario_id: ID(70), title: 'A dripping filling valve', situation: 'x', expires_at: T, steps: [] }),
    });
    renderScreen(<ScenariosScreen />, { api, session: as('listOfferedScenarios', 'startScenarioAttempt', 'listScenarioAttempts', 'getScenarioAttempt') });
    expect(await screen.findByText('For: Filler operator · 2 steps')).toBeTruthy();
    expect(within(await screen.findByRole('table', { name: 'Scenario runs' })).getByRole('link', { name: 'Result' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Start: A dripping filling valve' }));
    await waitFor(() => expect(api.callsTo('startScenarioAttempt')[0]?.path).toEqual({ scenario_id: ID(70) }));
  });

  it('says so when nothing is offered', async () => {
    const api = new FakeApi({ listOfferedScenarios: () => ({ items: [], truncated: false }) });
    renderScreen(<ScenariosScreen />, { api, session: as('listOfferedScenarios') });
    expect(await screen.findByText('No scenario is offered to you at the moment.')).toBeTruthy();
  });
});

describe('one run', () => {
  it('while it runs, nothing about expected points, scores or linked items is drawn - even if the API sent them', async () => {
    const leaky = [{
      answer_id: ID(91), position: 1, prompt: 'What do you do first?', answer_text: null, final_score: 1, decided_by: 'ai' as const,
      points: [{ text: 'LEAKED POINT', met: true }], read_these: [{ id: ID(1), title: 'LEAKED TITLE' }],
    }];
    const api = new FakeApi({ getScenarioAttempt: () => run({}, leaky) });
    const view = renderScreen(<ScenarioRunScreen />, { api, session: as('getScenarioAttempt', 'saveScenarioAnswer', 'submitScenarioAttempt', 'overrideScenarioAnswer'), ...runAt });
    expect(await screen.findByLabelText('What do you do first?')).toBeTruthy();
    expect(view.container.textContent).not.toMatch(/LEAKED|Expected points|100 %|Graded by/);
    expect(screen.queryByText('New score')).toBeNull();
  });

  it('an unknown state is treated as still running: no scores are drawn', async () => {
    const api = new FakeApi({ getScenarioAttempt: () => run({ status: 'some_new_state' as never, learner_person_id: ID(5) }, [
      { answer_id: ID(91), position: 1, prompt: 'What do you do first?', answer_text: 'x', final_score: 1, decided_by: 'ai', points: [{ text: 'LEAKED POINT', met: true }] }]) });
    const view = renderScreen(<ScenarioRunScreen />, { api, session: as('getScenarioAttempt', 'overrideScenarioAnswer'), ...runAt });
    expect(await screen.findByText('This run is still in progress')).toBeTruthy();
    expect(view.container.textContent).not.toMatch(/LEAKED|100 %/);
  });

  it('saves a typed answer when its field is left; handing in waits for unsaved text and needs a second click', async () => {
    const user = userEvent.setup();
    let fail = true;
    const api = new FakeApi({
      getScenarioAttempt: () => run({}, [{ answer_id: ID(91), position: 1, prompt: 'What do you do first?', answer_text: null }, { answer_id: ID(92), position: 2, prompt: 'Who do you tell?', answer_text: null }]),
      saveScenarioAnswer: () => { if (fail) throw new ApiError('unavailable', 502, 'The service is busy'); return { id: ID(80), position: 1 }; },
      submitScenarioAttempt: () => ({ id: ID(80), status: 'graded' }),
    });
    renderScreen(<ScenarioRunScreen />, { api, session: as('getScenarioAttempt', 'saveScenarioAnswer', 'submitScenarioAttempt'), ...runAt });
    await user.type(await screen.findByLabelText('What do you do first?'), 'I stop the filler.');
    await user.click(screen.getByRole('button', { name: 'Next step' }));          // leaving the field sends it - and the send fails
    expect(await screen.findByText('An answer is not saved yet')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Hand in…' }) as HTMLButtonElement).disabled).toBe(true);
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Previous step' }));
    await user.click(screen.getByRole('button', { name: 'Save this answer' }));
    await waitFor(() => expect(screen.queryByText('An answer is not saved yet')).toBeNull());
    expect(api.callsTo('saveScenarioAnswer').at(-1)).toMatchObject({ path: { scenario_attempt_id: ID(80) }, body: { position: 1, answer_text: 'I stop the filler.' } });
    await user.click(screen.getByRole('button', { name: 'Hand in…' }));
    expect(api.callsTo('submitScenarioAttempt')).toEqual([]);                      // nothing is sent before the second button
    await user.click(screen.getByRole('button', { name: 'Yes, hand it in' }));
    await waitFor(() => expect(api.callsTo('submitScenarioAttempt')[0]?.path).toEqual({ scenario_attempt_id: ID(80) }));
  });

  it('after hand-in the learner sees scores and what to read again; without points unless the API sent them; no override of the own run', async () => {
    const graded = run({ status: 'graded', submitted_at: T, graded_at: T }, [
      { answer_id: ID(91), position: 1, prompt: 'What do you do first?', answer_text: 'I stop the filler.', final_score: 1, decided_by: 'ai', graded_with_low_confidence: false,
        read_these: [{ id: ID(1), title: 'Dripping valve: first action' }] },
      { answer_id: ID(92), position: 2, prompt: 'Who do you tell?', answer_text: null, final_score: 0, decided_by: 'auto', graded_with_low_confidence: false, read_these: [] },
    ]);
    const api = new FakeApi({ getScenarioAttempt: () => graded });
    renderScreen(<ScenarioRunScreen />, { api, session: as('getScenarioAttempt', 'getKnowledgeItem', 'overrideScenarioAnswer'), ...runAt });
    expect(await screen.findByText('100 %')).toBeTruthy();
    expect(screen.getByText('No answer was given')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Dripping valve: first action' })).toBeTruthy();
    expect(screen.queryByText('Expected points')).toBeNull();
    expect(screen.queryByText('New score')).toBeNull();                             // it is the learner's own run
  });

  it('a reader of results sees the expected points of a GRADED run of somebody else and changes a score only after a second click', async () => {
    const user = userEvent.setup();
    const theirs = run({ status: 'graded', submitted_at: T, graded_at: T, learner_person_id: ID(5) }, [
      { answer_id: ID(91), position: 1, prompt: 'What do you do first?', answer_text: 'I wait.', final_score: 0, decided_by: 'ai', graded_with_low_confidence: true,
        read_these: [], points: [{ text: POINT, met: false }] }]);
    const api = new FakeApi({ getScenarioAttempt: () => theirs, overrideScenarioAnswer: () => ({ id: ID(80), status: 'graded' }) });
    renderScreen(<ScenarioRunScreen />, { api, session: as('getScenarioAttempt', 'overrideScenarioAnswer'), ...runAt });
    expect(await screen.findByText(`${POINT} — not found in the answer`)).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('New score'), '0.5');
    await user.click(screen.getByRole('button', { name: 'Set the score…' }));
    expect(api.callsTo('overrideScenarioAnswer')).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Yes, change the score' }));
    await waitFor(() => expect(api.callsTo('overrideScenarioAnswer')[0]).toMatchObject({ path: { scenario_answer_id: ID(91) }, body: { score: 0.5 } }));
  });

  it('a run that waits for a person or expired shows no score and no score control; a waiting step links to its grading screen', async () => {
    const waiting = run({ status: 'submitted', submitted_at: T, learner_person_id: ID(5) }, [
      { answer_id: ID(91), position: 1, prompt: 'What do you do first?', answer_text: 'I wait.' }]);
    const api = new FakeApi({ getScenarioAttempt: () => waiting });
    const view = renderScreen(<ScenarioRunScreen />, { api, session: as('getScenarioAttempt', 'overrideScenarioAnswer', 'getScenarioAnswer'), ...runAt });
    expect(await screen.findByText('Shown once every step is graded. A step is waiting for a person.')).toBeTruthy();
    expect(screen.queryByText('New score')).toBeNull();
    expect(screen.getByRole('link', { name: 'Read this step and set its score' }).getAttribute('href')).toBe(`/scenarios/grade/${ID(91)}`);
    view.unmount();

    const expired = run({ status: 'expired' }, [{ answer_id: ID(91), position: 1, prompt: 'What do you do first?', answer_text: 'half an answer' }]);
    renderScreen(<ScenarioRunScreen />, { api: new FakeApi({ getScenarioAttempt: () => expired }), session: as('getScenarioAttempt'), ...runAt });
    expect(await screen.findByText('Not graded: the run ended before it was handed in.')).toBeTruthy();
    expect(screen.queryByText('Expected points')).toBeNull();
  });

  it('says so where the retention period removed what the learner wrote, instead of showing an empty answer', async () => {
    const old = run({ status: 'graded', submitted_at: T, graded_at: T }, [
      { answer_id: ID(91), position: 1, prompt: 'What do you do first?', answer_text: null, details_removed: true, final_score: 1, decided_by: 'ai', graded_with_low_confidence: false }]);
    renderScreen(<ScenarioRunScreen />, { api: new FakeApi({ getScenarioAttempt: () => old }), session: as('getScenarioAttempt'), ...runAt });
    expect(await screen.findByText('Removed after the retention period. The score is kept; the words are not.')).toBeTruthy();
    expect(screen.getByText('100 %')).toBeTruthy();
    expect(screen.queryByText('No answer')).toBeNull();
  });
});

describe('grading one step (nobody grades blind)', () => {
  const gradeAt = { at: `/scenarios/grade/${ID(91)}`, route: '/scenarios/grade/:answerId' };
  const step = {
    id: ID(91), attempt_id: ID(80), scenario_title: 'A dripping filling valve', position: 1, prompt: 'What do you do first?', answer_text: 'I stop the filler at once.',
    awaiting_person: true, details_removed: false, final_score: null, decided_by: null, ai_score: null, ai_confidence: null, points: [{ text: POINT, met: null }],
  };

  it('shows the question, what the learner wrote and the expected points, and sets the score after a second click', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({ getScenarioAnswer: () => step, overrideScenarioAnswer: () => ({ id: ID(80), status: 'graded' }) });
    renderScreen(<ScenarioGradeScreen />, { api, session: as('getScenarioAnswer', 'overrideScenarioAnswer'), ...gradeAt });
    expect(await screen.findByText('I stop the filler at once.')).toBeTruthy();
    expect(screen.getByText(POINT)).toBeTruthy();
    expect(screen.getByText('Waiting to be graded by a person')).toBeTruthy();
    expect(api.callsTo('getScenarioAnswer')[0]?.path).toEqual({ scenario_answer_id: ID(91) });
    await user.selectOptions(screen.getByLabelText('New score'), '1');
    await user.click(screen.getByRole('button', { name: 'Set the score…' }));
    expect(api.callsTo('overrideScenarioAnswer')).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Yes, change the score' }));
    await waitFor(() => expect(api.callsTo('overrideScenarioAnswer')[0]).toMatchObject({ path: { scenario_answer_id: ID(91) }, body: { score: 1 } }));
  });

  it('a refused read is explained in plain words (reading a step and setting its score need the same right, so there is no read-only view)', async () => {
    const own = new FakeApi({ getScenarioAnswer: () => { throw new ApiError('conflict', 409, 'Conflict', { type: 'urn:legacyai:problem:own-attempt' }); } });
    renderScreen(<ScenarioGradeScreen />, { api: own, session: as('getScenarioAnswer', 'overrideScenarioAnswer'), ...gradeAt });
    expect(await screen.findByText('This is your own run: its score must be set by somebody else.')).toBeTruthy();
  });
});

describe('writing and approving scenarios', () => {
  const item = { id: ID(1), title: 'Dripping valve: first action', status: 'verified', origin: 'manual', ai_extracted: false, department_id: null, sensitivity: 0,
    owner_person_id: null, usage_count: 0, verified_at: T, stale_after: null, updated_at: T };
  const editAt = (id: string) => ({ at: `/scenario-writing/${id}`, route: '/scenario-writing/:scenarioId' });

  it('the list shows state and what needs attention', async () => {
    const api = new FakeApi({ listScenarios: () => page([
      { id: ID(70), title: 'A dripping filling valve', job_role: 'Filler operator', status: 'draft' as const, flag_reason: 'item_changed' as const, written_by_me: false, created_at: T, updated_at: T, approved_at: null, step_count: 2 },
    ]) });
    renderScreen(<ScenarioBankScreen />, { api, session: as('listScenarios', 'getScenario', 'createScenario') });
    expect(await screen.findByRole('link', { name: 'A dripping filling valve' })).toBeTruthy();
    expect(screen.getByText('Needs attention')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Write a new scenario' })).toBeTruthy();
  });

  it('a new scenario: says what is missing, offers only items released to learners, and sends the draft', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({
      listKnowledgeItems: () => page([item, { ...item, id: ID(2), title: 'Internal price list', sensitivity: 1 }]),
      createScenario: () => ({ id: ID(70), status: 'draft' }),
    });
    renderScreen(<ScenarioEditScreen />, { api, session: as('createScenario', 'listKnowledgeItems', 'getScenario'), ...editAt('new') });
    await user.click(screen.getByRole('button', { name: 'Save as a draft' }));
    expect(await screen.findByText('Not ready to save')).toBeTruthy();
    expect(api.callsTo('createScenario')).toEqual([]);
    await user.type(screen.getByLabelText('Title'), 'A dripping filling valve');
    await user.type(screen.getByLabelText('The situation'), 'A filling valve begins to drip.');
    await user.type(screen.getByLabelText('For which job role?'), 'Filler operator');
    await user.type(screen.getByLabelText('What the learner is asked'), 'What do you do first?');
    await user.click(await screen.findByRole('checkbox', { name: 'Dripping valve: first action' }));
    expect(screen.queryByRole('checkbox', { name: 'Internal price list' })).toBeNull();          // not released to learners
    await user.type(screen.getByLabelText('Expected points, one per line'), POINT);
    await user.click(screen.getByRole('button', { name: 'Save as a draft' }));
    await waitFor(() => expect(api.callsTo('createScenario')[0]?.body).toEqual({
      title: 'A dripping filling valve', situation: 'A filling valve begins to drip.', job_role: 'Filler operator',
      steps: [{ prompt: 'What do you do first?', item_ids: [ID(1)], rubric: [POINT] }],
    }));
  }, 20_000);   // a long form with much typing: close to the default 5 s on a slow machine

  it('the author of the current text gets no approve button; another reviewer approves after a second click', async () => {
    const user = userEvent.setup();
    const own = new FakeApi({ getScenario: () => scenario({ written_by_me: true }), listKnowledgeItems: () => page([item]) });
    const first = renderScreen(<ScenarioEditScreen />, { api: own, session: as('getScenario', 'approveScenario', 'retireScenario', 'updateScenario', 'listKnowledgeItems'), ...editAt(ID(70)) });
    expect(await screen.findByText('A second person approves it')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve…' })).toBeNull();
    first.unmount();
    const api = new FakeApi({ getScenario: () => scenario(), approveScenario: () => ({ id: ID(70), status: 'approved' }), listKnowledgeItems: () => page([item]) });
    renderScreen(<ScenarioEditScreen />, { api, session: as('getScenario', 'approveScenario', 'listKnowledgeItems'), ...editAt(ID(70)) });
    await user.click(await screen.findByRole('button', { name: 'Approve…' }));
    expect(api.callsTo('approveScenario')).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Yes, learners may run it' }));
    await waitFor(() => expect(api.callsTo('approveScenario')[0]?.path).toEqual({ scenario_id: ID(70) }));
    // the approval names the version that was read, so a change made meanwhile by somebody else is not approved unseen
    expect(api.callsTo('approveScenario')[0]?.body).toEqual({ updated_at: T });
  });

  it('explains the API\'s refusals in plain words, and shows a run scenario read-only', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({
      getScenario: () => scenario({ has_attempts: true, status: 'approved', approved_at: T }),
      retireScenario: () => { throw new ApiError('conflict', 409, 'illegal transition', { type: 'urn:legacyai:problem:illegal-transition' }); },
    });
    renderScreen(<ScenarioEditScreen />, { api, session: as('getScenario', 'retireScenario', 'updateScenario', 'getKnowledgeItem'), ...editAt(ID(70)) });
    expect(await screen.findByText('It has been run')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save the changes' })).toBeNull();               // no form: it can no longer be changed
    expect(screen.getByText(POINT)).toBeTruthy();                                                // a reviewer reads the expected points
    await user.click(screen.getByRole('button', { name: 'Retire for good…' }));
    await user.click(screen.getByRole('button', { name: 'Yes, retire it' }));
    expect(await screen.findByText('The scenario is not in a state that allows this.')).toBeTruthy();
  });

  it('an erased step is shown as erased', async () => {
    const api = new FakeApi({ getScenario: () => scenario({ status: 'retired', flag_reason: 'item_withdrawn', situation: '', steps: [{ position: 1, prompt: '', erased: true, rubric: [], items: [] }] }) });
    renderScreen(<ScenarioEditScreen />, { api, session: as('getScenario'), ...editAt(ID(70)) });
    expect(await screen.findByText('The text of this step was erased because a linked item was withdrawn.')).toBeTruthy();
    expect(screen.getByText(/retired and the texts tied to that item were erased/)).toBeTruthy();
  });
});
