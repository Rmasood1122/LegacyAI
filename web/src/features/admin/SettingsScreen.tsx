// Company settings: the company and its use, the card and sign-in rules, the knowledge rules, the
// AI budget, and the words redaction must leave alone.
import { useState, type FormEvent } from 'react';
import type { KSettings, TenantSettings } from '../../api/generated.ts';
import { useSession } from '../../session/session.tsx';
import { Badge, Banner, Button, Card, CheckboxField, ConfirmButton, ErrorNote, Facts, formatDate, humanize, Loading, Page, SelectField, TextField } from '../../ui/index.tsx';
import {
  changedOnly, useAddAllowTerm, useAiBudget, useAllowlist, useDeleteAllowTerm, useKnowledgeSettings, useTenant, useTenantSettings, useTenantUsage, useUpdateKnowledgeSettings,
  useUpdateTenantSettings, usd,
} from './hooks.ts';

type NumberKeys<T> = { [K in keyof T]: T[K] extends number ? K : never }[keyof T];
interface NumberField<T> { key: NumberKeys<T>; label: string; hint?: string }

const CARD_FIELDS: ReadonlyArray<NumberField<TenantSettings>> = [
  { key: 'card_validity_days', label: 'A card is valid for (days)' },
  { key: 'grace_days', label: 'Read-only grace period after that (days)' },
  { key: 'renewal_notice_days', label: 'Remind about renewal this many days before' },
  { key: 'sc_lockout_threshold', label: 'Lock a card after this many wrong 3-digit codes' },
  { key: 'session_idle_minutes', label: 'Sign out after this many minutes without activity' },
  { key: 'session_absolute_hours', label: 'Sign out at the latest after (hours)' },
];
const KNOWLEDGE_FIELDS: ReadonlyArray<NumberField<KSettings>> = [
  { key: 'verifications_per_hour', label: 'One reviewer may verify at most this many items per hour' },
  { key: 'verifications_per_day', label: '… and per day' },
  { key: 'stale_after_days', label: 'A verified item needs a fresh look after (days)' },
  { key: 'review_sla_days', label: 'A review task is due after (days)' },
  { key: 'max_pdf_pages', label: 'Largest PDF (pages)' },
  { key: 'interview_max_turns', label: 'Most questions in one interview' },
  { key: 'expert_question_expiry_days', label: 'A question to an expert expires after (days)' },
  { key: 'quiz_questions_per_attempt', label: 'Questions in one readiness test' },
  { key: 'quiz_time_limit_minutes', label: 'Time limit of a readiness test (minutes)' },
  { key: 'quiz_min_questions_per_topic', label: 'Fewest questions on a topic for it to get a score' },
  { key: 'answer_log_retention_days', label: 'Keep the answer log for (days)' },
  { key: 'quiz_answer_retention_days', label: 'Keep test answers for (days)' },
];

export function SettingsScreen() {
  const { can } = useSession();
  const tenant = useTenant();
  const usage = useTenantUsage({ enabled: can('getTenantUsage') });
  const settings = useTenantSettings();
  return (
    <Page title="Settings" intro="How this company uses LegacyAI. Changes are written to the audit log.">
      <ErrorNote error={tenant.error ?? usage.error ?? settings.error} />
      {tenant.data !== undefined && (
        <Card title="The company">
          <Facts items={[
            ['Name', tenant.data.name],
            ['Plan', humanize(tenant.data.plan_code)],
            ['State', <Badge key="s" tone={tenant.data.status === 'active' ? 'success' : 'warning'}>{humanize(tenant.data.status)}</Badge>],
            ['Since', formatDate(tenant.data.created_at)],
            ...(usage.data === undefined ? [] : [
              ['People', String(usage.data.people)] as const,
              ['Cards', Object.entries(usage.data.cards_by_state).map(([state, n]) => `${n} ${state}`).join(', ') || 'none'] as const,
              ['Cards that expire soon', String(usage.data.cards_expiring_soon)] as const,
              ['Sign-ins in the last 30 days', String(usage.data.logins_last_30_days)] as const,
            ]),
          ]} />
        </Card>
      )}
      {settings.isPending && <Loading what="settings" />}
      {settings.data !== undefined && <CardRules key={JSON.stringify(settings.data)} settings={settings.data} mayChange={can('updateTenantSettings')} />}
      {can('getKnowledgeSettings') && <KnowledgeRules />}
      {can('getAiBudget') && <AiBudget />}
      {can('listRedactionAllowlist') && <Allowlist />}
    </Page>
  );
}

function NumberInputs<T extends object>({ fields, values, onChange, disabled }: {
  fields: ReadonlyArray<NumberField<T>>; values: T; onChange: (key: NumberKeys<T>, value: number) => void; disabled: boolean;
}) {
  return (
    <>
      {fields.map((f) => (
        <TextField key={String(f.key)} label={f.label} hint={f.hint} type="number" min={0} disabled={disabled}
          value={String(values[f.key])} onChange={(e) => onChange(f.key, Number(e.target.value))} />
      ))}
    </>
  );
}

function CardRules({ settings, mayChange }: { settings: TenantSettings; mayChange: boolean }) {
  const update = useUpdateTenantSettings();
  const [draft, setDraft] = useState(settings);
  const changes = changedOnly(settings, draft);
  const dirty = Object.keys(changes).length > 0;
  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    update.mutate({ body: changes });
  };
  const factor = (type: 'passkey' | 'totp', on: boolean): void =>
    setDraft({ ...draft, allowed_factor_types: on ? [...new Set([...draft.allowed_factor_types, type])] : draft.allowed_factor_types.filter((t) => t !== type) });
  return (
    <Card title="Cards and signing in">
      <form onSubmit={onSubmit} noValidate>
        <NumberInputs fields={CARD_FIELDS} values={draft} disabled={!mayChange} onChange={(key, value) => setDraft({ ...draft, [key]: value })} />
        <fieldset>
          <legend>Second step at sign-in</legend>
          <CheckboxField label="Passkey (fingerprint, face or security key)" checked={draft.allowed_factor_types.includes('passkey')} disabled={!mayChange} onChange={(on) => factor('passkey', on)} />
          <CheckboxField label="Authenticator app (6-digit code)" checked={draft.allowed_factor_types.includes('totp')} disabled={!mayChange} onChange={(on) => factor('totp', on)} />
        </fieldset>
        <CheckboxField label="Pilot: experts and administrators may also review (until dedicated reviewers exist)" checked={draft.pilot_reviewer_grant} disabled={!mayChange}
          onChange={(on) => setDraft({ ...draft, pilot_reviewer_grant: on })} />
        <p className="muted">Roles in use: {settings.enabled_roles.map(humanize).join(', ')}.</p>
        <ErrorNote error={update.error} />
        {update.isSuccess && !dirty && <Banner tone="success" title="The settings were saved" />}
        {mayChange && <Button type="submit" variant="primary" busy={update.isPending} disabled={!dirty || draft.allowed_factor_types.length === 0}>Save these settings</Button>}
      </form>
    </Card>
  );
}

function KnowledgeRules() {
  const { can } = useSession();
  const settings = useKnowledgeSettings({ enabled: true });
  return (
    <>
      {settings.isPending && <Loading what="knowledge settings" />}
      <ErrorNote error={settings.error} />
      {settings.data !== undefined && <KnowledgeRulesForm key={JSON.stringify(settings.data)} settings={settings.data} mayChange={can('updateKnowledgeSettings')} />}
    </>
  );
}

function KnowledgeRulesForm({ settings, mayChange }: { settings: KSettings; mayChange: boolean }) {
  const update = useUpdateKnowledgeSettings();
  const [draft, setDraft] = useState(settings);
  const changes = changedOnly(settings, draft);
  const dirty = Object.keys(changes).length > 0;
  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    update.mutate({ body: changes });
  };
  return (
    <Card title="Knowledge, review and tests">
      <form onSubmit={onSubmit} noValidate>
        <CheckboxField label="A second person must verify: nobody verifies their own item or their own correction" checked={draft.second_reviewer_required} disabled={!mayChange}
          onChange={(on) => setDraft({ ...draft, second_reviewer_required: on })} />
        <SelectField label="What learners’ answers may use" value={draft.learner_sources} disabled={!mayChange}
          onChange={(e) => setDraft({ ...draft, learner_sources: e.target.value as KSettings['learner_sources'] })}>
          <option value="verified_only">Verified knowledge only</option>
          <option value="all_marked">Everything they may read, with unverified sources marked</option>
        </SelectField>
        <CheckboxField label="Show learners the right answers after their test was graded" checked={draft.quiz_show_answers_after_grading} disabled={!mayChange}
          onChange={(on) => setDraft({ ...draft, quiz_show_answers_after_grading: on })} />
        <NumberInputs fields={KNOWLEDGE_FIELDS} values={draft} disabled={!mayChange} onChange={(key, value) => setDraft({ ...draft, [key]: value })} />
        <ErrorNote error={update.error} />
        {update.isSuccess && !dirty && <Banner tone="success" title="The settings were saved" />}
        {mayChange && <Button type="submit" variant="primary" busy={update.isPending} disabled={!dirty}>Save these settings</Button>}
      </form>
    </Card>
  );
}

function AiBudget() {
  const budget = useAiBudget({ enabled: true });
  const data = budget.data;
  return (
    <Card title="AI budget this month">
      {budget.isPending && <Loading what="the AI budget" />}
      <ErrorNote error={budget.error} />
      {data !== undefined && (
        <>
          {data.ai_stopped && <Banner tone="warning" title="AI is stopped">Answers fall back to listing the matching passages. Either the budget is used up or the operator stopped AI for everyone.</Banner>}
          <Facts items={[
            ['Period', data.period],
            ['Limit', usd(data.monthly_cap_micro_usd)],
            ['Spent', usd(data.spent_micro_usd)],
            ['Set aside for calls in progress', usd(data.reserved_micro_usd)],
            ['AI calls', String(data.calls)],
          ]} />
          <p className="hint">The limit is set by the platform operator.</p>
        </>
      )}
    </Card>
  );
}

type EntityType = 'PERSON' | 'LOCATION' | 'ORGANIZATION' | 'OTHER';

function Allowlist() {
  const { can } = useSession();
  const list = useAllowlist({ enabled: true });
  const add = useAddAllowTerm();
  const remove = useDeleteAllowTerm();
  const [term, setTerm] = useState('');
  const [type, setType] = useState<EntityType>('OTHER');
  const mayChange = can('addRedactionAllowlistTerm');
  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    add.mutate({ body: { term: term.trim(), entity_type: type } }, { onSuccess: () => setTerm('') });
  };
  const items = list.data?.items ?? [];
  return (
    <Card title="Words redaction must leave alone">
      <p className="muted">Redaction sometimes blanks out an ordinary word (a machine called “Bertha”, a product named after a town). Words listed here are kept. It applies to documents added from now on.</p>
      {list.isPending && <Loading what="the list" />}
      <ErrorNote error={list.error ?? add.error ?? remove.error} />
      {list.data !== undefined && (items.length === 0 ? <p className="muted">The list is empty.</p> : (
        <ul>
          {items.map((t) => (
            <li key={t.id}>
              <span className="row">
                <span>{t.term}</span>
                {mayChange && <ConfirmButton label="Remove" confirmLabel={`Yes, remove “${t.term}”`} busy={remove.isPending} onConfirm={() => remove.mutate({ path: { term_id: t.id } })} />}
              </span>
            </li>
          ))}
        </ul>
      ))}
      {mayChange && (
        <form onSubmit={onSubmit} noValidate>
          <TextField label="Word or name to keep" maxLength={100} value={term} onChange={(e) => setTerm(e.target.value)} />
          <SelectField label="It was mistaken for" value={type} onChange={(e) => setType(e.target.value as EntityType)}>
            <option value="PERSON">a person’s name</option>
            <option value="LOCATION">a place</option>
            <option value="ORGANIZATION">an organisation</option>
            <option value="OTHER">something else</option>
          </SelectField>
          <Button type="submit" busy={add.isPending} disabled={term.trim() === ''}>Add to the list</Button>
        </form>
      )}
    </Card>
  );
}
