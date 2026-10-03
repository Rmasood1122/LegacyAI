// The operator console: for the platform operator only (the API offers these operations to no
// other company). Every action that costs money, replaces a card or stops AI asks twice.
import { useState, type FormEvent } from 'react';
import { useApiList, useApiMutation, useApiQuery } from '../../api/context.tsx';
import type { CardWithSecrets, OwnerRecoveryResult, Tenant, TenantCreated } from '../../api/generated.ts';
import { useSession } from '../../session/session.tsx';
import { Badge, Banner, Card, ConfirmButton, DataTable, Empty, ErrorNote, Facts, formatDate, humanize, Loading, OneTimeSecrets, Page, PartialListNote, SelectField, TextField } from '../../ui/index.tsx';
import type { ShownSecrets } from '../../ui/index.tsx';

type Shown = ShownSecrets;
const secretsOf = (title: string, r: CardWithSecrets | OwnerRecoveryResult): Shown =>
  ({ title, cardNumber: r.card.card_number, sc: r.sc, enrollmentToken: r.enrollment_token, tokenExpiresAt: r.enrollment_token_expires_at, alreadyShown: r.secret_already_shown });

const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._-]{5,63}$/;
const TENANTS_CHANGED = ['listTenants', 'getPlatformStorage'] as const;

export function OperatorScreen() {
  const { can } = useSession();
  const tenants = useApiList('listTenants', { query: { limit: 50 } });
  const [selected, setSelected] = useState('');
  const items = tenants.items ?? [];
  const tenant = items.find((t) => t.id === selected);
  return (
    <Page title="Operator console" intro="Running the platform: companies, their cards of last resort, AI spending and storage.">
      {can('createTenant') && <NewCompany />}
      <h2>Companies</h2>
      {tenants.isPending && <Loading what="companies" />}
      <ErrorNote error={tenants.error} />
      {tenants.items !== undefined && (items.length === 0 ? <Empty>No companies yet.</Empty> : (
        <DataTable caption="Companies" columns={['Name', 'Short name', 'State', 'Plan', 'Since']}>
          {items.map((t) => (
            <tr key={t.id}>
              <td>{t.name}</td>
              <td>{t.slug}</td>
              <td><Badge tone={t.status === 'active' ? 'success' : 'warning'}>{humanize(t.status)}</Badge></td>
              <td>{humanize(t.plan_code)}</td>
              <td>{formatDate(t.created_at)}</td>
            </tr>
          ))}
        </DataTable>
      ))}
      {tenants.hasMore && <PartialListNote shown={items.length} noun="companies" busy={tenants.isLoadingMore} onLoadMore={tenants.loadMore} />}
      {items.length > 0 && (
        <SelectField label="Work on one company" value={selected} onChange={(e) => setSelected(e.target.value)}>
          <option value="">Choose a company…</option>
          {items.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </SelectField>
      )}
      {tenant !== undefined && <CompanyActions key={tenant.id} tenant={tenant} />}
      {can('setAiKillSwitch') && <KillSwitch />}
      {can('getPlatformStorage') && <Storage tenants={items} />}
    </Page>
  );
}

function NewCompany() {
  const create = useApiMutation('createTenant', TENANTS_CHANGED);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [owner, setOwner] = useState('');
  // The secrets of the two new cards live here only; each is removed once it is confirmed.
  const [created, setCreated] = useState<TenantCreated | null>(null);
  const [step, setStep] = useState<'owner' | 'company'>('owner');
  const onSubmit = (e: FormEvent): void => e.preventDefault();
  const valid = name.trim() !== '' && owner.trim() !== '' && SLUG.test(slug);
  const send = (): void => create.mutate({ body: { name: name.trim(), slug, owner_display_name: owner.trim() } }, {
    onSuccess: (result) => {
      setCreated(result);
      setStep('owner');
      setName('');
      setSlug('');
      setOwner('');
      create.reset();
    },
  });
  if (created !== null) {
    return step === 'owner'
      ? <OneTimeSecrets {...secretsOf(`The owner’s card for ${created.tenant.name}`, created.owner_card)} onDone={() => setStep('company')} />
      : <OneTimeSecrets {...secretsOf(`The company card for ${created.tenant.name} (keep it sealed; it is the card of last resort)`, created.company_card)} onDone={() => setCreated(null)} />;
  }
  return (
    <Card title="Create a company">
      <form onSubmit={onSubmit} noValidate>
        <TextField label="Company name" maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
        <TextField label="Short name" hint="Lower-case letters, digits and dashes, 3 to 63 characters. It cannot be changed later." value={slug}
          error={slug !== '' && !SLUG.test(slug) ? 'Use lower-case letters, digits and dashes only.' : null} onChange={(e) => setSlug(e.target.value.toLowerCase())} />
        <TextField label="Name of the first owner" maxLength={200} autoComplete="off" value={owner} onChange={(e) => setOwner(e.target.value)} />
        <ErrorNote error={create.error} />
        <p className="muted">Two cards are issued: the owner’s and the company card. Their secrets are shown once each, right after this step.</p>
        <ConfirmButton variant="primary" label="Create the company" confirmLabel={`Yes, create “${name.trim()}”`} busy={create.isPending} disabled={!valid} onConfirm={send} />
      </form>
    </Card>
  );
}

function CompanyActions({ tenant }: { tenant: Tenant }) {
  const { can } = useSession();
  const renew = useApiMutation('renewCompanyCard');
  const recover = useApiMutation('recoverOwnerCard');
  const budget = useApiMutation('setTenantAiBudget');
  const [shown, setShown] = useState<Shown | null>(null);
  const [cardNumber, setCardNumber] = useState('');
  const [reference, setReference] = useState('');
  const [dollars, setDollars] = useState('');
  const path = { tenant_id: tenant.id };
  const amount = Number(dollars);
  const amountValid = dollars.trim() !== '' && Number.isFinite(amount) && amount >= 0 && amount <= 10_000;
  const recoveryValid = cardNumber.trim() !== '' && REFERENCE.test(reference.trim());
  if (shown !== null) return <OneTimeSecrets {...shown} onDone={() => setShown(null)} />;
  return (
    <Card title={`Actions for ${tenant.name}`}>
      <ErrorNote error={renew.error ?? recover.error ?? budget.error} />
      {can('setTenantAiBudget') && (
        <>
          <h3>AI spending limit</h3>
          <TextField label="Monthly limit in US dollars" hint="AI stops for this company when the limit is reached. 0 switches AI off for it." type="number" min={0} step="0.01" value={dollars} onChange={(e) => setDollars(e.target.value)} />
          {budget.data !== undefined && <Banner tone="success" title={`The monthly limit is now $${(budget.data.monthly_cap_micro_usd / 1_000_000).toFixed(2)}`} />}
          <ConfirmButton variant="primary" label="Set the limit" confirmLabel={`Yes, allow up to $${amountValid ? amount.toFixed(2) : '?'} a month`} busy={budget.isPending} disabled={!amountValid}
            onConfirm={() => budget.mutate({ path, body: { monthly_cap_micro_usd: Math.round(amount * 1_000_000) } })} />
        </>
      )}
      {can('renewCompanyCard') && (
        <>
          <h3>Company card</h3>
          <p>Renews the company’s card of last resort. Its new secrets are shown once.</p>
          <ConfirmButton variant="primary" label="Renew the company card" confirmLabel="Yes, renew it" busy={renew.isPending}
            onConfirm={() => renew.mutate({ path, body: {} }, { onSuccess: (r) => { renew.reset(); setShown(secretsOf(`The company card of ${tenant.name}`, r)); } })} />
        </>
      )}
      {can('recoverOwnerCard') && (
        <>
          <h3>Owner recovery</h3>
          <p>For an owner who can no longer sign in. Do this only after you have checked their identity by another route; the other owners are told.</p>
          <TextField label="The owner’s card number" autoComplete="off" value={cardNumber} onChange={(e) => setCardNumber(e.target.value)} />
          <TextField label="Reference of your identity check" hint="A ticket or case number (6 to 64 letters, digits, dots, dashes). Never a name or phone number." value={reference}
            error={reference.trim() !== '' && !REFERENCE.test(reference.trim()) ? 'Use 6 to 64 letters, digits, dots, dashes or underscores.' : null} onChange={(e) => setReference(e.target.value)} />
          <ConfirmButton label="Recover the owner’s card" confirmLabel="Yes, I checked their identity; reset this card" busy={recover.isPending} disabled={!recoveryValid}
            onConfirm={() => recover.mutate({ path, body: { card_number: cardNumber.trim(), verification_reference: reference.trim() } }, {
              onSuccess: (r) => {
                recover.reset();
                setCardNumber('');
                setReference('');
                setShown(secretsOf(`The owner’s card (${r.notified_owner_count} other owner(s) were told)`, r));
              },
            })} />
        </>
      )}
    </Card>
  );
}

function KillSwitch() {
  const flip = useApiMutation('setAiKillSwitch');
  const [reason, setReason] = useState('');
  const state = flip.data;
  return (
    <Card title="Stop AI for every company">
      <p>The stop switch ends all AI calls at once, for everyone. Answers then list the matching passages only. The switch’s present state is shown after you use it.</p>
      <ErrorNote error={flip.error} />
      {state !== undefined && <Banner tone={state.on ? 'warning' : 'success'} title={state.on ? 'AI is stopped for every company' : 'AI is running'}>{state.reason}</Banner>}
      <TextField label="Reason (when stopping)" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
      <div className="row">
        <ConfirmButton label="Stop AI" confirmLabel="Yes, stop AI for every company" busy={flip.isPending} disabled={reason.trim() === ''}
          onConfirm={() => flip.mutate({ body: { on: true, reason: reason.trim() } })} />
        <ConfirmButton variant="primary" label="Start AI again" confirmLabel="Yes, start AI again (this allows spending)" busy={flip.isPending} onConfirm={() => flip.mutate({ body: { on: false } })} />
      </div>
    </Card>
  );
}

function Storage({ tenants }: { tenants: readonly Tenant[] }) {
  const storage = useApiQuery('getPlatformStorage');
  const data = storage.data;
  return (
    <Card title="Storage">
      {storage.isPending && <Loading what="storage figures" />}
      <ErrorNote error={storage.error} />
      {data !== undefined && (
        <>
          <Facts items={[['Database size', `${(data.database_bytes / 1_048_576).toFixed(1)} MB`], ['Stored passages', String(data.total_chunks)]]} />
          {data.companies.length > 0 && (
            <DataTable caption="Passages by company" columns={['Company', 'Stored passages']}>
              {data.companies.map((c) => <tr key={c.tenant_id}><td>{tenants.find((t) => t.id === c.tenant_id)?.name ?? c.tenant_id}</td><td>{c.chunk_count}</td></tr>)}
            </DataTable>
          )}
        </>
      )}
    </Card>
  );
}
