// Topics: the company's list of things worth knowing. Create, rename, accept a suggestion, retire.
import { useState, type FormEvent } from 'react';
import type { KTopic } from '../../api/generated.ts';
import { useSession } from '../../session/session.tsx';
import { Badge, Banner, Button, Card, ConfirmButton, DataTable, Empty, ErrorNote, Loading, Page, PartialListNote, SelectField, TextArea, TextField } from '../../ui/index.tsx';
import { useCreateTopic, useReadyDocuments, useSuggestTopics, useTopicList, useUpdateTopic, type TopicStatus } from './hooks.ts';

const STATUS_TEXT: Readonly<Record<TopicStatus, string>> = { active: 'In use', proposed: 'Suggested — not yet accepted', retired: 'Retired' };

export function TopicsScreen() {
  const [status, setStatus] = useState<TopicStatus>('active');
  const topics = useTopicList(status);
  const update = useUpdateTopic();
  const [editing, setEditing] = useState<KTopic | null>(null);
  const items = topics.items ?? [];
  return (
    <Page title="Topics" intro="Topics say what a job role needs to know. Interviews, the gap report and the readiness test are all built on them.">
      <NewTopic />
      <SuggestFromDocument />
      <h2>The list</h2>
      <SelectField label="Show" value={status} onChange={(e) => setStatus(e.target.value as TopicStatus)}>
        {(Object.keys(STATUS_TEXT) as TopicStatus[]).map((s) => <option key={s} value={s}>{STATUS_TEXT[s]}</option>)}
      </SelectField>
      {topics.isPending && <Loading what="topics" />}
      <ErrorNote error={topics.error ?? update.error} />
      {editing !== null && <EditTopic key={editing.id} topic={editing} onClose={() => setEditing(null)} />}
      {topics.items !== undefined && (items.length === 0 ? <Empty>No topics here.</Empty> : (
        <DataTable caption="Topics" columns={['Name', 'Description', 'Where it came from', 'Actions']}>
          {items.map((t) => (
            <tr key={t.id}>
              <td>{t.name}</td>
              <td>{t.description || '—'}</td>
              <td><Badge tone="neutral">{t.origin === 'admin' ? 'Added by a person' : 'Suggested from a document'}</Badge></td>
              <td>
                <div className="row">
                  {t.status !== 'retired' && <Button onClick={() => setEditing(t)}>Rename</Button>}
                  {t.status === 'proposed' && <Button variant="primary" busy={update.isPending} onClick={() => update.mutate({ path: { topic_id: t.id }, body: { status: 'active' } })}>Accept</Button>}
                  {t.status !== 'retired' && (
                    <ConfirmButton resetKey={null} label="Retire" confirmLabel="Yes, retire this topic" busy={update.isPending} onConfirm={() => update.mutate({ path: { topic_id: t.id }, body: { status: 'retired' } })} />
                  )}
                </div>
              </td>
            </tr>
          ))}
        </DataTable>
      ))}
      {topics.hasMore && <PartialListNote shown={items.length} noun="topics" busy={topics.isLoadingMore} onLoadMore={topics.loadMore} />}
    </Page>
  );
}

function NewTopic() {
  const create = useCreateTopic();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    create.mutate({ body: { name: name.trim(), ...(description.trim() === '' ? {} : { description: description.trim() }) } }, {
      onSuccess: () => {
        setName('');
        setDescription('');
      },
    });
  };
  return (
    <Card title="Add a topic">
      <form onSubmit={onSubmit} noValidate>
        <TextField label="Name" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
        <TextArea label="What it covers" hint="One or two sentences. This is what answers and documents are matched against." rows={2} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} />
        <ErrorNote error={create.error} />
        {create.isSuccess && <Banner tone="success" title="The topic was added" />}
        <Button type="submit" variant="primary" busy={create.isPending} disabled={name.trim() === ''}>Add topic</Button>
      </form>
    </Card>
  );
}

function EditTopic({ topic, onClose }: { topic: KTopic; onClose: () => void }) {
  const update = useUpdateTopic();
  const [name, setName] = useState(topic.name);
  const [description, setDescription] = useState(topic.description);
  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    update.mutate({ path: { topic_id: topic.id }, body: { name: name.trim(), description: description.trim() } }, { onSuccess: onClose });
  };
  return (
    <Card title="Rename a topic">
      <form onSubmit={onSubmit} noValidate>
        <TextField label="New name" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
        <TextArea label="New description" rows={2} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} />
        <ErrorNote error={update.error} />
        <div className="row">
          <Button type="submit" variant="primary" busy={update.isPending} disabled={name.trim() === ''}>Save</Button>
          <Button onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}

/** Asks the service to read one document and suggest topics from it. Suggestions wait under "Suggested". */
function SuggestFromDocument() {
  const { can } = useSession();
  const allowed = can('suggestTopics') && can('listSources');
  const documents = useReadyDocuments({ enabled: allowed });
  const suggest = useSuggestTopics();
  const [source, setSource] = useState('');
  if (!allowed) return null;
  return (
    <Card title="Suggest topics from a document">
      <SelectField label="Document" hint="Only documents that are ready can be used. This uses the AI budget." value={source} onChange={(e) => setSource(e.target.value)}>
        <option value="">Choose a document…</option>
        {(documents.items ?? []).map((d) => <option key={d.id} value={d.id}>{d.title || 'Untitled'}</option>)}
      </SelectField>
      {documents.hasMore && <PartialListNote shown={documents.items?.length ?? 0} noun="documents" busy={documents.isLoadingMore} onLoadMore={documents.loadMore} />}
      <ErrorNote error={suggest.error ?? documents.error} />
      {suggest.data !== undefined && (
        <Banner tone={suggest.data.proposed.length > 0 ? 'success' : 'info'} title={suggest.data.proposed.length > 0 ? `${suggest.data.proposed.length} suggested` : 'Nothing new was suggested'}>
          {suggest.data.proposed.length > 0 && <p>Find them under “Suggested — not yet accepted” below and accept the ones you want.</p>}
        </Banner>
      )}
      <Button busy={suggest.isPending} disabled={source === ''} onClick={() => suggest.mutate({ body: { source_id: source } })}>Suggest topics</Button>
    </Card>
  );
}
