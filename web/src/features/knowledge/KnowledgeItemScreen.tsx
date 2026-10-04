// One knowledge item: its text, where it comes from, its history, and the review actions.
// Which buttons appear depends on the item's state and on the card's permissions; the API decides
// in the end (for example, nobody can verify their own item).
import { useState, type FormEvent } from 'react';
import { useParams } from 'react-router';
import { ScreenLink } from '../../navigation/ScreenLink.tsx';
import { useSession } from '../../session/session.tsx';
import { Badge, Banner, Button, Card, DataTable, ErrorNote, formatDate, humanize, Loading, Page, sensitivityLabel, TextArea } from '../../ui/index.tsx';
import { ItemTopics } from './ItemTopics.tsx';
import { ITEM_STATUS_TEXT, itemTone, useCorrectItem, useKnowledgeItem, useRejectItem, useReopenItem, useSubmitItem, useVerifyItem } from './hooks.ts';

export function KnowledgeItemScreen() {
  const { itemId = '' } = useParams();
  const { can } = useSession();
  const item = useKnowledgeItem(itemId);
  const submit = useSubmitItem();
  const verify = useVerifyItem();
  const reject = useRejectItem();
  const reopen = useReopenItem();
  const correct = useCorrectItem();
  const [correcting, setCorrecting] = useState(false);
  const [text, setText] = useState('');
  const i = item.data;
  const path = { item_id: itemId };
  const busy = submit.isPending || verify.isPending || reject.isPending || reopen.isPending || correct.isPending;
  const actionError = submit.error ?? verify.error ?? reject.error ?? reopen.error ?? correct.error;

  const onCorrect = (e: FormEvent): void => {
    e.preventDefault();
    correct.mutate({ path, body: { body: text.trim() } }, { onSuccess: () => setCorrecting(false) });
  };

  const actions = i === undefined ? [] : [
    i.status === 'candidate' && can('submitKnowledgeItem') && <Button key="submit" variant="primary" busy={busy} onClick={() => submit.mutate({ path })}>Send for review</Button>,
    i.status === 'in_review' && can('verifyKnowledgeItem') && <Button key="verify" variant="primary" busy={busy} onClick={() => verify.mutate({ path })}>Verify</Button>,
    i.status === 'in_review' && can('rejectKnowledgeItem') && <Button key="reject" variant="danger" busy={busy} onClick={() => reject.mutate({ path })}>Reject</Button>,
    ['candidate', 'in_review', 'verified', 'corrected', 'stale'].includes(i.status) && can('proposeItemVersion') && !correcting
      && <Button key="correct" busy={busy} onClick={() => { setText(i.body); setCorrecting(true); }}>Correct the text</Button>,
    ['verified', 'corrected', 'rejected', 'stale'].includes(i.status) && can('reopenKnowledgeItem') && <Button key="reopen" busy={busy} onClick={() => reopen.mutate({ path, body: {} })}>Reopen for review</Button>,
  ].filter(Boolean);

  return (
    <Page title={i?.title || 'Knowledge item'} intro={<ScreenLink screen="knowledge">Back to knowledge</ScreenLink>}>
      {item.isPending && <Loading what="the item" />}
      <ErrorNote error={item.error} />
      {i !== undefined && (
        <div>
          <Card>
            <div className="row">
              <Badge tone={itemTone(i.status)}>{humanize(i.status)}</Badge>
              <span>{ITEM_STATUS_TEXT[i.status] ?? ''}</span>
              {i.ai_extracted && <Badge tone="neutral">Drafted by AI</Badge>}
              {i.self_verified && <Badge tone="warning">Verified by its own author</Badge>}
            </div>
            {i.conflicts.length > 0 && (
              <Banner tone="warning" title="This item disagrees with another verified item">
                <ul>
                  {i.conflicts.map((c) => (c.restricted || c.this === null || c.other === null
                    ? <li key="restricted">It disagrees with an item you may not read. What that item says is not shown.</li>
                    : (
                      <li key={`${c.other.id}:${c.measure ?? ''}:${c.detected_at ?? ''}`}>
                        This item says {c.this.value}.{' '}
                        <ScreenLink screen="knowledgeItem" id={c.other.id}>{c.other.title || 'Another item'}</ScreenLink> says {c.other.value}.
                      </li>
                    )))}
                </ul>
                <p>Answers that rely on either statement are refused until one of the two is corrected or reopened.</p>
              </Banner>
            )}
            <p className="prose">{i.body}</p>
            <dl className="facts">
              <dt>Who may read it</dt><dd>{sensitivityLabel(i.sensitivity)}</dd>
              <dt>Verified</dt><dd>{formatDate(i.verified_at)}</dd>
              <dt>Used in answers</dt><dd>{i.usage_count} times</dd>
            </dl>
          </Card>
          {(actions.length > 0 || actionError !== null) && (
            <Card title="Review">
              {actionError?.kind === 'forbidden'
                ? <Banner tone="danger" title="Not allowed">This card may not do that. An item cannot be verified by the person who wrote it; a second reviewer is needed.</Banner>
                : <ErrorNote error={actionError} />}
              <div className="row">{actions}</div>
            </Card>
          )}
          {correcting && (
            <Card title="Correct the text">
              <form onSubmit={onCorrect} noValidate>
                <TextArea label="Corrected text" hint="This creates a new version. Earlier versions stay in the history." rows={8} autoFocus value={text} onChange={(e) => setText(e.target.value)} />
                <div className="row">
                  <Button type="submit" variant="primary" busy={correct.isPending} disabled={text.trim() === '' || text.trim() === i.body}>Save the correction</Button>
                  <Button onClick={() => setCorrecting(false)}>Cancel</Button>
                </div>
              </form>
            </Card>
          )}
          <ItemTopics itemId={itemId} topics={i.topics} />
          <Card title="Where it comes from">
            {i.provenance.length === 0 ? <p className="muted">Written directly; no document is linked.</p> : (
              <ul>
                {i.provenance.map((p) => (
                  <li key={`${p.source_id}:${p.page_from ?? 0}`}>
                    <ScreenLink screen="document" id={p.source_id}>{p.title || 'Untitled document'}</ScreenLink>
                    {p.page_from !== null && ` — page ${p.page_from}${p.page_to !== null && p.page_to !== p.page_from ? `–${p.page_to}` : ''}`}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="History">
            <DataTable caption="Versions" columns={['Version', 'Change', 'When', '']}>
              {i.versions.map((v) => (
                <tr key={v.version_no}>
                  <td>{v.version_no}</td><td>{humanize(v.change_kind)}</td><td>{formatDate(v.created_at)}</td>
                  <td>{v.current ? <Badge tone="info">Current</Badge> : v.erased_at !== null ? <Badge tone="neutral">Erased</Badge> : null}</td>
                </tr>
              ))}
            </DataTable>
          </Card>
        </div>
      )}
    </Page>
  );
}
