// Cards: the list, and issuing a card to a person. The secrets of a new card are shown exactly once.
import { useState, type FormEvent } from 'react';
import type { CardWithSecrets, RoleAssignmentInput } from '../../api/generated.ts';
import { ScreenLink } from '../../navigation/ScreenLink.tsx';
import { useSession } from '../../session/session.tsx';
import { Badge, Button, Card, CheckboxField, DataTable, Empty, ErrorNote, formatDate, humanize, Loading, OneTimeSecrets, Page, PartialListNote, SelectField } from '../../ui/index.tsx';
import { CARD_STATE_TEXT, CARD_STATES, cardTone, useCardHolders, useCardList, useIssueCard, useRoles, type CardState } from './hooks.ts';

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
              <td><Badge tone={cardTone(c.state)}>{CARD_STATE_TEXT[c.state]}</Badge> {c.locked && <Badge tone="danger">Locked</Badge>}</td>
              <td>{c.roles.map((r) => humanize(r.role_key)).join(', ') || '—'}</td>
              <td>{formatDate(c.expires_at)}</td>
            </tr>
          ))}
        </DataTable>
      ))}
      {cards.hasMore && <PartialListNote shown={items.length} noun="cards" busy={cards.isLoadingMore} onLoadMore={cards.loadMore} />}
    </Page>
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
        tokenExpiresAt={issued.enrollment_token_expires_at} onDone={() => setIssued(null)} />
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
