// Scenario replay (feature 8): reading and changing scenarios and runs, without any markup.
import { useApiList, useApiMutation, useApiQuery } from '../../api/context.tsx';
import type { KScenario, KScenarioAttemptStep, KScenarioWrite } from '../../api/generated.ts';
import type { BadgeTone } from '../../ui/index.tsx';

// What a change makes stale. A scenario's state decides what is offered; a run changes the lists of runs.
const SCENARIOS_CHANGED = ['listScenarios', 'getScenario', 'listOfferedScenarios'] as const;
const RUNS_CHANGED = ['getScenarioAttempt', 'listScenarioAttempts', 'getScenarioAnswer', 'listReviewTasks'] as const;

// ---- writing and approving (reviewers)
export const useScenarioList = () => useApiList('listScenarios', { query: { limit: 50 } });
export const useScenario = (scenarioId: string, { enabled }: { enabled: boolean }) =>
  useApiQuery('getScenario', { path: { scenario_id: scenarioId } }, { enabled });
export const useCreateScenario = () => useApiMutation('createScenario', SCENARIOS_CHANGED);
export const useUpdateScenario = () => useApiMutation('updateScenario', SCENARIOS_CHANGED);
export const useApproveScenario = () => useApiMutation('approveScenario', SCENARIOS_CHANGED);
export const useRetireScenario = () => useApiMutation('retireScenario', [...SCENARIOS_CHANGED, ...RUNS_CHANGED]);
export const useProposeRubric = () => useApiMutation('proposeScenarioRubric');
/** Verified items a step can be tied to, a page at a time. Only the ones released to learners (level 0) can be used. */
export const useVerifiedItems = ({ enabled }: { enabled: boolean }) => useApiList('listKnowledgeItems', { query: { status: 'verified', limit: 50 } }, { enabled });

// ---- running (learners) and results
export const useOffers = () => useApiQuery('listOfferedScenarios');
export const useStartRun = () => useApiMutation('startScenarioAttempt', RUNS_CHANGED);
export const useRunList = ({ enabled }: { enabled: boolean }) => useApiList('listScenarioAttempts', { query: { limit: 25 } }, { enabled });
export const useRun = (attemptId: string) => useApiQuery('getScenarioAttempt', { path: { scenario_attempt_id: attemptId } });
export const useSaveStepAnswer = () => useApiMutation('saveScenarioAnswer', ['getScenarioAttempt']);
export const useSubmitRun = () => useApiMutation('submitScenarioAttempt', RUNS_CHANGED);
export const useOverrideStep = () => useApiMutation('overrideScenarioAnswer', RUNS_CHANGED);
/** One step as the person who grades it reads it: the question, the learner's words, the expected points. */
export const useStepForGrading = (answerId: string) => useApiQuery('getScenarioAnswer', { path: { scenario_answer_id: answerId } });
/** Shown where the retention period has removed what a learner wrote. */
export const DETAILS_REMOVED_TEXT = 'Removed after the retention period. The score is kept; the words are not.';

export const SCENARIO_STATUS_TEXT: Readonly<Record<string, string>> = {
  draft: 'Draft — waiting for a second person to approve it',
  approved: 'Approved — learners can run it',
  retired: 'Retired',
};
export const scenarioTone = (status: string): BadgeTone => (status === 'approved' ? 'success' : status === 'retired' ? 'neutral' : 'warning');
export const FLAG_TEXT: Readonly<Record<string, string>> = {
  item_changed: 'A linked knowledge item is no longer verified, so this scenario was taken out of use. Check it and have it approved again.',
  item_withdrawn: 'A linked knowledge item was withdrawn by its contributor. The scenario was retired and the texts tied to that item were erased.',
};

export const RUN_STATUS_TEXT: Readonly<Record<string, string>> = {
  in_progress: 'In progress',
  submitted: 'Handed in — a step is still waiting to be graded by a person',
  graded: 'Graded',
  expired: 'Ended before it was handed in',
};
/** The states in which a run is over. ONLY in these may anything about scores or expected points be drawn; any
 *  other state - including one this screen does not know - is treated as "still running". */
const FINISHED_RUN_STATES: ReadonlySet<string> = new Set(['submitted', 'graded', 'expired']);
export const isFinishedRun = (status: string): boolean => FINISHED_RUN_STATES.has(status);
export const runTone = (status: string): BadgeTone => (status === 'graded' ? 'success' : status === 'expired' ? 'danger' : status === 'submitted' ? 'warning' : 'info');
export const percent = (score: number | null | undefined): string => (score === null || score === undefined ? '—' : `${Math.round(score * 100)} %`);

/** What the view of a RUNNING scenario may see of a step: its prompt and the learner's own text. Nothing else. */
export type RunningStep = Pick<KScenarioAttemptStep, 'answer_id' | 'position' | 'prompt' | 'answer_text'>;

// ---- the editor's draft (pure, so its rules are tested without a screen)
export const MAX_STEPS = 10;
export const MAX_POINTS = 6;
export const MAX_ITEMS_PER_STEP = 5;

export interface StepDraft {
  /** A name for this step that stays the same while the draft is edited (its place changes when a step is removed). */
  key: number;
  prompt: string;
  itemIds: string[];
  /** The expected points, one per line. */
  points: string;
}
export interface ScenarioDraft {
  title: string;
  situation: string;
  jobRole: string;
  steps: StepDraft[];
}

let nextStepKey = 1;
export const emptyStep = (): StepDraft => ({ key: nextStepKey++, prompt: '', itemIds: [], points: '' });
export const emptyDraft = (): ScenarioDraft => ({ title: '', situation: '', jobRole: '', steps: [emptyStep()] });

export const pointsOf = (text: string): string[] => text.split('\n').map((p) => p.trim()).filter((p) => p !== '');

export function draftOf(scenario: KScenario): ScenarioDraft {
  return {
    title: scenario.title, situation: scenario.situation, jobRole: scenario.job_role,
    steps: scenario.steps.map((s) => ({ key: nextStepKey++, prompt: s.prompt, itemIds: s.items.map((i) => i.id), points: s.rubric.join('\n') })),
  };
}

const plain = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * What is wrong with a draft, in the words shown to the writer; empty = it can be sent. The API checks all of this
 * again (and more: that the items are verified, released and readable by the writer).
 */
export function draftProblems(draft: ScenarioDraft): string[] {
  const problems: string[] = [];
  if (draft.title.trim() === '') problems.push('Give the scenario a title.');
  if (draft.situation.trim() === '') problems.push('Describe the situation.');
  if (draft.jobRole.trim() === '') problems.push('Name the job role the scenario is for.');
  if (draft.steps.length === 0) problems.push('Add at least one step.');
  const shown = plain([draft.title, draft.situation, ...draft.steps.map((s) => s.prompt)].join(' '));
  draft.steps.forEach((step, index) => {
    const n = index + 1;
    const points = pointsOf(step.points);
    if (step.prompt.trim() === '') problems.push(`Step ${n}: write the question the learner is asked.`);
    if (step.itemIds.length === 0) problems.push(`Step ${n}: tie it to at least one verified knowledge item.`);
    if (step.itemIds.length > MAX_ITEMS_PER_STEP) problems.push(`Step ${n}: at most ${MAX_ITEMS_PER_STEP} items.`);
    if (points.length === 0) problems.push(`Step ${n}: write at least one expected point.`);
    if (points.length > MAX_POINTS) problems.push(`Step ${n}: at most ${MAX_POINTS} expected points.`);
    if (new Set(points.map(plain)).size !== points.length) problems.push(`Step ${n}: two expected points say the same thing. Each point must be different.`);
    // the answer-leak guard, as the API applies it: a learner must not be able to read an expected point
    if (points.some((p) => plain(p) !== '' && shown.includes(plain(p)))) {
      problems.push(`Step ${n}: an expected point appears word for word in the title, the situation or a question. That would give the answer away.`);
    }
  });
  return problems;
}

/** `readVersion`: for an edit, the `updated_at` of the scenario as it was read, so a change by somebody else is noticed. */
export function bodyOf(draft: ScenarioDraft, readVersion?: string): KScenarioWrite {
  return {
    title: draft.title.trim(), situation: draft.situation.trim(), job_role: draft.jobRole.trim(),
    steps: draft.steps.map((s) => ({ prompt: s.prompt.trim(), item_ids: s.itemIds, rubric: pointsOf(s.points) })),
    ...(readVersion === undefined ? {} : { updated_at: readVersion }),
  };
}

/** The API's refusals when a scenario is written or approved, in plain words. */
export const WRITE_REFUSALS: Readonly<Record<string, string>> = {
  'second-person-needed': 'A second person must do this: whoever created a scenario or last changed its text cannot approve it.',
  'changed-meanwhile': 'Somebody else changed this scenario after you opened it. Nothing was saved or approved. Reload the page to see the current text; what you typed is still in the form until you do.',
  'own-attempt': 'This is your own run: its score must be set by somebody else.',
  'item-not-released': 'A linked knowledge item is not verified and released to learners (any more). Choose another item or have it verified first.',
  'has-attempts': 'This scenario has already been run, so it can no longer be changed. Retire it and write a new one.',
  'illegal-transition': 'The scenario is not in a state that allows this.',
};
