// Activity numbers and the knowledge map: reading them, without any markup.
import { useApiMutation, useApiQuery } from '../../api/context.tsx';
import type { KActivityMonth } from '../../api/generated.ts';
import { GRAPH_NODE_KINDS, graphNodeKey, parseGraphNodeKey, type GraphNodeKind } from '../../navigation/routes.ts';
import { toCsv } from '../../ui/files.ts';

export const MONTHS_SHOWN = 6;

/** Activity numbers per month, newest first. They count what was done in the product - not business outcomes. */
export const useActivity = () => useApiQuery('getActivity', { query: { months: MONTHS_SHOWN } });
/** Cards and people as the plan counts them (an existing operation; shown beside the activity numbers). */
export const useUsage = ({ enabled }: { enabled: boolean }) => useApiQuery('getTenantUsage', undefined, { enabled });

/** The columns of the monthly table, in the order of the file. One list: the file's header and its rows come from it. */
const MONTH_COLUMNS = [
  'month_start', 'documents_added', 'items_captured', 'items_verified', 'median_hours_to_verify', 'interviews_completed', 'tests_handed_in',
] as const satisfies ReadonlyArray<keyof KActivityMonth>;

/** The monthly numbers as CSV text. A number this card has no right to is an empty field, as it is null in the answer. */
export const activityCsv = (months: readonly KActivityMonth[]): string =>
  toCsv(MONTH_COLUMNS, months.map((m) => MONTH_COLUMNS.map((column) => m[column])));

export type NodeKind = GraphNodeKind;
export const NODE_KINDS = GRAPH_NODE_KINDS;
export const KIND_TEXT: Readonly<Record<NodeKind, string>> = { topic: 'Topic', item: 'Knowledge item', source: 'Document', job_role: 'Job role' };
export const GROUP_TEXT = {
  topics: 'Topics', items: 'Knowledge items', sources: 'Documents it cites', job_roles: 'Job roles that need it', conflicting_items: 'Items that disagree with it',
} as const;

/** A node in an address, and back (both live side by side in navigation/routes.ts). */
export const nodeKey = graphNodeKey;
export const parseNodeKey = parseGraphNodeKey;

/** One node and what it is directly linked to. */
export const useNeighbourhood = (kind: NodeKind, id: string) => useApiQuery('getGraphNeighbourhood', { query: { kind, id } });
/** Topics to start from, for cards that may list them. */
export const useStartTopics = ({ enabled }: { enabled: boolean }) => useApiQuery('listTopics', { query: { status: 'active', limit: 50 } }, { enabled });
/** Items to start from. */
export const useStartItems = ({ enabled }: { enabled: boolean }) => useApiQuery('listKnowledgeItems', { query: { limit: 25 } }, { enabled });
/** Taking the whole map out as a file: an export, for cards that may export. Each call is recorded and counted against an hourly limit. */
export const useGraphExport = () => useApiMutation('exportKnowledgeGraph');
