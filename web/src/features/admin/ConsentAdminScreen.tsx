// Consents of the company's people: read them, record a withdrawal that reached the company by
// another route (a letter, a phone call), and place or lift a legal hold.
import { useState, type FormEvent } from 'react';
import type { KConsent } from '../../api/generated.ts';
import { useSession } from '../../session/session.tsx';
import { Badge, Banner, Button, Card, ConfirmButton, DataTable, Empty, ErrorNote, formatDate, humanize, Loading, Page, PartialListNote, SelectField, TextField } from '../../ui/index.tsx';
import { useConsentPeople, useConsentsOf, useHoldConsent, useRecordWithdrawal, useReleaseHold } from './hooks.ts';

const SCOPE_TEXT: Readonly<Record<string, string>> = { own_words: 'Their own words', documents: 'Their own documents', named_expert: 'Being named as the expert' };
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._-]{5,63}$/;

function stateOf(c: KConsent): { text: string; tone: 'success' | 'warning' | 'neutral' } {
  if (c.withdrawn_at !== null) return { text: c.withdrawal_status === 'completed' ? 'Withdrawn — erased' : c.withdrawal_status === 'held' ? 'Withdrawn — hidden, kept under hold' : 'Withdrawn — hidden', tone: 'warning' };
  if (c.superseded_at !== null) return { text: 'Replaced by a newer one', tone: 'neutral' };
  return { text: 'Active', tone: 'success' };
}

export function ConsentAdminScreen() {
  const { can } = useSession();
  const mayList = can('listPeople');
  const people = useConsentPeople({ enabled: mayList });
  const [person, setPerson] = useState('');
  const consents = useConsentsOf(person);
  const hold = useHoldConsent();
  const release = useReleaseHold();
  const [holding, setHolding] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const items = consents.items ?? [];
  const nameOf = (id: string): string => people.items?.find((p) => p.id === id)?.display_name ?? 'Unknown person';
  const mayHold = can('holdConsent');
  return (
    <Page title="Consents" intro="What people agreed to share. A withdrawal hides the material at once and erases it; a legal hold keeps it hidden but not erased.">
      {mayList && (
        <SelectField label="Whose consents?" value={person} onChange={(e) => setPerson(e.target.value)}>
          <option value="">Everyone</option>
          {(people.items ?? []).map((p) => <option key={p.id} value={p.id}>{p.display_name}</option>)}
        </SelectField>
      )}
      {mayList && people.hasMore && <PartialListNote shown={people.items?.length ?? 0} noun="people" busy={people.isLoadingMore} onLoadMore={people.loadMore} />}
      {can('recordWithdrawalForPerson') && person !== '' && <RecordWithdrawal key={person} personId={person} name={nameOf(person)} />}
      {consents.isPending && <Loading what="consents" />}
      <ErrorNote error={consents.error ?? people.error ?? hold.error ?? release.error} />
      {holding !== null && (
        <Card title="Place a legal hold">
          <TextField label="Reason for the hold" hint="For example the reference of the legal matter. It is written to the audit log; no personal details." maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="row">
            <Button variant="primary" busy={hold.isPending} disabled={reason.trim() === ''}
              onClick={() => hold.mutate({ path: { consent_id: holding }, body: { reason: reason.trim() } }, { onSuccess: () => { setHolding(null); setReason(''); } })}>
              Place the hold
            </Button>
            <Button onClick={() => setHolding(null)}>Cancel</Button>
          </div>
        </Card>
      )}
      {consents.items !== undefined && (items.length === 0 ? <Empty>No consents.</Empty> : (
        <DataTable caption="Consents" columns={['Person', 'For', 'State', 'Given', 'Legal hold']}>
          {items.map((c) => {
            const s = stateOf(c);
            return (
              <tr key={c.id}>
                <td>{nameOf(c.person_id)}</td>
                <td>{SCOPE_TEXT[c.scope] ?? humanize(c.scope)}</td>
                <td><Badge tone={s.tone}>{s.text}</Badge></td>
                <td>{formatDate(c.granted_at)}</td>
                <td>
                  <div className="row">
                    {c.legal_hold && <Badge tone="warning">On hold</Badge>}
                    {mayHold && c.legal_hold && <ConfirmButton resetKey={null} label="Lift the hold" confirmLabel="Yes, lift it; withdrawn material is then erased" busy={release.isPending} onConfirm={() => release.mutate({ path: { consent_id: c.id } })} />}
                    {mayHold && !c.legal_hold && c.withdrawal_status !== 'completed' && <Button onClick={() => setHolding(c.id)}>Place a hold</Button>}
                  </div>
                </td>
              </tr>
            );
          })}
        </DataTable>
      ))}
      {consents.hasMore && <PartialListNote shown={items.length} noun="consents" busy={consents.isLoadingMore} onLoadMore={consents.loadMore} />}
    </Page>
  );
}

type Scope = '' | 'own_words' | 'documents' | 'named_expert';
/** What the second step names, so that the person confirming sees exactly what will be erased. */
const SCOPE_WORDS: Readonly<Record<Scope, string>> = {
  '': 'everything they agreed to', own_words: 'their own words', documents: 'their own documents', named_expert: 'being named as the expert',
};

/** A withdrawal the person made outside the application. Erasing cannot be undone, hence the second step. */
function RecordWithdrawal({ personId, name }: { personId: string; name: string }) {
  const record = useRecordWithdrawal();
  const [reference, setReference] = useState('');
  const [scope, setScope] = useState<Scope>('');
  const valid = REFERENCE.test(reference.trim());
  const onSubmit = (e: FormEvent): void => e.preventDefault();
  return (
    <Card title={`Record a withdrawal for ${name}`}>
      <form onSubmit={onSubmit} noValidate>
        <TextField label="Your reference for their request" hint="A ticket or case number (6 to 64 letters, digits, dots, dashes). Never a name or other personal detail." value={reference}
          error={reference.trim() !== '' && !valid ? 'Use 6 to 64 letters, digits, dots, dashes or underscores.' : null} onChange={(e) => setReference(e.target.value)} />
        <SelectField label="What do they withdraw?" value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
          <option value="">Everything they agreed to</option>
          <option value="own_words">Their own words</option>
          <option value="documents">Their own documents</option>
          <option value="named_expert">Being named as the expert</option>
        </SelectField>
        <ErrorNote error={record.error} />
        {record.data !== undefined && (
          <Banner tone="success" title={record.data.withdrawals.length === 0 ? 'There was nothing left to withdraw' : `${record.data.withdrawals.length} consent(s) withdrawn`}>
            The material is hidden now and is being erased, unless a legal hold applies.
          </Banner>
        )}
        <ConfirmButton label="Record the withdrawal" busy={record.isPending} disabled={!valid} resetKey={`${personId}|${reference}|${scope}`}
          confirmLabel={`Yes, withdraw and erase for ${name}: ${SCOPE_WORDS[scope]}`}
          onConfirm={() => record.mutate({ path: { person_id: personId }, body: { reference: reference.trim(), ...(scope === '' ? {} : { scope }) } }, { onSuccess: () => setReference('') })} />
      </form>
    </Card>
  );
}
