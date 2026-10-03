// One document: its status, what was blanked out, and withdrawing it.
import { useState } from 'react';
import { useParams } from 'react-router';
import { ScreenLink } from '../../navigation/ScreenLink.tsx';
import { useSession } from '../../session/session.tsx';
import { Badge, Banner, Button, Card, DataTable, ErrorNote, formatDate, humanize, Loading, Page, sensitivityLabel } from '../../ui/index.tsx';
import { AWAITING_CONFIRMATION_TEXT, documentStatusTone, failureText, useConfirmDocument, useDocument, useWithdrawDocument } from './hooks.ts';

export function DocumentDetailScreen() {
  const { sourceId = '' } = useParams();
  const { can } = useSession();
  const document = useDocument(sourceId);
  const withdraw = useWithdrawDocument();
  const confirm = useConfirmDocument();
  const [confirming, setConfirming] = useState(false);
  const d = document.data;

  return (
    <Page title={d?.title || 'Document'} intro={<ScreenLink screen="documents">Back to documents</ScreenLink>}>
      {document.isPending && <Loading what="the document" />}
      <ErrorNote error={document.error} />
      {d !== undefined && (
        <div>
          <Card>
            <dl className="facts">
              <dt>Status</dt><dd><Badge tone={documentStatusTone(d.status)}>{humanize(d.status)}</Badge> {d.failure_code !== null && failureText(d.failure_code)}{d.status === 'awaiting_confirmation' && AWAITING_CONFIRMATION_TEXT}</dd>
              <dt>Who may read it</dt><dd>{sensitivityLabel(d.sensitivity)}</dd>
              <dt>Kind</dt><dd>{d.company_document ? 'Company document' : 'A person’s own material (needs their consent)'}</dd>
              <dt>Size</dt><dd>{d.page_count ?? '—'} pages, {d.chunk_count} passages</dd>
              <dt>Added</dt><dd>{formatDate(d.created_at)}</dd>
            </dl>
          </Card>
          <Card title="What was blanked out">
            <p className="muted">Automatic redaction is not perfect: it can miss details and can blank out too much. Check sensitive documents by hand.</p>
            {d.redactions.length === 0 ? <p>Nothing was found to blank out.</p> : (
              <DataTable caption="Redactions by kind" columns={['Kind', 'Times', 'Of which uncertain']}>
                {d.redactions.map((r) => <tr key={r.type}><td>{humanize(r.type)}</td><td>{r.count}</td><td>{r.low_confidence}</td></tr>)}
              </DataTable>
            )}
          </Card>
          {d.status === 'awaiting_confirmation' && can('confirmSource') && (
            <Card title="Confirm this document">
              <p>It was added in your name. Confirm that it may be used.</p>
              <ErrorNote error={confirm.error} />
              <Button variant="primary" busy={confirm.isPending} onClick={() => confirm.mutate({ path: { source_id: d.id } })}>I confirm</Button>
            </Card>
          )}
          {d.status !== 'withdrawn' && can('withdrawSource') && (
            <Card title="Withdraw this document">
              <p>Its passages are erased and it is no longer used for answers. Knowledge that rests only on it is withdrawn too. This cannot be undone.</p>
              {withdraw.data !== undefined && (
                <Banner tone="success" title="The document was withdrawn">
                  {withdraw.data.items_withdrawn} knowledge items withdrawn, {withdraw.data.items_back_in_review} sent back to review.
                </Banner>
              )}
              <ErrorNote error={withdraw.error} />
              {confirming ? (
                <div className="row">
                  <Button variant="danger" busy={withdraw.isPending} onClick={() => withdraw.mutate({ path: { source_id: d.id } }, { onSettled: () => setConfirming(false) })}>Yes, withdraw it</Button>
                  <Button onClick={() => setConfirming(false)}>Keep it</Button>
                </div>
              ) : <Button variant="danger" onClick={() => setConfirming(true)}>Withdraw…</Button>}
            </Card>
          )}
        </div>
      )}
    </Page>
  );
}
