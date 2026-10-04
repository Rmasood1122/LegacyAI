// The renewal center (features 31-35): the one renewal date of the company, what the next term costs, seats,
// automatic renewal, and the invoices. Paying asks twice, because it is about money.
// The prices shown come from a placeholder catalogue until the founder sets real ones; the screen says so.
import { useState } from 'react';
import type { Invoice, Subscription } from '../../api/generated.ts';
import { useSession } from '../../session/session.tsx';
import {
  Banner, Card, CheckboxField, ConfirmButton, DataTable, Empty, ErrorNote, Facts, formatDate, InvoiceStatus, Loading, moneyOf, Page, PartialListNote, TextField,
} from '../../ui/index.tsx';
import {
  parseSeats, PHASE_TEXT, renewPanelState, seatPrompt, useInvoices, useStartRenewal, useSubscription, useUpdateAutoRenew, useUpdateSeats, type RenewPanel,
} from './hooks.ts';

export function BillingScreen() {
  const subscription = useSubscription();
  const s = subscription.data;
  return (
    <Page title="Billing and renewal" intro="One renewal date for the whole company. When it passes without a renewal, the company becomes read-only, and later only export is possible.">
      {subscription.isPending && <Loading what="the subscription" />}
      <ErrorNote error={subscription.error} />
      {s !== undefined && <Center s={s} />}
      <Invoices />
    </Page>
  );
}

const seatsLine = (s: Subscription): string => (s.seat_limit === null
  ? `${s.seats_used} (${s.seats_unlimited ? 'the operator removed the seat limit' : 'no seat limit in the first term'})`
  : `${s.seats_used} of ${s.seat_limit} seats`);

function Center({ s }: { s: Subscription }) {
  const { can } = useSession();
  const phase = PHASE_TEXT[s.phase];
  const prompt = seatPrompt(s);
  return (
    <div>
      <Banner tone={phase.tone} title={phase.title}>{phase.text}</Banner>
      {prompt !== null && <Banner tone={prompt.tone} title={prompt.title}>{prompt.text}</Banner>}
      {s.payments_needing_attention > 0 && (
        <Banner tone="warning" title="A payment is on record that has not taken effect">
          It arrived late or could not be applied. Nothing is lost: the platform operator applies or returns it. Please get in touch with them.
        </Banner>
      )}
      {s.plan?.placeholder === true && <Banner tone="info" title="These prices are placeholders">The real plans and prices have not been set yet. No money is taken.</Banner>}
      <Card title="This term">
        <Facts items={[
          ['Plan', s.plan === null ? 'Not in the catalogue' : s.plan.name],
          ['Renewal date', formatDate(s.expires_at)],
          ['Renewal opens', formatDate(s.renewal_due)],
          ['Read-only until (if not renewed)', formatDate(s.grace_until)],
          ['Length of a term', `${s.term_days} days`],
          ['Cards in use', seatsLine(s)],
          ['Price per seat and term', s.plan === null ? '—' : moneyOf(s.plan.price_per_seat)],
          ['The next term will cost', s.next_term === null ? '—' : `${moneyOf(s.next_term.amount)} (${s.next_term.seats} seats)`],
          ['If nothing is done', s.if_nothing_is_done === 'automatic_renewal_is_tried' ? 'Renewal is tried automatically on the renewal date' : 'Read-only, then export only'],
        ]} />
      </Card>
      {can('startRenewal') && <Pay s={s} />}
      {can('updateSubscription') && <Change s={s} />}
    </div>
  );
}

const forWhat = (i: Pick<Invoice, 'kind' | 'seats' | 'term_days'>): string => (i.kind === 'seats' ? `${i.seats} more seats` : `${i.seats} seats, ${i.term_days} days`);

function PayPanel({ panel, s, busy, onPay }: { panel: RenewPanel; s: Subscription; busy: boolean; onPay: () => void }) {
  switch (panel.kind) {
    case 'settled':
      return <Banner tone="success" title={panel.invoice.kind === 'seats' ? 'The seats were added' : 'The term was renewed'}>Nothing was to pay. It took effect today.</Banner>;
    case 'waiting':
      return (
        <Banner tone="info" title={`Invoice ${panel.invoice.number} is waiting for payment`}>
          {moneyOf(panel.invoice.amount)} for {forWhat(panel.invoice)}. {panel.byOperator
            ? 'No payment provider is connected: pay as agreed with the platform operator, who then records the payment.'
            : 'It takes effect when the payment arrives. Nothing changes before that.'}
        </Banner>
      );
    case 'no_price':
      return <Banner tone="warning" title="This plan has no price">Ask the platform operator; nothing can be invoiced until it has one.</Banner>;
    case 'nothing_due':
      return <p>Renewal opens on {formatDate(s.renewal_due)}. A new term starts on the day of payment, so the days that are left would be lost by renewing earlier.</p>;
    case 'can_pay': {
      const amount = moneyOf(panel.due.amount);
      const seats = panel.due.kind === 'seats';
      return (
        <>
          {panel.byOperator && <Banner tone="warning" title="No payment provider is connected">An invoice is issued; the platform operator records your payment.</Banner>}
          <ConfirmButton variant="primary" busy={busy} resetKey={`${panel.due.kind}|${panel.due.seats}|${amount}|${s.expires_at}`} onConfirm={onPay}
            label={seats ? `Pay for ${panel.due.seats} more seats` : 'Renew now'}
            confirmLabel={seats ? `Yes, add ${panel.due.seats} seats for ${amount}` : `Yes, renew for ${s.term_days} days for ${amount}`} />
        </>
      );
    }
  }
}

function Pay({ s }: { s: Subscription }) {
  const start = useStartRenewal();
  return (
    <Card title="Renew and pay">
      <ErrorNote error={start.error} />
      <PayPanel panel={renewPanelState(s, start.data)} s={s} busy={start.isPending} onPay={() => start.mutate({})} />
    </Card>
  );
}

function Change({ s }: { s: Subscription }) {
  const seatsUpdate = useUpdateSeats();
  const autoRenew = useUpdateAutoRenew();
  const current = s.seats_requested ?? s.seat_limit;
  const [seats, setSeats] = useState(current === null ? '' : String(current));
  const parsed = parseSeats(seats);
  const locked = s.seats_unlimited || s.open_invoice !== null;
  const perSeat = s.plan === null ? null : moneyOf(s.plan.price_per_seat);
  return (
    <Card title="Seats and automatic renewal">
      <ErrorNote error={seatsUpdate.error} />
      {s.seats_unlimited && <p className="muted">The platform operator removed the seat limit for this company. Ask the operator to change it.</p>}
      {!s.seats_unlimited && s.open_invoice !== null && <p className="muted">An invoice is waiting to be paid; seats can change again once it is paid or closed.</p>}
      <TextField label="Seats" inputMode="numeric" value={seats} disabled={locked} onChange={(e) => setSeats(e.target.value)}
        hint={`How many person cards the company may have. More seats count once they are paid for${perSeat === null ? '' : ` (${perSeat} per seat, for the whole term)`}; fewer seats count from the next renewal.`}
        error={parsed.ok || seats.trim() === '' ? null : 'Use a whole number from 1 to 100000.'} />
      <ConfirmButton variant="primary" label="Change the seats" busy={seatsUpdate.isPending} disabled={locked || !parsed.ok || parsed.seats === current} resetKey={seats}
        confirmLabel={parsed.ok ? `Yes, ask for ${parsed.seats} seats` : 'Change'}
        onConfirm={() => { if (parsed.ok) seatsUpdate.mutate({ body: { seats: parsed.seats } }); }} />
      <h3>Automatic renewal</h3>
      <ErrorNote error={autoRenew.error} />
      <CheckboxField label="Renew automatically on the renewal date" checked={s.auto_renew} disabled={autoRenew.isPending || (!s.payments_available && !s.auto_renew)}
        onChange={(checked) => autoRenew.mutate({ body: { auto_renew: checked } })} />
      <p className="muted">It is tried on the renewal date, at most three times. If every attempt fails you are told, and the company becomes read-only as it would without it.</p>
    </Card>
  );
}

function Invoices() {
  const invoices = useInvoices();
  const items = invoices.items ?? [];
  return (
    <div>
      <h2>Invoices</h2>
      {invoices.isPending && <Loading what="invoices" />}
      <ErrorNote error={invoices.error} />
      {invoices.items !== undefined && (items.length === 0 ? <Empty>No invoice has been issued yet.</Empty> : (
        <DataTable caption="Invoices" columns={['Number', 'Issued', 'For', 'Amount', 'State', 'Paid']}>
          {items.map((i) => (
            <tr key={i.id}>
              <td>{i.number}</td>
              <td>{formatDate(i.issued_at)}</td>
              <td>{forWhat(i)}{i.automatic ? ' (automatic)' : ''}{i.settlement === 'operator' ? ' (recorded by the operator)' : ''}</td>
              <td>{moneyOf(i.amount)}</td>
              <td><InvoiceStatus status={i.status} applied={i.applied} /></td>
              <td>{formatDate(i.paid_at)}</td>
            </tr>
          ))}
        </DataTable>
      ))}
      {invoices.hasMore && <PartialListNote shown={items.length} noun="invoices" busy={invoices.isLoadingMore} onLoadMore={invoices.loadMore} />}
    </div>
  );
}
