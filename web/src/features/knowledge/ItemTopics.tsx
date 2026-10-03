// The topics a knowledge item belongs to and, for a reviewer, changing them. An item with no topic does not
// count in the gap report, and test questions made from it cannot reach a test.
import { useState } from 'react';
import type { KItemDetail } from '../../api/generated.ts';
import { useSession } from '../../session/session.tsx';
import { Badge, Banner, Button, Card, CheckboxField, ErrorNote, Loading, PartialListNote } from '../../ui/index.tsx';
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
      {/* a fresh form whenever the item's links change (after a save, or when someone else changed them) */}
      {mayChange && editing && <ChooseTopics key={topics.map((t) => t.topic_id).join(',')} itemId={itemId} current={topics} onDone={() => setEditing(false)} />}
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
  // Every link shown above gets a row, also one to a topic that is not in the list of topics in use (a proposed one):
  // what is sent is exactly what is ticked here. A link that stays keeps how it was made; links to retired topics and
  // to topics this card may not see are not shown and are not touched by saving.
  const listed = new Set(items.map((t) => t.id));
  const rows = [...items.map((t) => ({ id: t.id, name: t.name })), ...current.filter((t) => !listed.has(t.topic_id)).map((t) => ({ id: t.topic_id, name: t.name }))];
  const toSend = rows.filter((t) => chosen.has(t.id)).map((t) => t.id);
  const removed = current.filter((t) => !chosen.has(t.topic_id));
  const added = rows.filter((t) => chosen.has(t.id) && !current.some((c) => c.topic_id === t.id));
  const tooMany = toSend.length > MAX_TOPICS_PER_ITEM;
  const refusedAsOwnWork = save.error?.kind === 'forbidden';
  return (
    <div>
      {all.isPending && <Loading what="topics" />}
      {refusedAsOwnWork
        ? <Banner tone="danger" title="A second person must do this">You contributed this item or wrote its current version, and it has been verified. Its topics decide what learners are tested on, so someone else has to change them.</Banner>
        : <ErrorNote error={all.error ?? save.error} />}
      {all.items !== undefined && rows.length === 0 && <p className="muted">There are no topics in use yet.</p>}
      {rows.map((t) => <CheckboxField key={t.id} label={t.name} checked={chosen.has(t.id)} onChange={(on) => toggle(t.id, on)} />)}
      {all.hasMore && <PartialListNote shown={items.length} noun="topics" busy={all.isLoadingMore} onLoadMore={all.loadMore} />}
      <p role="status">
        {tooMany
          ? `An item can have at most ${MAX_TOPICS_PER_ITEM} topics.`
          : added.length === 0 && removed.length === 0
            ? 'Nothing is changed yet.'
            : `Saving will ${[added.length > 0 ? `add ${added.map((t) => `“${t.name}”`).join(', ')}` : '', removed.length > 0 ? `remove ${removed.map((t) => `“${t.name}”`).join(', ')}` : ''].filter(Boolean).join(' and ')}. The item keeps its state.`}
      </p>
      {all.hasMore && <p className="hint">Show all topics first.</p>}
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
