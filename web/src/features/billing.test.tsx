// Billing on the screens (features 31-35): the renewal center of the Owner, and the operator's side.
// Synthetic data only; the stand-in API takes no money and calls nobody.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { Invoice, Subscription } from '../api/generated.ts';
import { FakeApi, makeSession, permissionsFor, problem, renderScreen, sessionValue } from '../test/harness.tsx';
import { money } from '../ui/index.tsx';
import { BillingScreen } from './billing/BillingScreen.tsx';
import { parseSeats, renewPanelState, seatPrompt } from './billing/hooks.ts';
import { losesDays, OperatorBilling, settleable } from './operator/OperatorBilling.tsx';

const ID = (n: number): string => `01a10174-0000-7000-8000-${String(n).padStart(12, '0')}`;
const T = '2026-10-01T09:00:00.000Z';
const page = <X,>(items: X[]) => ({ items, next_cursor: null });
const as = (...ops: Parameters<typeof permissionsFor>) => sessionValue(makeSession(permissionsFor(...ops)));
const OWNER = ['getSubscription', 'listInvoices', 'updateSubscription', 'startRenewal'] as const;
const usd = (amount_minor: number) => ({ amount_minor, currency: 'USD' });

const subscription = (over: Partial<Subscription> = {}): Subscription => ({
  plan: { code: 'pilot', name: 'Pilot', price_per_seat: usd(1500), placeholder: true }, seats_requested: null, seat_limit: 5, seats_unlimited: false,
  seats_used: 2, seat_state: 'ok', auto_renew: false, term_days: 90, expires_at: '2026-12-01T00:00:00.000Z', renewal_due: '2026-11-17T00:00:00.000Z',
  grace_until: '2026-12-15T00:00:00.000Z', read_only: false, export_only: false, phase: 'renewal_open', next_term: { seats: 5, amount: usd(7500) },
  due_now: { kind: 'renewal', seats: 5, amount: usd(7500) }, open_invoice: null, can_renew_now: true, payments_available: true,
  payments_needing_attention: 0, if_nothing_is_done: 'read_only_then_export_only', ...over,
});
const invoice = (over: Partial<Invoice> = {}): Invoice => ({
  id: ID(60), number: 1, kind: 'renewal', status: 'open', plan_code: 'pilot', seats: 5, term_days: 90, amount: usd(7500), automatic: false, settlement: null,
  issued_at: T, paid_at: null, closed_at: null, applied: false, ...over,
});
const early = { phase: 'normal', can_renew_now: false, due_now: null } as const;

describe('the words and numbers', () => {
  it('an amount is written from whole numbers, never rounded, with the decimals its currency has', () => {
    expect(money(7500, 'USD')).toBe('75.00 USD');
    expect(money(5, 'USD')).toBe('0.05 USD');
    expect(money(0, 'EUR')).toBe('0.00 EUR');
    expect(money(123456789, 'USD')).toBe('1234567.89 USD');
    expect(money(7500, 'JPY')).toBe('7500 JPY');          // no smaller unit
    expect(money(7500, 'KWD')).toBe('7.500 KWD');         // thousandths
  });

  it('the seat prompt speaks only when seats are nearly or fully used', () => {
    expect(seatPrompt({ seat_limit: null, seats_used: 400, seat_state: 'not_limited' })).toBeNull();
    expect(seatPrompt({ seat_limit: 10, seats_used: 3, seat_state: 'ok' })).toBeNull();
    expect(seatPrompt({ seat_limit: 10, seats_used: 9, seat_state: 'near' })?.title).toBe('1 of 10 seats left');
    expect(seatPrompt({ seat_limit: 10, seats_used: 10, seat_state: 'reached' })?.title).toBe('All 10 seats are in use');
  });

  it('seats are a whole number from 1 to 100000; the Owner cannot ask for "no limit"', () => {
    expect(parseSeats(' 12 ')).toEqual({ ok: true, seats: 12 });
    for (const bad of ['', '0', '-1', '1.5', 'ten', '100001', '1e3']) expect(parseSeats(bad), bad).toEqual({ ok: false });
  });

  it('the pay panel shows exactly one thing, decided by what the API says', () => {
    const started = { invoice: invoice(), already_open: false, collected_by: 'provider' } as const;
    expect(renewPanelState(subscription(), undefined)).toMatchObject({ kind: 'can_pay', byOperator: false, due: { kind: 'renewal' } });
    expect(renewPanelState(subscription({ payments_available: false }), undefined)).toMatchObject({ kind: 'can_pay', byOperator: true });
    // an invoice is waiting: that wins over everything, also over "can renew"
    expect(renewPanelState(subscription({ open_invoice: invoice(), can_renew_now: false }), started).kind).toBe('waiting');
    expect(renewPanelState(subscription({ ...early }), undefined).kind).toBe('nothing_due');
    expect(renewPanelState(subscription({ ...early, plan: null, next_term: null }), undefined).kind).toBe('no_price');
    // nothing was to pay: it took effect at once
    expect(renewPanelState(subscription({ ...early }), { ...started, invoice: invoice({ status: 'paid', applied: true, settlement: 'no_charge' }) }).kind).toBe('settled');
    // "can renew" from the API without anything due is not turned into a button
    expect(renewPanelState(subscription({ can_renew_now: true, due_now: null }), undefined).kind).toBe('nothing_due');
  });
});

describe('the renewal center', () => {
  it('shows the one renewal date, what the next term costs, that prices are placeholders, and the invoices', async () => {
    const api = new FakeApi({ getSubscription: () => subscription(), listInvoices: () => page([invoice({ status: 'paid', paid_at: T, applied: true, settlement: 'provider' })]) });
    renderScreen(<BillingScreen />, { api, session: as(...OWNER) });
    expect(await screen.findByText('Renewal is open')).toBeTruthy();
    expect(screen.getByText('These prices are placeholders')).toBeTruthy();
    expect(screen.getByText('2 of 5 seats')).toBeTruthy();
    expect(screen.getByText('75.00 USD (5 seats)')).toBeTruthy();
    expect(screen.getByText('Read-only, then export only')).toBeTruthy();
    expect(await screen.findAllByText('Paid')).toHaveLength(2);   // the column and this invoice's state
  });

  it('renewing asks twice and names the amount; afterwards the screen says the invoice waits and nothing changes until the payment arrives', async () => {
    const user = userEvent.setup();
    let open: Invoice | null = null;
    const api = new FakeApi({
      getSubscription: () => (open === null ? subscription() : subscription({ open_invoice: open, can_renew_now: false })),
      listInvoices: () => page([]),
      startRenewal: () => {
        open = invoice();
        return { invoice: open, already_open: false, collected_by: 'provider' as const };
      },
    });
    renderScreen(<BillingScreen />, { api, session: as(...OWNER) });
    await user.click(await screen.findByRole('button', { name: 'Renew now…' }));
    expect(api.callsTo('startRenewal')).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Yes, renew for 90 days for 75.00 USD' }));
    expect(await screen.findByText('Invoice 1 is waiting for payment')).toBeTruthy();
    expect(screen.getByText(/It takes effect when the payment arrives\. Nothing changes before that\.$/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Renew now…' })).toBeNull();
    expect(api.callsTo('startRenewal')).toHaveLength(1);
  });

  it('too early: there is no button; a payment that did not take effect is said in words, and so is a late one in the list', async () => {
    const api = new FakeApi({
      getSubscription: () => subscription({ ...early, payments_needing_attention: 1 }),
      listInvoices: () => page([invoice({ status: 'paid_late', paid_at: T, settlement: 'provider' })]),
    });
    renderScreen(<BillingScreen />, { api, session: as(...OWNER) });
    expect(await screen.findByText(/^Renewal opens on /)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Renew now…' })).toBeNull();
    expect(screen.getByText('A payment is on record that has not taken effect')).toBeTruthy();
    expect(await screen.findByText('Paid late, not yet in effect')).toBeTruthy();
  });

  it('the upgrade prompt: seats used up is said in words; asking for more asks twice; then the added seats are to be PAID; a refusal by the API is shown', async () => {
    const user = userEvent.setup();
    let fail = true;
    let asked = false;
    const reached = { seat_limit: 2, seats_used: 2, seat_state: 'reached', ...early, next_term: { seats: 2, amount: usd(3000) } } as const;
    const api = new FakeApi({
      getSubscription: () => subscription(asked
        ? { ...reached, seats_requested: 4, can_renew_now: true, due_now: { kind: 'seats', seats: 2, amount: usd(3000) } } : reached),
      listInvoices: () => page([]),
      updateSubscription: () => {
        if (fail) throw problem(409, '2 cards are in use');
        asked = true;
        return subscription({ ...reached, seats_requested: 4 });
      },
      startRenewal: () => ({ invoice: invoice({ kind: 'seats', seats: 2, amount: usd(3000), number: 2 }), already_open: false, collected_by: 'provider' as const }),
    });
    renderScreen(<BillingScreen />, { api, session: as(...OWNER) });
    expect(await screen.findByText('All 2 seats are in use')).toBeTruthy();
    const field = screen.getByLabelText('Seats');
    await user.clear(field);
    await user.type(field, '0');
    expect(screen.getByText('Use a whole number from 1 to 100000.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Change the seats…' }) as HTMLButtonElement).disabled).toBe(true);
    await user.clear(field);
    await user.type(field, '4');
    await user.click(screen.getByRole('button', { name: 'Change the seats…' }));
    expect(api.callsTo('updateSubscription')).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Yes, ask for 4 seats' }));
    expect(await screen.findByText(/2 cards are in use/)).toBeTruthy();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Change the seats…' }));
    await user.click(screen.getByRole('button', { name: 'Yes, ask for 4 seats' }));
    await waitFor(() => expect(api.callsTo('updateSubscription')).toHaveLength(2));
    expect(api.callsTo('updateSubscription')[1]?.body).toEqual({ seats: 4 });
    // asked for is not paid for: the notice stays, and the screen offers to pay for the two added seats
    await user.click(await screen.findByRole('button', { name: 'Pay for 2 more seats…' }));
    expect(screen.getByText('All 2 seats are in use')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Yes, add 2 seats for 30.00 USD' }));
    await waitFor(() => expect(api.callsTo('startRenewal')).toHaveLength(1));
  });

  it('seats cannot be changed while an invoice waits, or when the operator removed the limit', async () => {
    const waiting = new FakeApi({ getSubscription: () => subscription({ open_invoice: invoice(), can_renew_now: false }), listInvoices: () => page([invoice()]) });
    const { unmount } = renderScreen(<BillingScreen />, { api: waiting, session: as(...OWNER) });
    expect(await screen.findByText(/seats can change again once it is paid or closed/)).toBeTruthy();
    expect((screen.getByLabelText('Seats') as HTMLInputElement).disabled).toBe(true);
    unmount();
    const unlimited = new FakeApi({ getSubscription: () => subscription({ seat_limit: null, seats_unlimited: true, seat_state: 'not_limited' }), listInvoices: () => page([]) });
    renderScreen(<BillingScreen />, { api: unlimited, session: as(...OWNER) });
    expect(await screen.findByText(/The platform operator removed the seat limit for this company/)).toBeTruthy();
    expect((screen.getByLabelText('Seats') as HTMLInputElement).disabled).toBe(true);
  });

  it('automatic renewal is one switch with its own error; a card without the right to change sees no controls', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({ getSubscription: () => subscription(), listInvoices: () => page([]), updateSubscription: () => subscription({ auto_renew: true }) });
    const { unmount } = renderScreen(<BillingScreen />, { api, session: as(...OWNER) });
    await user.click(await screen.findByLabelText('Renew automatically on the renewal date'));
    await waitFor(() => expect(api.callsTo('updateSubscription')[0]?.body).toEqual({ auto_renew: true }));
    unmount();
    renderScreen(<BillingScreen />, { api: new FakeApi({ getSubscription: () => subscription(), listInvoices: () => page([]) }), session: as('getSubscription', 'listInvoices') });
    expect(await screen.findByText('Renewal is open')).toBeTruthy();
    expect(screen.queryByLabelText('Seats')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Renew now…' })).toBeNull();
  });
});

describe('the operator', () => {
  const failed = invoice({ status: 'failed', closed_at: T });
  const open = invoice({ id: ID(61), number: 2 });
  const billing = (invoices: Invoice[], over: Partial<Subscription> = {}) => ({ tenant_id: ID(1), subscription: subscription({ phase: 'grace', ...over }), invoices, next_cursor: null });

  it('which invoices can be settled, and when a renewal would throw days away', () => {
    expect(settleable(open)).toBe(true);
    expect(settleable(invoice({ status: 'paid_late', settlement: 'provider' }))).toBe(true);
    expect(settleable(invoice({ status: 'paid', applied: false, settlement: 'provider' }))).toBe(true);
    for (const done of [failed, invoice({ status: 'void' }), invoice({ status: 'paid', applied: true, settlement: 'provider' })]) expect(settleable(done)).toBe(false);
    expect(losesDays(open, subscription({ phase: 'renewal_open' }))).toBe(true);
    expect(losesDays(open, subscription({ phase: 'grace' }))).toBe(false);
    expect(losesDays(invoice({ kind: 'seats' }), subscription({ phase: 'normal' }))).toBe(false);
  });

  it('settles a named invoice: asks twice, names the company, the invoice and the amount, and refuses a run of digits', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({
      getTenantBilling: () => billing([open, failed]),
      recordManualPayment: () => invoice({ id: ID(61), number: 2, status: 'paid', applied: true, settlement: 'operator' }),
    });
    renderScreen(<OperatorBilling tenantId={ID(1)} tenantName="Synthetic Co" mayRecord />, { api, session: as('getTenantBilling', 'recordManualPayment') });
    expect(await screen.findByText('Payment failed')).toBeTruthy();
    expect(screen.getByText('Grace')).toBeTruthy();
    const field = screen.getByLabelText('Where the payment is recorded');
    await user.type(field, '4111 1111 1111 1111');
    expect(screen.getByText('Use 3 to 200 characters, and no long run of digits.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Record the payment…' }) as HTMLButtonElement).disabled).toBe(true);
    await user.clear(field);
    await user.type(field, 'TRANSFER-2026-0001');
    await user.click(screen.getByRole('button', { name: 'Record the payment…' }));
    expect(api.callsTo('recordManualPayment')).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Yes, Synthetic Co has paid 75.00 USD for invoice 2 (TRANSFER-2026-0001)' }));
    expect(await screen.findByText('Invoice 2 is settled and in effect')).toBeTruthy();
    expect(api.callsTo('recordManualPayment')[0]).toMatchObject({ path: { tenant_id: ID(1) }, body: { invoice_id: ID(61), amount: usd(7500), reference: 'TRANSFER-2026-0001' } });
    expect((api.callsTo('recordManualPayment')[0]?.body as Record<string, unknown>).discard_remaining_days).toBeUndefined();
  });

  it('a renewal while the term still runs needs an explicit yes before the button works', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({ getTenantBilling: () => billing([open], { phase: 'renewal_open' }), recordManualPayment: () => invoice({ status: 'paid', applied: true, settlement: 'operator' }) });
    renderScreen(<OperatorBilling tenantId={ID(1)} tenantName="Synthetic Co" mayRecord />, { api, session: as('getTenantBilling', 'recordManualPayment') });
    await user.type(await screen.findByLabelText('Where the payment is recorded'), 'CASE-0007');
    expect((screen.getByRole('button', { name: 'Record the payment…' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByLabelText(/^The running term still has days left/));
    await user.click(screen.getByRole('button', { name: 'Record the payment…' }));
    await user.click(screen.getByRole('button', { name: /^Yes, Synthetic Co has paid 75\.00 USD for invoice 2/ }));
    await waitFor(() => expect(api.callsTo('recordManualPayment')[0]?.body).toMatchObject({ invoice_id: ID(61), discard_remaining_days: true }));
  });

  it('with nothing to settle it says so; the seat limit can be set or removed, each asking twice', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({ getTenantBilling: () => billing([failed]), setTenantSeatLimit: () => subscription({ seat_limit: null, seats_unlimited: true }) });
    renderScreen(<OperatorBilling tenantId={ID(1)} tenantName="Synthetic Co" mayRecord />, { api, session: as('getTenantBilling', 'recordManualPayment') });
    expect(await screen.findByText(/^No invoice is waiting\./)).toBeTruthy();
    expect(screen.queryByLabelText('Where the payment is recorded')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Remove the seat limit…' }));
    expect(api.callsTo('setTenantSeatLimit')).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Yes, Synthetic Co may hold any number of person cards' }));
    await waitFor(() => expect(api.callsTo('setTenantSeatLimit')[0]?.body).toEqual({ seat_limit: null }));
  });

  it('without the right to record, only reads', async () => {
    renderScreen(<OperatorBilling tenantId={ID(1)} tenantName="Synthetic Co" mayRecord={false} />, { api: new FakeApi({ getTenantBilling: () => billing([open, failed]) }), session: as('getTenantBilling') });
    expect(await screen.findByText('Payment failed')).toBeTruthy();
    expect(screen.queryByLabelText('Where the payment is recorded')).toBeNull();
    expect(screen.queryByLabelText('Seat limit')).toBeNull();
  });
});
