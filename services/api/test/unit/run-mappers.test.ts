// What the API passes on of a scenario run and of a readiness attempt is the API's own rule: it does not forward a
// score, an expected point or a correct option just because the AI service's answer contained one.
import { describe, expect, it } from 'vitest';
import { runSteps } from '../../src/modules/knowledge-gateway/internal/routes-scenarios.ts';
import { attemptQuestions } from '../../src/modules/knowledge-gateway/internal/routes-workflow.ts';

const hostileStep = {
  answer_id: 'a1', position: 1, prompt: 'What do you do first?', answer_text: 'I stop the filler.', final_score: 1, decided_by: 'ai',
  graded_with_low_confidence: false, points: [{ text: 'Stop the filler', met: true }], read_these: [{ id: 'i1', title: 'Filler stop' }],
  rubric: ['Stop the filler'], ai_rubric_result: [{ point: 0, met: true }], secret: 'x',
};
const LEAKS = ['points', 'read_these', 'final_score', 'decided_by', 'graded_with_low_confidence', 'rubric', 'ai_rubric_result', 'secret'];

describe('scenario run steps', () => {
  it.each(['in_progress', 'expired', 'submitted', 'something_new', undefined])('status %s: only the question and the own answer, whatever arrived', (status) => {
    const [step] = runSteps({ status, scores_released: true, points_released: true, steps: [hostileStep] });
    expect(Object.keys(step ?? {}).sort()).toEqual(['answer_id', 'answer_text', 'position', 'prompt']);
    for (const key of LEAKS) expect(step).not.toHaveProperty(key);
  });

  it('graded, but the AI service did not say it released anything: nothing more', () => {
    const [step] = runSteps({ status: 'graded', steps: [hostileStep] });
    for (const key of LEAKS) expect(step).not.toHaveProperty(key);
  });

  it('graded and scores released, points not: scores, but no expected point and no "read these"', () => {
    const [step] = runSteps({ status: 'graded', scores_released: true, points_released: false, steps: [hostileStep] });
    expect(step).toMatchObject({ final_score: 1, decided_by: 'ai', graded_with_low_confidence: false });
    expect(step).not.toHaveProperty('points');
    expect(step).not.toHaveProperty('read_these');
  });

  it('points released without scores released is not a state: nothing is added', () => {
    const [step] = runSteps({ status: 'graded', scores_released: false, points_released: true, steps: [hostileStep] });
    for (const key of LEAKS) expect(step).not.toHaveProperty(key);
  });

  it('graded and everything released: points and "read these" with only their named fields', () => {
    const [step] = runSteps({ status: 'graded', scores_released: true, points_released: true, steps: [{ ...hostileStep, details_removed: true }] });
    expect(step).toMatchObject({ points: [{ text: 'Stop the filler', met: true }], read_these: [{ id: 'i1', title: 'Filler stop' }], details_removed: true });
    for (const key of ['rubric', 'ai_rubric_result', 'secret']) expect(step).not.toHaveProperty(key);
  });

  it('no steps, or something that is not a list, gives an empty list', () => {
    expect(runSteps({ status: 'graded', steps: 'x' })).toEqual([]);
    expect(runSteps(undefined)).toEqual([]);
  });
});

describe('readiness attempt questions', () => {
  const hostileQuestion = { answer_id: 'q1', position: 1, kind: 'mcq', stem: 'Which?', options: ['a', 'b'], chosen_option: 0, answer_text: null, final_score: 1, decided_by: 'auto', correct_option: 1, rubric: ['x'] };

  it.each(['in_progress', 'expired', 'submitted', 'something_new'])('status %s: no score and no correct option, whatever arrived', (status) => {
    const [q] = attemptQuestions({ status, answers_released: true, questions: [hostileQuestion] });
    expect(q?.final_score).toBeNull();
    expect(q).not.toHaveProperty('correct_option');
    expect(q).not.toHaveProperty('rubric');
  });

  it('graded: the score; the correct option only when the AI service says the answers were released', () => {
    const [kept] = attemptQuestions({ status: 'graded', questions: [hostileQuestion] });
    expect(kept?.final_score).toBe(1);
    expect(kept).not.toHaveProperty('correct_option');
    const [shown] = attemptQuestions({ status: 'graded', answers_released: true, questions: [hostileQuestion] });
    expect(shown?.correct_option).toBe(1);
    expect(shown).not.toHaveProperty('rubric');
  });
});
