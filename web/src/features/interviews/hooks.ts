// Interviews: reading and changing them, without any markup.
import { useApiList, useApiMutation, useApiQuery } from '../../api/context.tsx';
import type { KInterviewDetail } from '../../api/generated.ts';
import type { BadgeTone } from '../../ui/index.tsx';

const CHANGED = ['listInterviews', 'getInterview'] as const;

/** The interviews the card may see (an expert: their own), a page at a time. */
export const useInterviewList = () => useApiList('listInterviews', { query: { limit: 50 } });
export const useInterview = (interviewId: string) => useApiQuery('getInterview', { path: { interview_id: interviewId } });
export const useInviteToInterview = () => useApiMutation('createInterview', CHANGED);
export const useAcceptInterview = () => useApiMutation('acceptInterview', CHANGED);
/** Sending an answer also creates a draft knowledge item, so those lists are re-read as well. */
export const useAnswerTurn = () => useApiMutation('answerInterviewTurn', [...CHANGED, 'listKnowledgeItems', 'listMyContributions']);
export const usePauseInterview = () => useApiMutation('pauseInterview', CHANGED);
export const useResumeInterview = () => useApiMutation('resumeInterview', CHANGED);
export const useCompleteInterview = () => useApiMutation('completeInterview', CHANGED);
/** Active people who can be invited, a page at a time. */
export const useInvitablePeople = ({ enabled }: { enabled: boolean }) => useApiList('listPeople', { query: { status: 'active', limit: 100 } }, { enabled });

export const INTERVIEW_STATUS_TEXT: Readonly<Record<string, string>> = {
  invited: 'Invited — not started',
  active: 'In progress',
  paused: 'Paused',
  stopped_budget: 'Stopped — the AI budget for this interview is used up',
  completed: 'Finished',
  abandoned: 'Ended without finishing',
};
export const interviewTone = (status: string): BadgeTone =>
  status === 'completed' ? 'success' : status === 'active' ? 'info' : status === 'abandoned' ? 'neutral' : 'warning';

/** The question that is waiting for an answer: the last turn without one, while the interview runs. */
export function openQuestion(interview: KInterviewDetail): string | null {
  if (interview.status !== 'active') return null;
  const last = interview.turns[interview.turns.length - 1];
  return last !== undefined && last.answer === null && !last.erased ? last.question : null;
}
