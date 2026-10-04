// Cards: the list, and issuing a card to a person. The secrets of a new card are shown exactly once.
import { useState, type FormEvent } from 'react';
import type { CardWithSecrets, RoleAssignmentInput } from '../../api/generated.ts';
import { ScreenLink } from '../../navigation/ScreenLink.tsx';
import { useSession } from '../../session/session.tsx';
import { Badge, Button, Card, CheckboxField, DataTable, Empty, ErrorNote, formatDate, humanize, Loading, OneTimeSecrets, Page, PartialListNote, SelectField } from '../../ui/index.tsx';
import {
  ANOMALY_RULE_TEXT, CARD_STATE_TEXT, CARD_STATES, cardTone, lockReasonText, useAnomalyEvents, useCardHolders, useCardList, useIssueCard, useRoles, type CardState,
} from './hooks.ts';

type RoleKey = RoleAssignmentInput['role_key'];

export function CardsScreen() {
  const { can } = useSession();
  const [state, setState] = useState<CardState | ''>('');
  const cards = useCardList(state);
  const items = cards.items ?? [];
  return (
    <Page title="Cards" intro="A card is how a person signs in. It carries their roles and can be suspended, renewed or replaced." actions={<ScreenLink screen="people">People</ScreenLink>}>
      {can('issueCard') && can('listPeople') && <IssueCard />}
      <h2>The cards</h2>
      <SelectField label="Show" value={state} onChange={(e) => setState(e.target.value as CardState | '')}>
        <option value="">All states</option>
        {CARD_STATES.map((s) => <option key={s} value={s}>{CARD_STATE_TEXT[s]}</option>)}
      </SelectField>
      {cards.isPending && <Loading what="cards" />}
      <ErrorNote error={cards.error} />
      {cards.items !== undefined && (items.length === 0 ? <Empty>No cards here.</Empty> : (
        <DataTable caption="Cards" columns={['Card', 'Kind', 'State', 'Roles', 'Valid until']}>
          {items.map((c) => (
            <tr key={c.id}>
              <td><ScreenLink screen="card" id={c.id}>{c.card_number}</ScreenLink></td>
              <td>{c.kind === 'company' ? 'Company card' : 'Person'}</td>
              <td><Badge tone={cardTone(c.state)}>{CARD_STATE_TEXT[c.state]}</Badge> {c.locked && <Badge tone="danger">{lockReasonText(c.lock_reason)}</Badge>}</td>
              <td>{c.roles.map((r) => humanize(r.role_key)).join(', ') || '—'}</td>
              <td>{formatDate(c.expires_at)}</td>
            </tr>
          ))}
        </DataTable>
      ))}
      {cards.hasMore && <PartialListNote shown={items.length} noun="cards" busy={cards.isLoadingMore} onLoadMore={cards.loadMore} />}
      {can('listAnomalyEvents') && can('unlockCard') && <AnomalyEvents />}
    </Page>
  );
}

/** The recent times an anomaly rule fired. A locked card is unlocked on its own screen, as after wrong codes. */
function AnomalyEvents() {
  const events = useAnomalyEvents({ enabled: true });
  const items = events.items ?? [];
  return (
    <>
      <h2>Cards locked by an anomaly rule</h2>
      <p className="muted">
        A rule locks a card when it is used in an unusual way (the rules are in Settings). The list says what happened at that moment; open
        the card to see whether it is still locked and to unlock it with a new 3-digit code.
        The rules compare counts and network addresses; they can be wrong, which is why a lock can be undone.
      </p>
      {events.isPending && <Loading what="anomaly locks" />}
      <ErrorNote error={events.error} />
      {events.items !== undefined && (items.length === 0 ? <Empty>No rule has fired.</Empty> : (
        <DataTable caption="Anomaly locks" columns={['When', 'Card', 'Rule', 'Count', 'What happened then']}>
          {items.map((e) => (
            <tr key={e.id}>
              <td>{formatDate(e.occurred_at)}</td>
              <td><ScreenLink screen="card" id={e.card_id}>{e.card_number}</ScreenLink></td>
              <td>{ANOMALY_RULE_TEXT[e.rule]}</td>
              <td>{e.count ?? <span className="muted">not recorded</span>}</td>
              <td>{e.outcome === 'locked' ? <Badge tone="danger">Card was locked</Badge> : <Badge tone="warning">Not locked: the last usable Owner card</Badge>}</td>
            </tr>
          ))}
        </DataTable>
      ))}
      {events.hasMore && <PartialListNote shown={items.length} noun="events" busy={events.isLoadingMore} onLoadMore={events.loadMore} />}
    </>
  );
}

function IssueCard() {
  const people = useCardHolders({ enabled: true });
  const roles = useRoles();
  const issue = useIssueCard();
  const [person, setPerson] = useState('');
  const [chosen, setChosen] = useState<ReadonlySet<RoleKey>>(new Set());
  // The secrets live here only: gone when the person confirms, and gone when the screen is left.
  const [issued, setIssued] = useState<CardWithSecrets | null>(null);
  const toggle = (key: RoleKey, on: boolean): void => {
    const next = new Set(chosen);
    if (on) next.add(key);
    else next.delete(key);
    setChosen(next);
  };
  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    issue.mutate({ body: { person_id: person, roles: [...chosen].map((role_key) => ({ role_key })) } }, {
      onSuccess: (result) => {
        setIssued(result);
        setPerson('');
        setChosen(new Set());
        issue.reset();   // the mutation's own copy of the answer is dropped as well
      },
    });
  };
  if (issued !== null) {
    return (
      <OneTimeSecrets title="The new card" cardNumber={issued.card.card_number} sc={issued.sc} enrollmentToken={issued.enrollment_token}
        tokenExpiresAt={issued.enrollment_token_expires_at} alreadyShown={issued.secret_already_shown} onDone={() => setIssued(null)} />
    );
  }
  const available = (roles.data?.items ?? []).filter((r) => r.enabled_for_tenant);
  return (
    <Card title="Issue a card">
      <form onSubmit={onSubmit} noValidate>
        <SelectField label="For whom?" value={person} onChange={(e) => setPerson(e.target.value)}>
          <option value="">Choose a person…</option>
          {(people.items ?? []).map((p) => <option key={p.id} value={p.id}>{p.display_name}</option>)}
        </SelectField>
        {people.hasMore && <PartialListNote shown={people.items?.length ?? 0} noun="people" busy={people.isLoadingMore} onLoadMore={people.loadMore} />}
        <fieldset>
          <legend>Roles</legend>
          {roles.isPending && <Loading what="roles" />}
          {available.map((r) => <CheckboxField key={r.role_key} label={r.display_name} checked={chosen.has(r.role_key)} onChange={(on) => toggle(r.role_key, on)} />)}
        </fieldset>
        <ErrorNote error={issue.error ?? people.error ?? roles.error} />
        <p className="muted">The card number, its 3-digit code and a set-up token are shown once after this step. Have a safe way ready to hand them to the person.</p>
        <Button type="submit" variant="primary" busy={issue.isPending} disabled={person === '' || chosen.size === 0}>Issue the card</Button>
      </form>
    </Card>
  );
}
