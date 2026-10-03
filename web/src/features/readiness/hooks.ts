// Readiness tests: reading and changing them, without any markup.
import { useApiList, useApiMutation, useApiQuery } from '../../api/context.tsx';
import type { BadgeTone } from '../../ui/index.tsx';

const ATTEMPT_CHANGED = ['getReadinessAttempt', 'getReadinessReport'] as const;
const BANK_CHANGED = ['listQuizQuestions', 'listReviewTasks'] as const;

export const useStartAttempt = () => useApiMutation('startReadinessAttempt');
export const useAttempt = (attemptId: string) => useApiQuery('getReadinessAttempt', { path: { attempt_id: attemptId } });
export const useSaveAnswer = () => useApiMutation('saveAttemptAnswer', ['getReadinessAttempt']);
export const useSubmitAttempt = () => useApiMutation('submitReadinessAttempt', ATTEMPT_CHANGED);
export const useOverrideAnswer = () => useApiMutation('overrideQuizAnswer', ATTEMPT_CHANGED);
export const useReport = (attemptId: string) => useApiQuery('getReadinessReport', { path: { attempt_id: attemptId } });

/** Tests taken, newest first: a learner gets its own, people who may read results the company's. */
export const useAttemptList = () => useApiList('listReadinessAttempts', { query: { limit: 25 } });
/** Job roles that have topics the card may read, to choose from when starting a test. */
export const useJobRoleChoices = ({ enabled }: { enabled: boolean }) => useApiList('listJobRoles', { query: { limit: 50 } }, { enabled });

export type QuestionStatus = 'draft' | 'approved' | 'retired';
export const useQuestionList = (status: QuestionStatus) => useApiList('listQuizQuestions', { query: { status, limit: 50 } });
export const useGenerateQuestions = () => useApiMutation('generateQuizQuestions', BANK_CHANGED);
export const useEditQuestion = () => useApiMutation('editQuizQuestion', BANK_CHANGED);
export const useApproveQuestion = () => useApiMutation('approveQuizQuestion', BANK_CHANGED);
export const useRetireQuestion = () => useApiMutation('retireQuizQuestion', BANK_CHANGED);
/** Verified items a question can be written from, a page at a time. */
export const useVerifiedItems = ({ enabled }: { enabled: boolean }) => useApiList('listKnowledgeItems', { query: { status: 'verified', limit: 50 } }, { enabled });

export const ATTEMPT_STATUS_TEXT: Readonly<Record<string, string>> = {
  in_progress: 'In progress',
  submitted: 'Handed in — some answers are still waiting to be graded',
  graded: 'Graded',
  expired: 'Ran out of time before it was handed in',
};
/** The states in which a test is over. ONLY in these may anything about right answers or scores be drawn; any other
 *  state - including one this screen does not know - is treated as "still running". */
const FINISHED_ATTEMPT_STATES: ReadonlySet<string> = new Set(['submitted', 'graded', 'expired']);
export const isFinishedAttempt = (status: string): boolean => FINISHED_ATTEMPT_STATES.has(status);
export const attemptTone = (status: string): BadgeTone => (status === 'graded' ? 'success' : status === 'expired' ? 'danger' : status === 'submitted' ? 'warning' : 'info');

export const GENERATE_REFUSALS: Readonly<Record<string, string>> = {
  not_verified: 'the item is not verified',
  invalid_output: 'the AI did not produce a usable question',
  answer_in_stem: 'the question would have given away its own answer',
  budget_exhausted: 'the AI budget is used up',
  ai_unavailable: 'the AI service is not available',
};

/** A score between 0 and 1 as a percentage. */
export const percent = (score: number | null): string => (score === null ? '—' : `${Math.round(score * 100)} %`);
