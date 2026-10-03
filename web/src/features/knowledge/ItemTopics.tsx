// The topics a knowledge item belongs to and, for a reviewer, changing them. An item with no topic does not
// count in the gap report, and test questions made from it cannot reach a test.
import { useState } from 'react';
import type { KItemDetail } from '../../api/generated.ts';
import { useSession } from '../../session/session.tsx';
import { Badge, Button, Card, CheckboxField, ErrorNote, Loading, PartialListNote } from '../../ui/index.tsx';
import { MAX_TOPICS_PER_ITEM, useSetItemTopics, useTopicChoices } from './hooks.ts';

type TopicLink = KItemDetail['topics'][number];

export function ItemTopics({ itemId, topics }: { itemId: string; topics: readonly TopicLink[] }) {
  const { can } = useSession();
  const mayChange = can('setItemTopics') && can('listTopics');
  const [editing, setEditing] = useState(false);
  return (
    <Card title="Topics">
      {topics.length === 0
        ? <p className="muted">Not linked to a topic. Until it is, it does not count in the gap report and no test question made from it can be used in a test.</p>
        : (
          <ul>
            {topics.map((t) => (
              <li key={t.topic_id}>{t.name} <Badge tone="neutral">{t.link_source === 'reviewer' ? 'Set by a reviewer' : 'Found by similarity'}</Badge></li>
            ))}
          </ul>
        )}
      {mayChange && !editing && <Button onClick={() => setEditing(true)}>Change the topics</Button>}
      {mayChange && editing && <ChooseTopics itemId={itemId} current={topics} onDone={() => setEditing(false)} />}
    </Card>
  );
}

function ChooseTopics({ itemId, current, onDone }: { itemId: string; current: readonly TopicLink[]; onDone: () => void }) {
  const all = useTopicChoices();
  const save = useSetItemTopics();
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set(current.map((t) => t.topic_id)));
  const toggle = (id: string, on: boolean): void => {
    const next = new Set(chosen);
    if (on) next.add(id);
    else next.delete(id);
    setChosen(next);
  };
  const items = all.items ?? [];
  // Only topics in use can be linked; a ticked topic that has since been retired is left out.
  const toSend = items.filter((t) => chosen.has(t.id)).map((t) => t.id);
  const tooMany = toSend.length > MAX_TOPICS_PER_ITEM;
  return (
    <div>
      {all.isPending && <Loading what="topics" />}
      <ErrorNote error={all.error ?? save.error} />
      {all.items !== undefined && items.length === 0 && <p className="muted">There are no topics in use yet.</p>}
      {items.map((t) => <CheckboxField key={t.id} label={t.name} checked={chosen.has(t.id)} onChange={(on) => toggle(t.id, on)} />)}
      {all.hasMore && <PartialListNote shown={items.length} noun="topics" busy={all.isLoadingMore} onLoadMore={all.loadMore} />}
      <p className="hint">
        {tooMany ? `An item can have at most ${MAX_TOPICS_PER_ITEM} topics.` : 'Saving replaces this item’s topics with the ones ticked. The item keeps its state.'}
        {all.hasMore && ' Show all topics first.'}
      </p>
      <div className="row">
        <Button variant="primary" busy={save.isPending} disabled={all.items === undefined || all.hasMore || tooMany}
          onClick={() => save.mutate({ path: { item_id: itemId }, body: { topic_ids: toSend } }, { onSuccess: onDone })}>
          Save the topics
        </Button>
        <Button onClick={onDone}>Cancel</Button>
      </div>
    </div>
  );
}
