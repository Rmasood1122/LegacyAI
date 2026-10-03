// My consent and my contributions: what I agreed to share, withdrawing it, and limiting who may
// read what I contributed.
import { useState, type FormEvent } from 'react';
import { useApiList, useApiMutation, useApiQuery } from '../../api/context.tsx';
import type { KConsent, KItemSummary } from '../../api/generated.ts';
import { useSession } from '../../session/session.tsx';
import { Badge, Banner, Button, Card, DataTable, Empty, ErrorNote, formatDate, humanize, Loading, Page, PartialListNote, SelectField, SENSITIVITY_LABELS, sensitivityLabel } from '../../ui/index.tsx';

type Scope = 'own_words' | 'documents' | 'named_expert';

/** The words a person agrees to. Changing them means a new version, so earlier consents stay tied to what was shown then. */
export const CONSENT_POLICY_VERSION = 'web-2026-10';
const SCOPES: Readonly<Record<Scope, { title: string; text: string }>> = {
  own_words: {
    title: 'My own words',
    text: 'What I say in interviews and write as knowledge items may be stored, searched and used to answer colleagues’ questions.',
  },
  documents: {
    title: 'My own documents',
    text: 'Notes and documents that are my own may be stored, searched and used to answer colleagues’ questions.',
  },
  named_expert: {
    title: 'Naming me as the expert',
    text: 'Answers may say that they come from me, and colleagues may send me questions.',
  },
};

const consentState = (c: KConsent): { text: string; tone: 'success' | 'warning' | 'neutral' } => {
  if (c.withdrawn_at !== null) {
    return { text: c.withdrawal_status === 'completed' ? 'Withdrawn — material erased' : c.withdrawal_status === 'held' ? 'Withdrawn — hidden, kept under a legal hold' : 'Withdrawn — hidden, erasure in progress', tone: 'neutral' };
  }
  if (c.superseded_at !== null) return { text: 'Replaced by a newer consent', tone: 'neutral' };
  if (c.expires_at !== null && new Date(c.expires_at).getTime() < Date.now()) return { text: 'Expired', tone: 'warning' };
  return { text: 'Active', tone: 'success' };
};
const isLive = (c: KConsent): boolean => c.withdrawn_at === null && c.superseded_at === null;

export function ConsentScreen() {
  const { can } = useSession();
  const consents = useApiQuery('listMyConsents');
  const withdraw = useApiMutation('withdrawConsent', ['listMyConsents', 'listMyContributions']);
  const [confirming, setConfirming] = useState<string | null>(null);
  const items = consents.data?.items ?? [];

  return (
    <Page title="My consent" intro="You decide whether your own words and documents are used. You can withdraw at any time.">
      {can('giveConsent') && <GiveConsent live={items.filter(isLive).map((c) => c.scope)} />}
      <h2>What I agreed to</h2>
      {consents.isPending && <Loading what="your consents" />}
      <ErrorNote error={consents.error ?? withdraw.error} />
      {withdraw.isSuccess && <Banner tone="success" title="Your consent was withdrawn">The material given under it is hidden now and is being erased.</Banner>}
      {consents.data !== undefined && (items.length === 0 ? <Empty>You have not given any consent.</Empty> : (
        <DataTable caption="My consents" columns={['For', 'State', 'Given', 'Actions']}>
          {items.map((c) => {
            const s = consentState(c);
            return (
              <tr key={c.id}>
                <td>{SCOPES[c.scope as Scope]?.title ?? humanize(c.scope)}</td>
                <td><Badge tone={s.tone}>{s.text}</Badge></td>
                <td>{formatDate(c.granted_at)}</td>
                <td>
                  {isLive(c) && can('withdrawConsent') && (confirming === c.id ? (
                    <div className="row">
                      <Button variant="danger" busy={withdraw.isPending} onClick={() => withdraw.mutate({ path: { consent_id: c.id } }, { onSettled: () => setConfirming(null) })}>Yes, withdraw and erase</Button>
                      <Button onClick={() => setConfirming(null)}>Keep it</Button>
                    </div>
                  ) : <Button variant="danger" onClick={() => setConfirming(c.id)}>Withdraw…</Button>)}
                </td>
              </tr>
            );
          })}
        </DataTable>
      ))}
      {consents.data !== undefined && consents.data.next_cursor !== null && <PartialListNote shown={items.length} noun="consents" />}
      {can('listMyContributions') && <Contributions />}
    </Page>
  );
}

function GiveConsent({ live }: { live: string[] }) {
  const give = useApiMutation('giveConsent', ['listMyConsents']);
  const [scope, setScope] = useState<Scope>('own_words');
  const [agreed, setAgreed] = useState(false);
  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    give.mutate({ body: { scope, purpose: SCOPES[scope].text, policy_version: CONSENT_POLICY_VERSION } }, { onSuccess: () => setAgreed(false) });
  };
  return (
    <Card title="Give consent">
      <form onSubmit={onSubmit} noValidate>
        <SelectField label="What do you agree to share?" value={scope} onChange={(e) => { setScope(e.target.value as Scope); setAgreed(false); }}>
          {(Object.keys(SCOPES) as Scope[]).map((s) => <option key={s} value={s}>{SCOPES[s].title}{live.includes(s) ? ' (already given)' : ''}</option>)}
        </SelectField>
        <label className="choice">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
          <span>I agree: {SCOPES[scope].text} I can withdraw this at any time; the material is then hidden at once and erased.</span>
        </label>
        <ErrorNote error={give.error} />
        {give.isSuccess && <Banner tone="success">Your consent was recorded.</Banner>}
        <Button type="submit" variant="primary" busy={give.isPending} disabled={!agreed}>Give consent</Button>
      </form>
    </Card>
  );
}

function Contributions() {
  const { can } = useSession();
  const mine = useApiList('listMyContributions', { query: { limit: 50 } });
  const restrict = useApiMutation('restrictContribution', ['listMyContributions']);
  const items = mine.items ?? [];
  return (
    <div>
      <h2>What I contributed</h2>
      {mine.isPending && <Loading what="your contributions" />}
      <ErrorNote error={mine.error ?? restrict.error} />
      {mine.items !== undefined && (items.length === 0 ? <Empty>Nothing yet.</Empty> : (
        <DataTable caption="My contributions" columns={['Title', 'State', 'Who may read it', 'Limit further']}>
          {items.map((i) => <ContributionRow key={i.id} item={i} mayRestrict={can('restrictContribution')} busy={restrict.isPending}
            onRestrict={(level) => restrict.mutate({ path: { item_id: i.id }, body: { sensitivity: level } })} />)}
        </DataTable>
      ))}
      {mine.hasMore && <PartialListNote shown={items.length} noun="contributions" busy={mine.isLoadingMore} onLoadMore={mine.loadMore} />}
    </div>
  );
}

function ContributionRow({ item, mayRestrict, busy, onRestrict }: { item: KItemSummary; mayRestrict: boolean; busy: boolean; onRestrict(level: number): void }) {
  const stricter = SENSITIVITY_LABELS.map((label, level) => ({ label, level })).filter((o) => o.level > item.sensitivity);
  return (
    <tr>
      <td>{item.title || 'Untitled'}</td>
      <td>{humanize(item.status)}</td>
      <td>{sensitivityLabel(item.sensitivity)}</td>
      <td>
        {mayRestrict && stricter.length > 0 && (
          <div className="row">
            {stricter.map((o) => <Button key={o.level} busy={busy} aria-label={`Limit “${item.title}” to ${o.label}`} onClick={() => onRestrict(o.level)}>{o.label}</Button>)}
          </div>
        )}
      </td>
    </tr>
  );
}
