// Topics, job roles and gaps: reading and changing them, without any markup.
import { useApiList, useApiMutation, useApiQuery } from '../../api/context.tsx';
import type { KGapReport } from '../../api/generated.ts';
import type { BadgeTone } from '../../ui/index.tsx';

const TOPICS_CHANGED = ['listTopics', 'getGapReport'] as const;

export type TopicStatus = 'active' | 'proposed' | 'retired';
export const useTopicList = (status: TopicStatus) => useApiList('listTopics', { query: { status, limit: 50 } });
export const useCreateTopic = () => useApiMutation('createTopic', TOPICS_CHANGED);
export const useUpdateTopic = () => useApiMutation('updateTopic', TOPICS_CHANGED);
export const useSuggestTopics = () => useApiMutation('suggestTopics', TOPICS_CHANGED);
/** Documents that are ready, to suggest topics from. */
export const useReadyDocuments = ({ enabled }: { enabled: boolean }) => useApiList('listSources', { query: { status: 'ready', limit: 50 } }, { enabled });

/** The gap report of one job role; nothing is asked until a role is named. */
export const useGapReport = (jobRole: string) => useApiQuery('getGapReport', { query: { job_role: jobRole } }, { enabled: jobRole !== '' });
export const useSetRoleTopics = () => useApiMutation('setRoleTopics', ['getGapReport']);
export const useSetRolePeople = () => useApiMutation('setRolePeople', ['getGapReport']);
export const useRolePeopleChoices = ({ enabled }: { enabled: boolean }) => useApiList('listPeople', { query: { status: 'active', limit: 100 } }, { enabled });

type GapLabel = KGapReport['topics'][number]['label'];
export const GAP_TEXT: Readonly<Record<GapLabel, string>> = {
  uncovered: 'Nothing captured yet',
  unverified: 'Captured, but nobody has verified it',
  single_source: 'Rests on one person only',
  stale: 'Verified long ago',
  thin: 'Very little verified knowledge',
  covered: 'Covered',
};
export const gapTone = (label: GapLabel): BadgeTone =>
  label === 'covered' ? 'success' : label === 'uncovered' ? 'danger' : 'warning';
