// Knowledge: the list of items, and writing a new one.
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { ScreenLink, useScreenPath } from '../../navigation/ScreenLink.tsx';
import { useSession } from '../../session/session.tsx';
import { Badge, Button, Card, DataTable, Empty, ErrorNote, formatDate, humanize, Loading, Page, PartialListNote, SelectField, SENSITIVITY_LABELS, sensitivityLabel, TextArea, TextField } from '../../ui/index.tsx';
import { itemTone, STATUS_FILTERS, useCreateItem, useKnowledgeItemList, type ItemStatusFilter } from './hooks.ts';

export function KnowledgeScreen() {
  const { can } = useSession();
  const [status, setStatus] = useState<ItemStatusFilter | ''>('');
  const [mine, setMine] = useState(false);
  const list = useKnowledgeItemList({ status: status === '' ? undefined : status, mineOnly: mine });
  return (
    <Page title="Knowledge" intro="Pieces of know-how. Only items marked “verified” have been checked by a second person.">
      {can('createKnowledgeItem') && <WriteItem />}
      <h2>Items you may read</h2>
      <div className="row">
        <SelectField label="Show" value={status} onChange={(e) => setStatus(e.target.value as ItemStatusFilter | '')}>
          <option value="">All states</option>
          {STATUS_FILTERS.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
        </SelectField>
        <label className="choice"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /><span>Only mine</span></label>
      </div>
      {list.isPending && <Loading what="knowledge items" />}
      <ErrorNote error={list.error} />
      {list.items !== undefined && (list.items.length === 0 ? <Empty>No items match.</Empty> : (
        <DataTable caption="Knowledge items" columns={['Title', 'State', 'Sensitivity', 'Used in answers', 'Updated']}>
          {list.items.map((i) => (
            <tr key={i.id}>
              <td><ScreenLink screen="knowledgeItem" id={i.id}>{i.title || 'Untitled'}</ScreenLink> {i.ai_extracted && <Badge tone="neutral">Drafted by AI</Badge>}</td>
              <td><Badge tone={itemTone(i.status)}>{humanize(i.status)}</Badge></td>
              <td>{sensitivityLabel(i.sensitivity)}</td>
              <td>{i.usage_count}</td>
              <td>{formatDate(i.updated_at)}</td>
            </tr>
          ))}
        </DataTable>
      ))}
      {list.hasMore && <PartialListNote shown={list.items?.length ?? 0} noun="items" busy={list.isLoadingMore} onLoadMore={list.loadMore} />}
    </Page>
  );
}

function WriteItem() {
  const create = useCreateItem();
  const { state } = useSession();
  const personId = state.status === 'signed_in' ? state.session.person_id : null;
  const navigate = useNavigate();
  const pathTo = useScreenPath();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [sensitivity, setSensitivity] = useState(1);

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    // The writer is named as the contributor: the API lets a card write items only for its own person (a company card has none).
    const contributor = personId === null ? {} : { contributor_person_id: personId };
    create.mutate({ body: { title: title.trim(), body: body.trim(), sensitivity, ...contributor } }, {
      onSuccess: (created) => {
        setTitle('');
        setBody('');
        setOpen(false);
        const next = pathTo({ screen: 'knowledgeItem', id: created.id });
        if (next !== null) void navigate(next);
      },
    });
  };

  if (!open) return <p><Button variant="primary" onClick={() => setOpen(true)}>Write a new item</Button></p>;
  return (
    <Card title="Write a new item">
      <form onSubmit={onSubmit} noValidate>
        <TextField label="Title" maxLength={200} autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
        <TextArea label="What should a successor know?" hint="One piece of know-how, in your own words. Personal details are blanked out when it is saved." rows={6} value={body} onChange={(e) => setBody(e.target.value)} />
        <SelectField label="Who may read it" value={sensitivity} onChange={(e) => setSensitivity(Number(e.target.value))}>
          {SENSITIVITY_LABELS.map((label, level) => <option key={label} value={level}>{label}</option>)}
        </SelectField>
        <ErrorNote error={create.error} />
        <div className="row">
          <Button type="submit" variant="primary" busy={create.isPending} disabled={title.trim() === '' || body.trim() === ''}>Save as draft</Button>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}
