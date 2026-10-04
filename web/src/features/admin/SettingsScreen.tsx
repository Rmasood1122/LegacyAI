// Company settings: the company and its use, the card and sign-in rules, the knowledge rules, the
// AI budget, and the words redaction must leave alone.
import { useState, type FormEvent } from 'react';
import type { AnomalySettings, KSettings, OperationTypes, TenantSettings, UpdateAnomalySettingsRequest, UpdateTenantSettingsRequest } from '../../api/generated.ts';
import { useSession } from '../../session/session.tsx';
import { Badge, Banner, Button, Card, CheckboxField, ConfirmButton, ErrorNote, Facts, formatDate, humanize, Loading, Page, PartialListNote, SelectField, TextField } from '../../ui/index.tsx';
import {
  changedOnly, useAddAllowTerm, useAiBudget, useAllowlist, useAnomalySettings, useDeleteAllowTerm, useKnowledgeSettings, useTenant, useTenantSettings, useTenantUsage,
  useUpdateAnomalySettings, useUpdateKnowledgeSettings, useUpdateTenantSettings, usd,
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
      {can('getAnomalySettings') && <AnomalyRules mayChange={can('updateAnomalySettings')} />}
      {can('getKnowledgeSettings') && <KnowledgeRules />}
      {can('getAiBudget') && <AiBudget />}
      {can('listRedactionAllowlist') && <Allowlist />}
    </Page>
  );
}

/** One number. What is typed is kept as text: a cleared or non-numeric field shows an error and changes nothing (it never becomes 0). */
function NumberInput({ label, hint, value, onChange, onValidity, disabled }: {
  label: string; hint?: string; value: number; onChange: (value: number) => void; onValidity: (valid: boolean) => void; disabled: boolean;
}) {
  const [text, setText] = useState(String(value));
  const isNumber = (t: string): boolean => t.trim() !== '' && Number.isFinite(Number(t));
  const valid = isNumber(text);
  return (
    <TextField label={label} hint={hint} type="number" min={0} disabled={disabled} value={text}
      error={valid ? null : `Enter a number. Nothing can be saved until you do (the saved value is ${value}).`}
      onChange={(e) => {
        setText(e.target.value);
        onValidity(isNumber(e.target.value));
        if (isNumber(e.target.value)) onChange(Number(e.target.value));
      }} />
  );
}

/**
 * Which number fields of a form hold something that is not a number. While any does, the form must not be saved:
 * the draft still holds the last valid value, and saving it would store something the screen does not show.
 */
function useInvalidFields(): { anyInvalid: boolean; report: (key: string, valid: boolean) => void } {
  const [invalid, setInvalid] = useState<ReadonlySet<string>>(new Set());
  const report = (key: string, valid: boolean): void => setInvalid((before) => {
    if (valid === !before.has(key)) return before;
    const next = new Set(before);
    if (valid) next.delete(key);
    else next.add(key);
    return next;
  });
  return { anyInvalid: invalid.size > 0, report };
}

function NumberInputs<T extends object>({ fields, values, onChange, onValidity, disabled }: {
  fields: ReadonlyArray<NumberField<T>>; values: T; onChange: (key: NumberKeys<T>, value: number) => void;
  onValidity: (key: string, valid: boolean) => void; disabled: boolean;
}) {
  return (
    <>
      {fields.map((f) => (
        <NumberInput key={String(f.key)} label={f.label} hint={f.hint} disabled={disabled} value={Number(values[f.key])} onChange={(n) => onChange(f.key, n)}
          onValidity={(valid) => onValidity(String(f.key), valid)} />
      ))}
    </>
  );
}

type AnomalyNumbers = Pick<AnomalySettings, 'denials_threshold' | 'denials_window_minutes' | 'second_address_window_minutes'>;
type AnomalyKey = keyof UpdateAnomalySettingsRequest;
const ANOMALY_KEYS: readonly AnomalyKey[] = [
  'enabled', 'denials_enabled', 'denials_threshold', 'denials_window_minutes', 'second_address_enabled', 'second_address_window_minutes',
];
const DENIALS_FIELDS: ReadonlyArray<NumberField<AnomalyNumbers>> = [
  {
    key: 'denials_threshold', label: 'Lock a card after this many refused actions …',
    hint: 'From 5 to 500. Counted are actions of a signed-in card that it has no right to. Not counted: a card outside its hours or over its limit, a card in its grace period, pages that no longer exist, and wrong sign-ins (the 3-digit code rule above handles those).',
  },
  { key: 'denials_window_minutes', label: '… within this many minutes', hint: 'From 1 to 60. Slow attempts - fewer than the number above in every such period - are not caught.' },
];
const SECOND_ADDRESS_FIELDS: ReadonlyArray<NumberField<AnomalyNumbers>> = [
  {
    key: 'second_address_window_minutes', label: '… while another session of the card was used elsewhere within this many minutes',
    hint: 'From 1 to 120. Compares network addresses, not places: a phone on mobile data and a laptop on the office network count as two addresses.',
  },
];

/** The anomaly-lock rules (feature 5). A locked card is unlocked on its own screen with a new 3-digit code. */
function AnomalyRules({ mayChange }: { mayChange: boolean }) {
  const settings = useAnomalySettings();
  // The change lives here, not in the form: the form is rebuilt when the saved rules arrive, and "saved" must survive that.
  const update = useUpdateAnomalySettings();
  return (
    <Card title="Unusual use of a card">
      <p className="muted">
        Simple rules that lock a card when it is used in an unusual way. They can be wrong, so a lock can always be undone by an administrator.
        The last usable Owner card is never locked by a rule; the event is recorded instead.
      </p>
      {settings.isPending && <Loading what="the rules" />}
      <ErrorNote error={settings.error} />
      {settings.data !== undefined && (
        <AnomalyForm key={JSON.stringify(settings.data)} settings={settings.data} mayChange={mayChange} saved={update.isSuccess} busy={update.isPending} error={update.error}
          onSave={(changes) => update.mutate({ body: changes })} />
      )}
    </Card>
  );
}

function AnomalyForm({ settings, mayChange, saved, busy, error, onSave }: {
  settings: AnomalySettings; mayChange: boolean; saved: boolean; busy: boolean; error: { message: string } | null; onSave: (changes: UpdateAnomalySettingsRequest) => void;
}) {
  const [draft, setDraft] = useState(settings);
  const numbers = useInvalidFields();
  const changes: UpdateAnomalySettingsRequest = Object.fromEntries(ANOMALY_KEYS.filter((k) => draft[k] !== settings[k]).map((k) => [k, draft[k]]));
  const dirty = Object.keys(changes).length > 0;
  const set = (key: keyof AnomalyNumbers, value: number): void => setDraft({ ...draft, [key]: value });
  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    onSave(changes);
  };
  return (
    <form onSubmit={onSubmit} noValidate>
      <CheckboxField label="Lock cards that are used in an unusual way" checked={draft.enabled} disabled={!mayChange} onChange={(on) => setDraft({ ...draft, enabled: on })} />
      <CheckboxField label="Rule 1: many refused actions in a short time" checked={draft.denials_enabled} disabled={!mayChange || !draft.enabled}
        onChange={(on) => setDraft({ ...draft, denials_enabled: on })} />
      <NumberInputs<AnomalyNumbers> fields={DENIALS_FIELDS} values={draft} disabled={!mayChange || !draft.enabled || !draft.denials_enabled} onChange={set} onValidity={numbers.report} />
      <CheckboxField label="Rule 2: a sign-in from a second network address" checked={draft.second_address_enabled} disabled={!mayChange || !draft.enabled}
        onChange={(on) => setDraft({ ...draft, second_address_enabled: on })} />
      <NumberInputs<AnomalyNumbers> fields={SECOND_ADDRESS_FIELDS} values={draft} disabled={!mayChange || !draft.enabled || !draft.second_address_enabled} onChange={set}
        onValidity={numbers.report} />
      <ErrorNote error={error} />
      {saved && !dirty && <Banner tone="success" title="The rules were saved" />}
      {mayChange && <Button type="submit" variant="primary" busy={busy} disabled={!dirty || numbers.anyInvalid}>Save these rules</Button>}
    </form>
  );
}

function CardRules({ settings, mayChange }: { settings: TenantSettings; mayChange: boolean }) {
  const update = useUpdateTenantSettings();
  const [draft, setDraft] = useState(settings);
  const numbers = useInvalidFields();
  const changes = changedOnly<UpdateTenantSettingsRequest, TenantSettings>(settings, draft);
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
        <NumberInputs fields={CARD_FIELDS} values={draft} disabled={!mayChange} onChange={(key, value) => setDraft({ ...draft, [key]: value })} onValidity={numbers.report} />
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
        {mayChange && <Button type="submit" variant="primary" busy={update.isPending} disabled={!dirty || numbers.anyInvalid || draft.allowed_factor_types.length === 0}>Save these settings</Button>}
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
  const numbers = useInvalidFields();
  const changes = changedOnly<OperationTypes['updateKnowledgeSettings']['body'], KSettings>(settings, draft);
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
        <NumberInputs fields={KNOWLEDGE_FIELDS} values={draft} disabled={!mayChange} onChange={(key, value) => setDraft({ ...draft, [key]: value })} onValidity={numbers.report} />
        <ErrorNote error={update.error} />
        {update.isSuccess && !dirty && <Banner tone="success" title="The settings were saved" />}
        {mayChange && <Button type="submit" variant="primary" busy={update.isPending} disabled={!dirty || numbers.anyInvalid}>Save these settings</Button>}
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
                {mayChange && <ConfirmButton resetKey={null} label="Remove" confirmLabel={`Yes, remove “${t.term}”`} busy={remove.isPending} onConfirm={() => remove.mutate({ path: { term_id: t.id } })} />}
              </span>
            </li>
          ))}
        </ul>
      ))}
      {list.data !== undefined && list.data.next_cursor !== null && <PartialListNote shown={items.length} noun="words" />}
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
