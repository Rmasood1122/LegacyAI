// Conflicts and old items (feature 23): verified items that state different values for the same thing, and items
// verified so long ago that they need a fresh look. Both are review tasks; this screen shows just these two kinds.
// A conflict ends by itself when one of the two items is corrected or reopened; an old item when it is verified again.
import type { KTask } from '../../api/generated.ts';
import { ScreenLink } from '../../navigation/ScreenLink.tsx';
import { Badge, Banner, DataTable, Empty, ErrorNote, formatDate, Loading, Page, PartialListNote } from '../../ui/index.tsx';
import { useOpenTasks } from './hooks.ts';

function TaskTable({ caption, linkText, tasks }: { caption: string; linkText: string; tasks: readonly KTask[] }) {
  return (
    <DataTable caption={caption} columns={['Item', 'Found', 'To be handled by']}>
      {tasks.map((t) => (
        <tr key={t.id}>
          <td><ScreenLink screen="knowledgeItem" id={t.subject_id}>{linkText}</ScreenLink></td>
          <td>{formatDate(t.created_at)}</td>
          <td>{formatDate(t.due_at)} {new Date(t.due_at).getTime() < Date.now() && <Badge tone="danger">Overdue</Badge>}</td>
        </tr>
      ))}
    </DataTable>
  );
}

export function ConflictsScreen() {
  const conflicts = useOpenTasks('item_conflict');
  const stale = useOpenTasks('stale_item');
  return (
    <Page title="Conflicts and old items" intro="Verified knowledge that needs a second look: items that disagree with each other, and items verified long ago.">
      <h2>Verified items that disagree</h2>
      <p className="muted">Found by comparing the numbers and limits in verified items of the same topic. Open an item to see what it disagrees with. Correct or reopen one of the two and the conflict ends.</p>
      {conflicts.isPending && <Loading what="conflicts" />}
      <ErrorNote error={conflicts.error} />
      {conflicts.items !== undefined && (conflicts.items.length === 0
        ? <Empty>No conflict is known between verified items.</Empty>
        : <TaskTable caption="Items in conflict" linkText="Open the item and see the conflict" tasks={conflicts.items} />)}
      {conflicts.hasMore && <PartialListNote shown={conflicts.items?.length ?? 0} noun="conflicts" busy={conflicts.isLoadingMore} onLoadMore={conflicts.loadMore} />}

      <h2>Items verified long ago</h2>
      {stale.isPending && <Loading what="old items" />}
      <ErrorNote error={stale.error} />
      {stale.items !== undefined && (stale.items.length === 0
        ? <Empty>No item is waiting for a fresh look.</Empty>
        : <TaskTable caption="Old items" linkText="Open the item" tasks={stale.items} />)}
      {stale.hasMore && <PartialListNote shown={stale.items?.length ?? 0} noun="old items" busy={stale.isLoadingMore} onLoadMore={stale.loadMore} />}

      <Banner tone="info" title="What the comparison cannot find">
        Only values written as numbers, and plain “must” against “must not”, are compared, and only between items linked to a common topic.
        Two items that contradict each other in words alone are not found.
      </Banner>
    </Page>
  );
}
