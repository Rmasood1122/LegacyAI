// One card: its state, and everything an administrator can do with it. Actions that issue new
// secrets show them exactly once.
import { useState } from 'react';
import { useParams } from 'react-router';
import type { Card as CardRecord, CardWithSecrets, EnrollmentTokenResponse, RoleAssignmentInput } from '../../api/generated.ts';
import { signInAddress } from '../../navigation/cardLink.ts';
import { ScreenLink } from '../../navigation/ScreenLink.tsx';
import { useSession } from '../../session/session.tsx';
import {
  Badge, Banner, Button, Card, CheckboxField, ConfirmButton, DataTable, ErrorNote, Facts, formatDate, humanize, Loading, OneTimeSecrets, Page, PartialListNote, SelectField, TextField,
} from '../../ui/index.tsx';
import { QrCode } from '../../ui/qr.tsx';
import type { ShownSecrets } from '../../ui/index.tsx';
import {
  CARD_STATE_TEXT, cardTone, describeRestriction, useAssignRole, useCard, useCardEvents, useCardRestrictions, useNewEnrollmentToken, useReinstateCard, useRemoveRole, useRenewCard,
  lockReasonText, useCompany, useReplaceCard, useRevokeCard, useRoles, useSaveRestrictions, useSuspendCard, useUnlockCard, withReadOnly,
} from './hooks.ts';

type RoleKey = RoleAssignmentInput['role_key'];
type Shown = ShownSecrets;

const fromCard = (title: string, r: CardWithSecrets): Shown =>
  ({ title, cardNumber: r.card.card_number, sc: r.sc, enrollmentToken: r.enrollment_token, tokenExpiresAt: r.enrollment_token_expires_at, alreadyShown: r.secret_already_shown });
const fromToken = (title: string, r: EnrollmentTokenResponse): Shown =>
  ({ title, enrollmentToken: r.enrollment_token, tokenExpiresAt: r.enrollment_token_expires_at, alreadyShown: r.secret_already_shown });

export function CardScreen() {
  const { cardId = '' } = useParams();
  const { can } = useSession();
  const card = useCard(cardId);
  const data = card.data;
  return (
    <Page title="Card" actions={<ScreenLink screen="cards">All cards</ScreenLink>}>
      {card.isPending && <Loading what="the card" />}
      <ErrorNote error={card.error} />
      {data !== undefined && (
        <>
          <Card>
            <Facts items={[
              ['Card number', <span key="n" className="code">{data.card_number}</span>],
              ['Kind', data.kind === 'company' ? 'Company card' : 'Person'],
              ['State', <span key="s"><Badge tone={cardTone(data.state)}>{CARD_STATE_TEXT[data.state]}</Badge> {data.locked && <Badge tone="danger">{lockReasonText(data.lock_reason)}</Badge>}</span>],
              ['Issued', formatDate(data.issued_at)],
              ['Valid until', formatDate(data.expires_at)],
              ['Read-only grace period until', formatDate(data.grace_until)],
              ['Renewed', `${data.renewal_count} ${data.renewal_count === 1 ? 'time' : 'times'}`],
            ]} />
          </Card>
          {data.kind === 'person' && <CardQr card={data} />}
          <Actions card={data} />
          {can('listCardRoles') && <Roles card={data} />}
          {can('getCardRestrictions') && <Restrictions cardId={data.id} />}
          {can('listCardEvents') && <Events cardId={data.id} />}
        </>
      )}
    </Page>
  );
}

function Actions({ card }: { card: CardRecord }) {
  const { can } = useSession();
  const suspend = useSuspendCard();
  const reinstate = useReinstateCard();
  const revoke = useRevokeCard();
  const replace = useReplaceCard();
  const renew = useRenewCard();
  const unlock = useUnlockCard();
  const token = useNewEnrollmentToken();
  const [reason, setReason] = useState('');
  const [replaceReason, setReplaceReason] = useState<'lost' | 'damaged' | 'compromised'>('lost');
  // Secrets live in this state only: removed on confirmation, and gone when the screen is left.
  const [shown, setShown] = useState<Shown | null>(null);
  const path = { card_id: card.id };
  const busy = suspend.isPending || reinstate.isPending || revoke.isPending || replace.isPending || renew.isPending || unlock.isPending || token.isPending;
  const error = suspend.error ?? reinstate.error ?? revoke.error ?? replace.error ?? renew.error ?? unlock.error ?? token.error;
  // What the card's state allows (the database refuses anything else): an issued card can only be revoked.
  const live = card.state === 'issued' || card.state === 'active';
  const canSuspend = card.state === 'active';
  const canRevoke = live || card.state === 'suspended' || card.state === 'expired';
  const canReplace = card.state === 'active' || card.state === 'suspended' || card.state === 'expired';
  const canRenew = card.state === 'active' || card.state === 'expired';
  const hasReason = reason.trim().length >= 3;

  if (shown !== null) return <OneTimeSecrets {...shown} onDone={() => setShown(null)} />;
  return (
    <Card title="What you can do with this card">
      <ErrorNote error={error} />
      {((can('suspendCard') && canSuspend) || (can('revokeCard') && canRevoke)) && (
        <TextField label="Reason" hint="Needed to suspend or revoke. It is written to the audit log; do not put personal details in it." maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
      )}
      <div className="row">
        {can('suspendCard') && canSuspend && <Button busy={busy} disabled={!hasReason} onClick={() => suspend.mutate({ path, body: { reason: reason.trim() } }, { onSuccess: () => setReason('') })}>Suspend</Button>}
        {can('reinstateCard') && card.state === 'suspended' && <Button variant="primary" busy={busy} onClick={() => reinstate.mutate({ path })}>Reinstate</Button>}
        {can('revokeCard') && canRevoke && (
          <ConfirmButton label="Revoke for good" confirmLabel="Yes, revoke this card for good" busy={busy} disabled={!hasReason} resetKey={reason}
            onConfirm={() => revoke.mutate({ path, body: { reason: reason.trim() } }, { onSuccess: () => setReason('') })} />
        )}
        {can('renewCard') && canRenew && (
          <ConfirmButton resetKey={null} variant="primary" label="Renew" confirmLabel="Yes, renew this card" busy={busy}
            onConfirm={() => renew.mutate({ path, body: {} }, { onSuccess: (r) => { renew.reset(); setShown(fromCard('The card was renewed', r)); } })} />
        )}
        {can('unlockCard') && card.locked && (
          <ConfirmButton resetKey={null} variant="primary" label="Unlock with a new 3-digit code" confirmLabel="Yes, unlock it" busy={busy}
            onConfirm={() => unlock.mutate({ path }, { onSuccess: (r) => { unlock.reset(); setShown(fromCard('The card was unlocked', r)); } })} />
        )}
        {can('issueEnrollmentToken') && live && (
          <ConfirmButton resetKey={null} variant="primary" label="New set-up token" confirmLabel="Yes, issue a new set-up token" busy={busy}
            onConfirm={() => token.mutate({ path, body: {} }, { onSuccess: (r) => { token.reset(); setShown(fromToken('A new set-up token', r)); } })} />
        )}
      </div>
      {can('replaceCard') && canReplace && (
        <div className="row">
          <SelectField label="Replace this card because it was" value={replaceReason} onChange={(e) => setReplaceReason(e.target.value as typeof replaceReason)}>
            <option value="lost">lost</option>
            <option value="damaged">damaged</option>
            <option value="compromised">seen or copied by someone else</option>
          </SelectField>
          <ConfirmButton label="Replace with a new card" confirmLabel="Yes, replace it; the old card stops working" busy={busy} resetKey={replaceReason}
            onConfirm={() => replace.mutate({ path, body: { reason: replaceReason } }, { onSuccess: (r) => { replace.reset(); setShown(fromCard('The replacement card', r)); } })} />
        </div>
      )}
      {card.replaced_by_card_id !== null && <p><ScreenLink screen="card" id={card.replaced_by_card_id}>Open the card that replaced this one</ScreenLink></p>}
    </Card>
  );
}

function Roles({ card }: { card: CardRecord }) {
  const { can } = useSession();
  const roles = useRoles();
  const assign = useAssignRole();
  const remove = useRemoveRole();
  const [adding, setAdding] = useState<RoleKey | ''>('');
  const held = new Set(card.roles.map((r) => r.role_key));
  const addable = (roles.data?.items ?? []).filter((r) => r.enabled_for_tenant && !held.has(r.role_key));
  const name = (key: string): string => roles.data?.items.find((r) => r.role_key === key)?.display_name ?? humanize(key);
  return (
    <Card title="Roles">
      <ErrorNote error={roles.error ?? assign.error ?? remove.error} />
      {card.roles.length === 0 ? <p className="muted">This card has no role, so it can do nothing.</p> : (
        <ul>
          {card.roles.map((r) => (
            <li key={`${r.role_key}:${r.department_id ?? ''}`}>
              <span className="row">
                <span>{name(r.role_key)}</span>
                {can('removeCardRole') && <ConfirmButton resetKey={null} label="Take away" confirmLabel={`Yes, take away “${name(r.role_key)}”`} busy={remove.isPending} onConfirm={() => remove.mutate({ path: { card_id: card.id, role_key: r.role_key } })} />}
              </span>
            </li>
          ))}
        </ul>
      )}
      {can('assignCardRole') && addable.length > 0 && (
        <div className="row">
          <SelectField label="Give another role" value={adding} onChange={(e) => setAdding(e.target.value as RoleKey | '')}>
            <option value="">Choose a role…</option>
            {addable.map((r) => <option key={r.role_key} value={r.role_key}>{r.display_name}</option>)}
          </SelectField>
          <Button busy={assign.isPending} disabled={adding === ''} onClick={() => adding !== '' && assign.mutate({ path: { card_id: card.id }, body: { role_key: adding } }, { onSuccess: () => setAdding('') })}>Give the role</Button>
        </div>
      )}
    </Card>
  );
}

function Restrictions({ cardId }: { cardId: string }) {
  const { can } = useSession();
  const restrictions = useCardRestrictions(cardId, { enabled: true });
  const save = useSaveRestrictions();
  const items = restrictions.data?.items ?? [];
  const readOnly = items.some((r) => r.type === 'read_only' && r.enabled);
  return (
    <Card title="Extra limits on this card">
      {restrictions.isPending && <Loading what="the limits" />}
      <ErrorNote error={restrictions.error ?? save.error} />
      {restrictions.data !== undefined && (items.length === 0 ? <p className="muted">No extra limits.</p> : <ul>{items.map((r) => <li key={r.type}>{describeRestriction(r)}</li>)}</ul>)}
      {restrictions.data !== undefined && can('putCardRestrictions') && (
        <>
          <CheckboxField label="Read-only: this card may read but not change anything" checked={readOnly} disabled={save.isPending}
            onChange={(on) => save.mutate({ path: { card_id: cardId }, body: { restrictions: withReadOnly(items, on) } })} />
          <p className="hint">Usage caps, time windows and network lists are shown here but cannot be edited on this screen yet.</p>
        </>
      )}
    </Card>
  );
}

function Events({ cardId }: { cardId: string }) {
  const events = useCardEvents(cardId, { enabled: true });
  const items = events.items ?? [];
  return (
    <Card title="What happened with this card">
      {events.isPending && <Loading what="the history" />}
      <ErrorNote error={events.error} />
      {events.items !== undefined && items.length === 0 && <p className="muted">Nothing yet.</p>}
      {items.length > 0 && (
        <DataTable caption="Card history" columns={['When', 'What', 'Device']}>
          {items.map((e) => <tr key={e.id}><td>{formatDate(e.occurred_at)}</td><td>{humanize(e.event_type)}</td><td>{e.device ?? '—'}</td></tr>)}
        </DataTable>
      )}
      {events.hasMore && <PartialListNote shown={items.length} noun="entries" busy={events.isLoadingMore} onLoadMore={events.loadMore} />}
      {events.items !== undefined && items.length > 0 && !events.hasMore && <Banner tone="info">This is the whole history of the card.</Banner>}
    </Card>
  );
}

/** While this class is on <body>, printing prints the card section only (styles/base.css). */
const PRINTING_CARD = 'printing-card';

/**
 * Prints the card and nothing else: no roles, no history, no buttons.
 * The class is taken off again only when the browser says printing is over ("afterprint"). Some browsers (phones)
 * return from print() before the page is rendered; taking the class off straight away would then print the whole
 * card screen. If "afterprint" never comes, the class goes after five minutes; until then a second print from this
 * screen prints the card only, which is the safe direction.
 */
function printCardOnly(): void {
  const done = (): void => document.body.classList.remove(PRINTING_CARD);
  document.body.classList.add(PRINTING_CARD);
  window.addEventListener('afterprint', done, { once: true });
  window.setTimeout(done, 5 * 60_000);
  window.print();
}

/** The card as a QR code: it opens the sign-in screen with the card number filled in - never the 3-digit code. */
function CardQr({ card }: { card: CardRecord }) {
  const { can } = useSession();
  const company = useCompany({ enabled: can('getCurrentTenant') });
  const address = signInAddress(window.location.origin, card.card_number);
  if (address === null) return null;
  const label = `QR code that opens the sign-in screen for card ${card.card_number}`;
  return (
    <Card title="This card as a QR code">
      <div className="qr-card no-print">
        <QrCode text={address} label={label} />
        <div>
          <p>Scanning it opens the sign-in screen with this card number filled in. It holds the card number only.</p>
          <p className="muted">
            The 3-digit code and the passkey or authenticator app are still needed to sign in, so the QR code alone lets nobody in.
            NFC cards are not supported.
          </p>
          <p><Button onClick={printCardOnly}>Print this card</Button></p>
          <p className="muted">Only the card is printed: its number, how long it is valid, and the QR code.</p>
        </div>
      </div>
      {/* What goes on paper. Hidden on the screen; when "Print this card" is used it is the only thing printed. */}
      <section className="print-card" aria-label="The card as it is printed">
        {company.data !== undefined && <p className="print-card-company">{company.data.name}</p>}
        <p>LegacyAI access card</p>
        <p className="code">{card.card_number}</p>
        <p>Valid until {formatDate(card.expires_at)}</p>
        <QrCode text={address} label={label} />
        <p>Scan to open the sign-in screen. The 3-digit code is not on this card.</p>
      </section>
    </Card>
  );
}
