// The audit log: who did what, whether it was allowed, and a check that the record was not altered
// afterwards. The check makes tampering evident; it cannot make it impossible.
import { useState } from 'react';
import { useSession } from '../../session/session.tsx';
import { Badge, Banner, Button, Card, DataTable, Empty, ErrorNote, Facts, formatDate, humanize, Loading, Page, PartialListNote, SelectField } from '../../ui/index.tsx';
import { useAuditEvents, useCreateExport, useExport, useVerifyAuditChain, type AuditDecision } from './hooks.ts';

const DECISION_TEXT: Readonly<Record<AuditDecision, string>> = { allow: 'Allowed', deny: 'Refused', event: 'Recorded' };

export function AuditScreen() {
  const { can } = useSession();
  const [decision, setDecision] = useState<AuditDecision | ''>('');
  const events = useAuditEvents(decision);
  const items = events.items ?? [];
  return (
    <Page title="Audit log" intro="Every action and every refusal is recorded here. Entries cannot be changed or removed through the application.">
      {can('verifyAuditChain') && <VerifyChain />}
      {can('createExport') && <ExportData />}
      <h2>Entries, newest first</h2>
      <SelectField label="Show" value={decision} onChange={(e) => setDecision(e.target.value as AuditDecision | '')}>
        <option value="">Everything</option>
        <option value="allow">Allowed actions</option>
        <option value="deny">Refused attempts</option>
        <option value="event">Other recorded events</option>
      </SelectField>
      {events.isPending && <Loading what="the audit log" />}
      <ErrorNote error={events.error} />
      {events.items !== undefined && (items.length === 0 ? <Empty>No entries.</Empty> : (
        <DataTable caption="Audit entries" columns={['No.', 'When', 'Action', 'Outcome', 'Reason', 'On']}>
          {items.map((e) => (
            <tr key={e.seq}>
              <td>{e.seq}</td>
              <td>{formatDate(e.occurred_at)}</td>
              <td>{e.action}</td>
              <td><Badge tone={e.decision === 'deny' ? 'danger' : e.decision === 'allow' ? 'success' : 'neutral'}>{DECISION_TEXT[e.decision]}</Badge></td>
              <td>{humanize(e.reason_code)}</td>
              <td>{e.resource_type === null ? '—' : humanize(e.resource_type)}</td>
            </tr>
          ))}
        </DataTable>
      ))}
      {events.hasMore && <PartialListNote shown={items.length} noun="entries" busy={events.isLoadingMore} onLoadMore={events.loadMore} />}
    </Page>
  );
}

function VerifyChain() {
  const verify = useVerifyAuditChain();
  const r = verify.data;
  return (
    <Card title="Check that the log was not altered">
      <p>Each entry carries a fingerprint of the one before it. This check recomputes them all.</p>
      <ErrorNote error={verify.error} />
      {r !== undefined && (
        <>
          <Banner tone={r.ok ? 'success' : 'danger'} title={r.ok ? (r.complete ? 'No alteration was found' : 'No alteration was found in the part that was checked') : `The log does not add up at entry ${r.first_broken_seq ?? '?'}`}>
            {r.ok ? 'This shows the entries are consistent with each other. It is evidence, not proof: someone with full control of the database could rebuild the whole chain.' : (r.broken_reason ?? 'Tell the platform operator.')}
          </Banner>
          <Facts items={[
            ['Entries checked', String(r.rows_checked)],
            ['Newest entry', String(r.head_seq)],
            ['Outside anchor', r.last_anchor === null ? 'None recorded yet' : `Entry ${r.last_anchor.seq}, saved ${formatDate(r.last_anchor.anchored_at)} — ${r.last_anchor.matches ? 'matches' : 'DOES NOT MATCH'}`],
          ]} />
        </>
      )}
      <Button busy={verify.isPending} onClick={() => verify.mutate({ body: {} })}>Check the log</Button>
    </Card>
  );
}

function ExportData() {
  const create = useCreateExport();
  const [exportId, setExportId] = useState<string | null>(null);
  const job = useExport(exportId);
  const status = job.data?.status ?? create.data?.status;
  return (
    <Card title="Export the company’s data">
      <p>Prepares a copy of the company’s records, including this log. The platform operator hands over the files.</p>
      <ErrorNote error={create.error ?? job.error} />
      {status !== undefined && (
        <Banner tone={status === 'failed' ? 'danger' : status === 'done' ? 'success' : 'info'} title={`Export: ${humanize(status)}`}>
          Reference: <span className="code">{exportId}</span>
        </Banner>
      )}
      <div className="row">
        <Button busy={create.isPending} onClick={() => create.mutate(undefined, { onSuccess: (j) => setExportId(j.id) })}>Start an export</Button>
        {exportId !== null && <Button busy={job.isFetching} onClick={() => void job.refetch()}>Check its progress</Button>}
      </div>
    </Card>
  );
}
