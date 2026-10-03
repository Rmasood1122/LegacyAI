// Review queue: what is waiting for a reviewer, most urgent first. Take a task, dismiss it, or
// do the same for several at once.
import { useState } from 'react';
import { useApiList, useApiMutation } from '../../api/context.tsx';
import type { KBulkResult, KTask } from '../../api/generated.ts';
import type { ScreenTarget } from '../../navigation/routes.ts';
import { ScreenLink } from '../../navigation/ScreenLink.tsx';
import { useSession } from '../../session/session.tsx';
import { Badge, Banner, Button, DataTable, Empty, ErrorNote, formatDate, humanize, Loading, Page, PartialListNote, SelectField } from '../../ui/index.tsx';

type Filter = 'open' | 'assigned' | 'resolved' | 'dismissed';
const REFRESH = ['listReviewTasks'] as const;

const KIND_TEXT: Readonly<Record<string, string>> = {
  verify_item: 'Verify a knowledge item',
  redaction_review: 'Check an uncertain redaction',
  expert_question: 'Question for an expert',
  quiz_item_approval: 'Approve a test question',
  grading_override: 'Check a test grade',
  stale_item: 'Re-check an old item',
};

/** The screen on which the thing to review can be opened, if this application has one for it. */
function subjectScreen(task: KTask): ScreenTarget | null {
  if (task.subject_type === 'knowledge_item') return { screen: 'knowledgeItem', id: task.subject_id };
  if (task.subject_type === 'source') return { screen: 'document', id: task.subject_id };
  return null;
}

function bulkSummary(result: KBulkResult): string {
  const done = result.results.filter((r) => r.outcome === 'done').length;
  const rest = result.results.length - done;
  return rest === 0 ? `Done for ${done} ${done === 1 ? 'task' : 'tasks'}.` : `Done for ${done}; ${rest} could not be changed (not allowed, already handled, or gone).`;
}

export function ReviewScreen() {
  const { state, can } = useSession();
  const [filter, setFilter] = useState<Filter>('open');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const tasks = useApiList('listReviewTasks', { query: { status: filter, limit: 50 } });
  const assign = useApiMutation('assignReviewTask', REFRESH);
  const unassign = useApiMutation('unassignReviewTask', REFRESH);
  const dismiss = useApiMutation('dismissReviewTask', REFRESH);
  const bulk = useApiMutation('bulkReviewTasks', REFRESH);
  const myCard = state.status === 'signed_in' ? state.session.card_id : '';
  const mayAct = can('assignReviewTask');
  const actionable = filter === 'open' || filter === 'assigned';
  const busy = assign.isPending || unassign.isPending || dismiss.isPending || bulk.isPending;
  const items = tasks.items ?? [];

  const toggle = (id: string): void => {
    const next = new Set(selected);
    if (!next.delete(id)) next.add(id);
    setSelected(next);
  };
  const runBulk = (action: 'assign' | 'dismiss'): void => {
    bulk.mutate({ body: { action, task_ids: [...selected] } }, { onSuccess: () => setSelected(new Set()) });
  };
  const changeFilter = (next: Filter): void => {
    setFilter(next);
    setSelected(new Set());
    bulk.reset();
  };

  return (
    <Page title="Review queue" intro="Tasks you are allowed to handle, most urgent first.">
      <SelectField label="Show" value={filter} onChange={(e) => changeFilter(e.target.value as Filter)}>
        <option value="open">Open</option>
        <option value="assigned">Taken by someone</option>
        <option value="resolved">Done</option>
        <option value="dismissed">Dismissed</option>
      </SelectField>
      {tasks.isPending && <Loading what="tasks" />}
      <ErrorNote error={tasks.error ?? assign.error ?? unassign.error ?? dismiss.error ?? bulk.error} />
      {bulk.data !== undefined && <Banner tone="info">{bulkSummary(bulk.data)}</Banner>}
      {mayAct && actionable && items.length > 0 && (
        <div className="row">
          <span>{selected.size} selected</span>
          <Button busy={busy} disabled={selected.size === 0} onClick={() => runBulk('assign')}>Take selected</Button>
          {can('dismissReviewTask') && <Button variant="danger" busy={busy} disabled={selected.size === 0} onClick={() => runBulk('dismiss')}>Dismiss selected</Button>}
        </div>
      )}
      {tasks.items !== undefined && (items.length === 0 ? <Empty>Nothing here.</Empty> : (
        <DataTable caption="Review tasks" columns={['Select', 'Task', 'Due', 'State', 'Actions']}>
          {items.map((t) => {
            const subject = subjectScreen(t);
            const mine = t.assigned_to_card_id === myCard;
            const label = KIND_TEXT[t.kind] ?? humanize(t.kind);
            return (
              <tr key={t.id}>
                <td>{mayAct && actionable && <input type="checkbox" aria-label={`Select: ${label}, due ${formatDate(t.due_at)}`} checked={selected.has(t.id)} onChange={() => toggle(t.id)} />}</td>
                <td>{subject !== null ? <ScreenLink {...subject}>{label}</ScreenLink> : label}</td>
                <td>{formatDate(t.due_at)} {new Date(t.due_at).getTime() < Date.now() && actionable && <Badge tone="danger">Overdue</Badge>}</td>
                <td><Badge tone={t.status === 'resolved' ? 'success' : 'neutral'}>{t.status === 'assigned' ? (mine ? 'Taken by you' : 'Taken') : humanize(t.status)}</Badge></td>
                <td>
                  {mayAct && actionable && (
                    <div className="row">
                      {t.status === 'open' && <Button busy={busy} onClick={() => assign.mutate({ path: { task_id: t.id }, body: {} })}>Take</Button>}
                      {t.status === 'assigned' && mine && can('unassignReviewTask') && <Button busy={busy} onClick={() => unassign.mutate({ path: { task_id: t.id } })}>Give back</Button>}
                      {can('dismissReviewTask') && <Button variant="danger" busy={busy} onClick={() => dismiss.mutate({ path: { task_id: t.id } })}>Dismiss</Button>}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </DataTable>
      ))}
      {tasks.hasMore && <PartialListNote shown={items.length} noun="tasks" busy={tasks.isLoadingMore} onLoadMore={tasks.loadMore} />}
    </Page>
  );
}
