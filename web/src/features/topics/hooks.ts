// Topics, job roles and gaps: reading and changing them, without any markup.
import { useActivePeople, useApiList, useApiMutation, useApiQuery } from '../../api/context.tsx';
import type { KGapReport } from '../../api/generated.ts';
import type { BadgeTone } from '../../ui/index.tsx';

const TOPICS_CHANGED = ['listTopics', 'getGapReport'] as const;
// Renaming or retiring a topic also changes what a job role counts and the topic names shown on an item.
const TOPIC_UPDATED = [...TOPICS_CHANGED, 'listJobRoles', 'getRoleTopics', 'getKnowledgeItem'] as const;

export type TopicStatus = 'active' | 'proposed' | 'retired';
export const useTopicList = (status: TopicStatus) => useApiList('listTopics', { query: { status, limit: 50 } });
export const useCreateTopic = () => useApiMutation('createTopic', TOPICS_CHANGED);
export const useUpdateTopic = () => useApiMutation('updateTopic', TOPIC_UPDATED);
export const useSuggestTopics = () => useApiMutation('suggestTopics', TOPICS_CHANGED);
/** Documents that are ready, to suggest topics from. */
export const useReadyDocuments = ({ enabled }: { enabled: boolean }) => useApiList('listSources', { query: { status: 'ready', limit: 50 } }, { enabled });

/** The gap report of one job role; nothing is asked until a role is named. */
export const useGapReport = (jobRole: string) => useApiQuery('getGapReport', { query: { job_role: jobRole } }, { enabled: jobRole !== '' });
// The role's topics decide what a readiness report measures.
export const useSetRoleTopics = () => useApiMutation('setRoleTopics', ['getGapReport', 'listJobRoles', 'getRoleTopics', 'getReadinessReport']);
/** The topics set for a job role now, as far as this card may see them (retired topics are left out). */
export const useRoleTopics = (jobRole: string) => useApiQuery('getRoleTopics', { path: { job_role: jobRole } });
export const useSetRolePeople = () => useApiMutation('setRolePeople', ['getGapReport', 'getRolePeople']);
/** The job roles that already have topics (a role is only a name; one with no topics yet is typed in). */
export const useJobRoles = ({ enabled }: { enabled: boolean }) => useApiList('listJobRoles', { query: { limit: 50 } }, { enabled });
/** Who is set for a job role now. */
export const useRolePeople = (jobRole: string, { enabled }: { enabled: boolean }) => useApiQuery('getRolePeople', { path: { job_role: jobRole } }, { enabled });
export const useRolePeopleChoices = useActivePeople;

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
