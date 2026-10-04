// The operator's side of billing: one company's subscription and invoices, settling an invoice whose payment was
// made some other way (a bank transfer, for example) or applying a payment that is on record, and the seat limit.
// Settling takes effect at once and cannot be undone, so it asks twice and names the invoice and the amount.
import { useState } from 'react';
import { useApiMutation, useApiQuery } from '../../api/context.tsx';
import type { Invoice, Subscription } from '../../api/generated.ts';
import {
  Banner, CheckboxField, ConfirmButton, DataTable, Empty, ErrorNote, Facts, formatDate, humanize, InvoiceStatus, Loading, moneyOf, SelectField, TextField,
} from '../../ui/index.tsx';

/** What the API accepts as a reference; a long run of digits is refused there too (it could be a card number). */
const REFERENCE_OK = (text: string): boolean => text.length >= 3 && text.length <= 200 && !/[0-9]{12,}/.test(text.replace(/[ -]/g, ''));

/** An invoice the operator can settle: waiting for payment, or paid and not yet in effect. */
export const settleable = (i: Invoice): boolean => i.status === 'open' || ((i.status === 'paid' || i.status === 'paid_late') && !i.applied);
/** A renewal starts the new term today: while the running term has days left, the operator must say so explicitly. */
export const losesDays = (i: Invoice, s: Subscription): boolean => i.kind === 'renewal' && (s.phase === 'normal' || s.phase === 'renewal_open');

export function OperatorBilling({ tenantId, tenantName, mayRecord }: { tenantId: string; tenantName: string; mayRecord: boolean }) {
  const billing = useApiQuery('getTenantBilling', { path: { tenant_id: tenantId }, query: { limit: 25 } });
  const b = billing.data;
  return (
    <>
      <h3>Billing</h3>
      {billing.isPending && <Loading what="billing" />}
      <ErrorNote error={billing.error} />
      {b !== undefined && (
        <>
          <Facts items={[
            ['Plan', b.subscription.plan === null ? 'Not in the catalogue' : b.subscription.plan.name],
            ['State of the term', humanize(b.subscription.phase)],
            ['Renewal date', formatDate(b.subscription.expires_at)],
            ['Cards in use', b.subscription.seat_limit === null ? `${b.subscription.seats_used} (no seat limit)` : `${b.subscription.seats_used} of ${b.subscription.seat_limit} seats`],
            ['Automatic renewal', b.subscription.auto_renew ? 'On' : 'Off'],
            ['The next term will cost', b.subscription.next_term === null ? '—' : moneyOf(b.subscription.next_term.amount)],
            ['Payments needing attention', String(b.subscription.payments_needing_attention)],
          ]} />
          {b.invoices.length === 0 ? <Empty>No invoice has been issued for this company.</Empty> : (
            <DataTable caption={`Invoices of ${tenantName}`} columns={['Number', 'Issued', 'Kind', 'Amount', 'State']}>
              {b.invoices.map((i) => (
                <tr key={i.id}>
                  <td>{i.number}</td>
                  <td>{formatDate(i.issued_at)}</td>
                  <td>{humanize(i.kind)}</td>
                  <td>{moneyOf(i.amount)}</td>
                  <td><InvoiceStatus status={i.status} applied={i.applied} /></td>
                </tr>
              ))}
            </DataTable>
          )}
          {b.next_cursor !== null && <p className="muted">Only the newest invoices are shown.</p>}
          {mayRecord && <Settle tenantId={tenantId} tenantName={tenantName} subscription={b.subscription} invoices={b.invoices.filter(settleable)} />}
          {mayRecord && <SeatLimit tenantId={tenantId} tenantName={tenantName} subscription={b.subscription} />}
        </>
      )}
    </>
  );
}

function Settle({ tenantId, tenantName, subscription, invoices }: { tenantId: string; tenantName: string; subscription: Subscription; invoices: Invoice[] }) {
  const record = useApiMutation('recordManualPayment', ['getTenantBilling']);
  const [chosen, setChosen] = useState('');
  const [reference, setReference] = useState('');
  const [discard, setDiscard] = useState(false);
  const ref = reference.trim();
  const invoice = invoices.find((i) => i.id === chosen) ?? invoices[0];
  const needsYes = invoice !== undefined && losesDays(invoice, subscription);
  return (
    <>
      <h4>Record a payment</h4>
      <ErrorNote error={record.error} />
      {record.data !== undefined && <Banner tone="success" title={`Invoice ${record.data.number} is settled and in effect`} />}
      {invoice === undefined ? <p className="muted">No invoice is waiting. The company’s Owner starts one on the billing screen; then it can be settled here.</p> : (
        <>
          <p>For a payment that reached you some other way, or one that is on record and did not take effect. It takes effect at once and cannot be undone.</p>
          <SelectField label="Invoice" value={invoice.id} onChange={(e) => setChosen(e.target.value)}>
            {invoices.map((i) => <option key={i.id} value={i.id}>{`Invoice ${i.number}: ${moneyOf(i.amount)} (${humanize(i.kind)}, ${humanize(i.status)})`}</option>)}
          </SelectField>
          <TextField label="Where the payment is recorded" hint="A transfer or case reference. Never a payment card number." autoComplete="off" value={reference}
            error={ref !== '' && !REFERENCE_OK(ref) ? 'Use 3 to 200 characters, and no long run of digits.' : null} onChange={(e) => setReference(e.target.value)} />
          {needsYes && <CheckboxField label="The running term still has days left: start the new term today anyway (those days are lost)" checked={discard} onChange={setDiscard} />}
          <ConfirmButton variant="primary" label="Record the payment" busy={record.isPending} disabled={!REFERENCE_OK(ref) || (needsYes && !discard)}
            resetKey={`${invoice.id}|${reference}|${discard}`}
            confirmLabel={`Yes, ${tenantName} has paid ${moneyOf(invoice.amount)} for invoice ${invoice.number} (${ref})`}
            onConfirm={() => record.mutate(
              { path: { tenant_id: tenantId }, body: { invoice_id: invoice.id, amount: invoice.amount, reference: ref, ...(needsYes ? { discard_remaining_days: true } : {}) } },
              { onSuccess: () => { setReference(''); setDiscard(false); } })} />
        </>
      )}
    </>
  );
}

function SeatLimit({ tenantId, tenantName, subscription }: { tenantId: string; tenantName: string; subscription: Subscription }) {
  const set = useApiMutation('setTenantSeatLimit', ['getTenantBilling']);
  const [text, setText] = useState('');
  const n = /^[0-9]{1,6}$/.test(text.trim()) ? Number(text.trim()) : null;
  const valid = n !== null && n >= 1 && n <= 100_000;
  return (
    <>
      <h4>Seat limit</h4>
      <ErrorNote error={set.error} />
      <p className="muted">{subscription.seats_unlimited ? 'This company has no seat limit (removed by an operator).' : 'Only an operator can remove a company’s seat limit.'}</p>
      <TextField label="Seat limit" inputMode="numeric" value={text} onChange={(e) => setText(e.target.value)}
        error={text.trim() !== '' && !valid ? 'Use a whole number from 1 to 100000.' : null} />
      <ConfirmButton variant="primary" label="Set the seat limit" busy={set.isPending} disabled={!valid} resetKey={text}
        confirmLabel={`Yes, ${tenantName} may hold ${n ?? ''} person cards`}
        onConfirm={() => { if (valid) set.mutate({ path: { tenant_id: tenantId }, body: { seat_limit: n } }, { onSuccess: () => setText('') }); }} />
      {!subscription.seats_unlimited && (
        <ConfirmButton label="Remove the seat limit" busy={set.isPending} resetKey={tenantId} confirmLabel={`Yes, ${tenantName} may hold any number of person cards`}
          onConfirm={() => set.mutate({ path: { tenant_id: tenantId }, body: { seat_limit: null } })} />
      )}
    </>
  );
}
