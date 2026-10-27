// Reading and searching an opened offline pack. Every view says "as of" when the pack was made: nothing here is
// updated while offline.
import { useMemo, useState } from 'react';
import { searchPack } from '../../offline/search.ts';
import type { Opened } from '../../offline/store.ts';
import { Banner, Button, Card, Empty, Facts, formatDate, humanize, SelectField, sensitivityLabel, TextField } from '../../ui/index.tsx';

type OpenPack = Extract<Opened, { state: 'open' }>;

export function AsOf({ opened }: { opened: OpenPack }) {
  return (
    <Banner tone="warning" title={`As of ${formatDate(opened.asOf)}`}>
      <p>This is a copy kept on this device for {opened.pack.job_role}. It is not updated while you are offline: something
        corrected since may read differently here. It can be opened until {formatDate(opened.expiresAt)}.</p>
    </Banner>
  );
}

export function OfflineReader({ opened }: { opened: OpenPack }) {
  const { pack } = opened;
  const [query, setQuery] = useState('');
  const [topicId, setTopicId] = useState('');
  const [itemId, setItemId] = useState<string | null>(null);
  const found = useMemo(() => searchPack(pack, { query, topicId: topicId === '' ? undefined : topicId }), [pack, query, topicId]);
  const topicName = useMemo(() => new Map(pack.topics.map((t) => [t.topic_id, t.name])), [pack]);
  const item = itemId === null ? undefined : pack.items.find((i) => i.id === itemId);

  if (item !== undefined) {
    return (
      <div>
        <AsOf opened={opened} />
        <Card title={item.title || 'Untitled item'}>
          <p className="prose">{item.body}</p>
          <Facts items={[
            ['Status', humanize(item.status)],
            ['Verified', formatDate(item.verified_at)],
            ['Who may read it', sensitivityLabel(item.sensitivity)],
            ['Topics', item.topic_ids.map((id) => topicName.get(id)).filter(Boolean).join(', ') || '—'],
          ]} />
          <Button onClick={() => setItemId(null)}>Back to the list</Button>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <AsOf opened={opened} />
      {pack.truncated && (
        <Banner tone="info" title="Not everything fits in one copy">
          The first {pack.items.length} items are kept. Ask online for anything you cannot find here.
        </Banner>
      )}
      <Card>
        <div className="grid">
          <TextField label="Search this copy" type="search" value={query} onChange={(e) => setQuery(e.target.value)}
            hint="Every word must appear. Searching works without a connection; questions to the assistant do not." />
          <SelectField label="Topic" value={topicId} onChange={(e) => setTopicId(e.target.value)}>
            <option value="">All topics</option>
            {pack.topics.map((t) => <option key={t.topic_id} value={t.topic_id}>{t.name}</option>)}
          </SelectField>
        </div>
        {found.length === 0
          ? <Empty>{pack.items.length === 0 ? 'This copy holds no verified knowledge for the job role.' : 'Nothing in this copy matches.'}</Empty>
          : (
            <ul className="plain-list" aria-label="Items in this copy">
              {found.map((i) => (
                <li key={i.id}>
                  <button type="button" className="link-button" onClick={() => setItemId(i.id)}>{i.title || 'Untitled item'}</button>
                </li>
              ))}
            </ul>
          )}
      </Card>
    </div>
  );
}
