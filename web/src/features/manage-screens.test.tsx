// The main states of the people, cards, settings, audit, consent and operator screens, with a stand-in API.
// Synthetic data only; the "secrets" below are made-up test strings.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { Card, KConsent, KSettings, TenantSettings } from '../api/generated.ts';
import { FakeApi, makeSession, permissionsFor, problem, renderScreen, sessionValue } from '../test/harness.tsx';
import { AuditScreen } from './admin/AuditScreen.tsx';
import { ConsentAdminScreen } from './admin/ConsentAdminScreen.tsx';
import { SettingsScreen } from './admin/SettingsScreen.tsx';
import { DocumentsScreen } from './documents/DocumentsScreen.tsx';
import { OperatorScreen } from './operator/OperatorScreen.tsx';
import { CardScreen } from './people/CardScreen.tsx';
import { CardsScreen } from './people/CardsScreen.tsx';
import { PeopleScreen } from './people/PeopleScreen.tsx';

const ID = (n: number): string => `01a10174-0000-7000-8000-${String(n).padStart(12, '0')}`;
const ME = '01a10174-0000-7000-8000-0000000000b1';
const T = '2026-10-01T09:00:00.000Z';
const page = <X,>(items: X[]) => ({ items, next_cursor: null });
const as = (...ops: Parameters<typeof permissionsFor>) => sessionValue(makeSession(permissionsFor(...ops)));
const person = (n: number, name: string) => ({ id: ID(n), display_name: name, email: null, department_id: null, status: 'active' as const, created_at: T });
const card = (over: Partial<Card> = {}): Card => ({
  id: ID(30), kind: 'person', card_number: 'LGY-0000-0000-0000-0030', state: 'active', person_id: ID(7), issued_at: T, activated_at: T, expires_at: '2099-01-01T00:00:00.000Z',
  grace_until: '2099-02-01T00:00:00.000Z', renewal_due: '2098-12-01T00:00:00.000Z', renewal_count: 0, locked: false, replaced_by_card_id: null, replaces_card_id: null,
  roles: [{ role_key: 'successor', department_id: null, assigned_at: T }], ...over,
});
const role = (key: 'successor' | 'expert' | 'reviewer', name: string, enabled = true) => ({ role_key: key, display_name: name, rank: 1, enabled_for_tenant: enabled, permissions: [] });

describe('people', () => {
  it('lists people, adds one, and marks one as left only after a second click', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({
      listPeople: () => page([person(7, 'Synthetic Expert')]),
      listDepartments: () => ({ items: [{ id: ID(8), name: 'Maintenance', created_at: T }] }),
      createPerson: () => person(9, 'Synthetic Newhire'),
      updatePerson: () => ({ ...person(7, 'Synthetic Expert'), status: 'departed' as const }),
    });
    renderScreen(<PeopleScreen />, { api, session: as('createPerson', 'listPeople', 'updatePerson', 'listDepartments') });
    expect(await screen.findByText('Synthetic Expert')).toBeTruthy();
    await user.type(screen.getByLabelText('Name'), 'Synthetic Newhire');
    await user.selectOptions(screen.getByLabelText('Department'), ID(8));
    await user.click(screen.getByRole('button', { name: 'Add person' }));
    await waitFor(() => expect(api.callsTo('createPerson')[0]?.body).toEqual({ display_name: 'Synthetic Newhire', email: null, department_id: ID(8) }));
    await user.click(screen.getByRole('button', { name: 'Mark as left…' }));
    expect(api.callsTo('updatePerson')).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Yes, Synthetic Expert has left' }));
    await waitFor(() => expect(api.callsTo('updatePerson')[0]).toMatchObject({ path: { person_id: ID(7) }, body: { status: 'departed' } }));
  });

  it('a card that may only read sees no forms; an empty list says so', async () => {
    const api = new FakeApi({ listPeople: () => page([]), listDepartments: () => ({ items: [] }) });
    renderScreen(<PeopleScreen />, { api, session: as('listPeople', 'listDepartments') });
    expect(await screen.findByText('Nobody here.')).toBeTruthy();
    expect(screen.queryByText('Add a person')).toBeNull();
  });
});

describe('cards', () => {
  it('issues a card with the chosen roles and shows its secrets exactly once', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({
      listCards: () => page([card()]),
      listPeople: () => page([person(7, 'Synthetic Expert')]),
      listRoles: () => ({ items: [role('successor', 'Successor'), role('expert', 'Expert'), role('reviewer', 'Reviewer', false)] }),
      issueCard: () => ({ card: card({ id: ID(31), card_number: 'LGY-0000-0000-0000-0031', state: 'issued' }), sc: '417', enrollment_token: 'synthetic-setup-token', secret_already_shown: false }),
    });
    renderScreen(<CardsScreen />, { api, session: as('issueCard', 'listCards', 'listPeople', 'listRoles', 'getCard') });
    expect(await screen.findByRole('link', { name: 'LGY-0000-0000-0000-0030' })).toBeTruthy();
    await screen.findByRole('option', { name: 'Synthetic Expert' });
    await user.selectOptions(screen.getByLabelText('For whom?'), ID(7));
    expect(screen.queryByRole('checkbox', { name: 'Reviewer' })).toBeNull();        // not switched on for this company
    await user.click(await screen.findByRole('checkbox', { name: 'Successor' }));
    await user.click(screen.getByRole('button', { name: 'Issue the card' }));
    expect((await screen.findByTestId('secret-sc')).textContent).toBe('417');
    expect(screen.getByTestId('secret-token').textContent).toBe('synthetic-setup-token');
    expect(screen.getByTestId('secret-card-number').textContent).toBe('LGY-0000-0000-0000-0031');
    expect(api.callsTo('issueCard')[0]?.body).toEqual({ person_id: ID(7), roles: [{ role_key: 'successor' }] });
    await user.click(screen.getByRole('button', { name: 'I have written these down' }));
    expect(screen.queryByTestId('secret-sc')).toBeNull();
    expect(document.body.textContent).not.toContain('synthetic-setup-token');
    expect(screen.getByText('Issue a card')).toBeTruthy();
  });

  it('one card: suspending needs a reason; revoking asks twice; the API’s refusal is shown', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({
      getCard: () => card(),
      suspendCard: () => { throw problem(403, 'You cannot act on your own card', 'forbidden'); },
      revokeCard: () => card({ state: 'revoked' }),
    });
    renderScreen(<CardScreen />, { api, session: as('getCard', 'suspendCard', 'revokeCard'), at: `/cards/${ID(30)}`, route: '/cards/:cardId' });
    const suspend = await screen.findByRole('button', { name: 'Suspend' });
    expect((suspend as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText('Reason'), 'Reported lost');
    await user.click(suspend);
    expect(await screen.findByText('You cannot act on your own card')).toBeTruthy();
    expect(api.callsTo('suspendCard')[0]).toMatchObject({ path: { card_id: ID(30) }, body: { reason: 'Reported lost' } });
    await user.click(screen.getByRole('button', { name: 'Revoke for good…' }));
    expect(api.callsTo('revokeCard')).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Yes, revoke this card for good' }));
    await waitFor(() => expect(api.callsTo('revokeCard')).toHaveLength(1));
    expect(screen.queryByText('Roles')).toBeNull();                                  // no permission to read roles
  });

  it('one card: roles, limits and history appear for a card that may read them; read-only can be switched on', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({
      getCard: () => card(),
      listRoles: () => ({ items: [role('successor', 'Successor'), role('expert', 'Expert')] }),
      getCardRestrictions: () => ({ items: [{ type: 'usage_cap', enabled: true, config: { limit_key: 'exports', window_seconds: 3600, max_count: 2 } }], counters: [] }),
      putCardRestrictions: () => ({ items: [], counters: [] }),
      listCardEvents: () => page([{ id: ID(33), card_id: ID(30), occurred_at: T, event_type: 'login_succeeded', actor_card_id: null, credential_id: null, device: 'Synthetic browser', request_id: null, metadata: {} }]),
      assignCardRole: () => ({ role_key: 'expert', department_id: null, assigned_at: T }),
    });
    renderScreen(<CardScreen />, {
      api, session: as('getCard', 'listCardRoles', 'assignCardRole', 'listRoles', 'getCardRestrictions', 'putCardRestrictions', 'listCardEvents'),
      at: `/cards/${ID(30)}`, route: '/cards/:cardId',
    });
    expect(await screen.findByText('At most 2 exports per 60 minutes')).toBeTruthy();
    expect(await screen.findByText('Login succeeded')).toBeTruthy();
    await screen.findByRole('option', { name: 'Expert' });
    await user.selectOptions(screen.getByLabelText('Give another role'), 'expert');
    await user.click(screen.getByRole('button', { name: 'Give the role' }));
    await waitFor(() => expect(api.callsTo('assignCardRole')[0]?.body).toEqual({ role_key: 'expert' }));
    await user.click(screen.getByRole('checkbox', { name: /Read-only/ }));
    await waitFor(() => expect(api.callsTo('putCardRestrictions')[0]?.body).toEqual({
      restrictions: [{ type: 'usage_cap', enabled: true, config: { limit_key: 'exports', window_seconds: 3600, max_count: 2 } }, { type: 'read_only', enabled: true, config: {} }],
    }));
  });
});

describe('settings', () => {
  const settings: TenantSettings = {
    card_validity_days: 365, grace_days: 30, renewal_notice_days: 30, sc_lockout_threshold: 5, session_idle_minutes: 30, session_absolute_hours: 12,
    enabled_roles: ['company_owner', 'admin', 'expert', 'successor'], pilot_reviewer_grant: true, allowed_factor_types: ['passkey', 'totp'],
  };
  const knowledge = {
    chunk_quota: 1000, max_upload_bytes: 1, max_pdf_pages: 50, second_reviewer_required: true, verifications_per_hour: 20, verifications_per_day: 60, learner_sources: 'verified_only',
    stale_after_days: 365, review_sla_days: 7, answer_log_retention_days: 90, quiz_answer_retention_days: 365, interview_max_turns: 12, interview_max_cost_micro_usd: 1, expert_question_expiry_days: 14,
    quiz_questions_per_attempt: 10, quiz_time_limit_minutes: 30, quiz_min_questions_per_topic: 3, quiz_show_answers_after_grading: false,
  } satisfies KSettings;
  const tenant = { id: ID(40), name: 'Synthetic Co', slug: 'synthetic-co', status: 'active' as const, plan_code: 'pilot', region: 'eu', created_at: T };

  it('sends only what was changed; the budget is shown in dollars', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({
      getCurrentTenant: () => tenant,
      getTenantSettings: () => settings,
      updateTenantSettings: () => ({ ...settings, grace_days: 14 }),
      getAiBudget: () => ({ period: '2026-10', monthly_cap_micro_usd: 5_000_000, spent_micro_usd: 1_250_000, reserved_micro_usd: 0, calls: 42, ai_stopped: false }),
    });
    renderScreen(<SettingsScreen />, { api, session: as('getCurrentTenant', 'getTenantSettings', 'updateTenantSettings', 'getAiBudget') });
    expect(await screen.findByText('Synthetic Co')).toBeTruthy();
    expect(await screen.findByText('$5.00')).toBeTruthy();
    expect(screen.getByText('$1.25')).toBeTruthy();
    const save = screen.getByRole('button', { name: 'Save these settings' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    const grace = screen.getByLabelText('Read-only grace period after that (days)');
    await user.clear(grace);
    await user.type(grace, '14');
    await user.click(save);
    await waitFor(() => expect(api.callsTo('updateTenantSettings')[0]?.body).toEqual({ grace_days: 14 }));
    expect(screen.queryByText('Knowledge, review and tests')).toBeNull();          // no permission for those settings
  });

  it('a card that may only read sees the values but no save button; knowledge rules and the allow-list appear with their permissions', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({
      getCurrentTenant: () => tenant,
      getTenantSettings: () => settings,
      getKnowledgeSettings: () => knowledge,
      listRedactionAllowlist: () => page([{ id: ID(41), term: 'Bertha', entity_type: 'PERSON', created_at: T }]),
      addRedactionAllowlistTerm: () => ({ id: ID(42), term: 'Hydrovac', entity_type: 'OTHER', created_at: T }),
    });
    renderScreen(<SettingsScreen />, { api, session: as('getCurrentTenant', 'getTenantSettings', 'getKnowledgeSettings', 'listRedactionAllowlist', 'addRedactionAllowlistTerm') });
    expect(await screen.findByText('Knowledge, review and tests')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save these settings' })).toBeNull();
    expect(await screen.findByText('Bertha')).toBeTruthy();
    await user.type(screen.getByLabelText('Word or name to keep'), 'Hydrovac');
    await user.click(screen.getByRole('button', { name: 'Add to the list' }));
    await waitFor(() => expect(api.callsTo('addRedactionAllowlistTerm')[0]?.body).toEqual({ term: 'Hydrovac', entity_type: 'OTHER' }));
  });
});

describe('audit log', () => {
  const event = { seq: 12, occurred_at: T, actor_card_id: ID(30), actor_kind: 'card' as const, action: 'card:suspend', resource_type: 'card', resource_id: ID(30), decision: 'deny' as const, reason_code: 'DENY_SELF_ACTION', request_id: null, ip: null, details: {}, prev_hash: 'a', row_hash: 'b' };

  it('lists entries and reports the chain check as evidence, not proof', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({
      listAuditEvents: () => page([event]),
      verifyAuditChain: () => ({ ok: true, complete: true, rows_checked: 12, head_seq: 12, head_hash: 'b', first_broken_seq: null, broken_reason: null, last_anchor: null }),
    });
    renderScreen(<AuditScreen />, { api, session: as('listAuditEvents', 'verifyAuditChain') });
    expect(await screen.findByText('card:suspend')).toBeTruthy();
    expect(screen.getByText('Refused')).toBeTruthy();
    expect(screen.queryByText('Export the company’s data')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Check the log' }));
    expect(await screen.findByText('No alteration was found')).toBeTruthy();
    expect(screen.getByText(/It is evidence, not proof/)).toBeTruthy();
    expect(api.callsTo('verifyAuditChain')[0]?.body).toEqual({});
  });

  it('a broken chain is reported with the entry where it breaks', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({
      listAuditEvents: () => page([]),
      verifyAuditChain: () => ({ ok: false, complete: true, rows_checked: 7, head_seq: 12, head_hash: 'b', first_broken_seq: 7, broken_reason: 'row hash mismatch', last_anchor: null }),
    });
    renderScreen(<AuditScreen />, { api, session: as('listAuditEvents', 'verifyAuditChain') });
    expect(await screen.findByText('No entries.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Check the log' }));
    expect(await screen.findByText('The log does not add up at entry 7')).toBeTruthy();
    expect(screen.getByText('row hash mismatch')).toBeTruthy();
  });
});

describe('consents of the company’s people', () => {
  const consent: KConsent = {
    id: ID(50), person_id: ID(7), scope: 'documents', purpose: 'x', policy_version: 'v', granted_at: T, expires_at: null, superseded_at: null, withdrawn_at: null,
    withdrawal_status: 'none', legal_hold: false,
  };

  it('records a withdrawal for one person only after a second click, with a reference and no free text', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({
      listPeople: () => page([person(7, 'Synthetic Expert')]),
      listConsents: () => page([consent]),
      recordWithdrawalForPerson: () => ({ person_id: ID(7), withdrawals: [{ consent_id: ID(50), withdrawal_status: 'hidden' }] }),
    });
    renderScreen(<ConsentAdminScreen />, { api, session: as('listConsents', 'listPeople', 'recordWithdrawalForPerson') });
    expect(await screen.findByText('Their own documents')).toBeTruthy();
    await screen.findByRole('option', { name: 'Synthetic Expert' });
    await user.selectOptions(screen.getByLabelText('Whose consents?'), ID(7));
    await user.type(await screen.findByLabelText('Your reference for their request'), 'bad');
    expect(screen.getByText(/Use 6 to 64 letters/)).toBeTruthy();
    await user.clear(screen.getByLabelText('Your reference for their request'));
    await user.type(screen.getByLabelText('Your reference for their request'), 'REQ-2026-0001');
    await user.click(screen.getByRole('button', { name: 'Record the withdrawal…' }));
    expect(api.callsTo('recordWithdrawalForPerson')).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Yes, withdraw and erase their material' }));
    await waitFor(() => expect(api.callsTo('recordWithdrawalForPerson')[0]).toMatchObject({ path: { person_id: ID(7) }, body: { reference: 'REQ-2026-0001' } }));
  });

  it('places a legal hold with a reason', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({ listConsents: () => page([consent]), holdConsent: () => ({ ...consent, legal_hold: true }) });
    renderScreen(<ConsentAdminScreen />, { api, session: as('listConsents', 'holdConsent') });
    await user.click(await screen.findByRole('button', { name: 'Place a hold' }));
    await user.type(screen.getByLabelText('Reason for the hold'), 'Matter 2026-17');
    await user.click(screen.getByRole('button', { name: 'Place the hold' }));
    await waitFor(() => expect(api.callsTo('holdConsent')[0]).toMatchObject({ path: { consent_id: ID(50) }, body: { reason: 'Matter 2026-17' } }));
  });
});

describe('operator console', () => {
  const tenant = { id: ID(40), name: 'Synthetic Co', slug: 'synthetic-co', status: 'active' as const, plan_code: 'pilot', region: 'eu', created_at: T };

  it('creates a company after a second click and shows each card’s secrets once', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({
      listTenants: () => page([tenant]),
      createTenant: () => ({
        tenant: { ...tenant, id: ID(43), name: 'Synthetic Two', slug: 'synthetic-two' }, owner_person: person(44, 'Synthetic Owner'),
        owner_card: { card: card({ card_number: 'LGY-0000-0000-0000-0045' }), sc: '111', enrollment_token: 'owner-token-synthetic', secret_already_shown: false },
        company_card: { card: card({ kind: 'company', card_number: 'LGY-0000-0000-0000-0046' }), sc: '222', secret_already_shown: false },
      }),
    });
    renderScreen(<OperatorScreen />, { api, session: as('listTenants', 'createTenant') });
    expect(await screen.findByRole('cell', { name: 'Synthetic Co' })).toBeTruthy();
    await user.type(screen.getByLabelText('Company name'), 'Synthetic Two');
    await user.type(screen.getByLabelText('Short name'), 'synthetic-two');
    await user.type(screen.getByLabelText('Name of the first owner'), 'Synthetic Owner');
    await user.click(screen.getByRole('button', { name: 'Create the company…' }));
    expect(api.callsTo('createTenant')).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Yes, create “Synthetic Two”' }));
    expect((await screen.findByTestId('secret-sc')).textContent).toBe('111');
    await user.click(screen.getByRole('button', { name: 'I have written these down' }));
    expect(screen.getByTestId('secret-sc').textContent).toBe('222');
    expect(document.body.textContent).not.toContain('owner-token-synthetic');
    await user.click(screen.getByRole('button', { name: 'I have written these down' }));
    expect(screen.queryByTestId('secret-sc')).toBeNull();
    expect(api.callsTo('createTenant')[0]?.body).toEqual({ name: 'Synthetic Two', slug: 'synthetic-two', owner_display_name: 'Synthetic Owner' });
  });

  it('a spending limit and the AI stop switch each need a second, explicit click', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({
      listTenants: () => page([tenant]),
      setTenantAiBudget: () => ({ tenant_id: ID(40), monthly_cap_micro_usd: 5_000_000 }),
      setAiKillSwitch: () => ({ on: true, reason: 'Synthetic drill' }),
    });
    renderScreen(<OperatorScreen />, { api, session: as('listTenants', 'setTenantAiBudget', 'setAiKillSwitch') });
    await screen.findByRole('option', { name: 'Synthetic Co' });
    await user.selectOptions(screen.getByLabelText('Work on one company'), ID(40));
    await user.type(await screen.findByLabelText('Monthly limit in US dollars'), '5');
    await user.click(screen.getByRole('button', { name: 'Set the limit…' }));
    expect(api.callsTo('setTenantAiBudget')).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Yes, allow up to $5.00 a month' }));
    await waitFor(() => expect(api.callsTo('setTenantAiBudget')[0]).toMatchObject({ path: { tenant_id: ID(40) }, body: { monthly_cap_micro_usd: 5_000_000 } }));
    const stop = screen.getByText('Stop AI for every company').closest('.card') as HTMLElement;
    await user.type(within(stop).getByLabelText('Reason (when stopping)'), 'Synthetic drill');
    await user.click(within(stop).getByRole('button', { name: 'Stop AI…' }));
    expect(api.callsTo('setAiKillSwitch')).toEqual([]);
    await user.click(within(stop).getByRole('button', { name: 'Yes, stop AI for every company' }));
    expect(await screen.findByText('AI is stopped for every company')).toBeTruthy();
    expect(api.callsTo('setAiKillSwitch')[0]?.body).toEqual({ on: true, reason: 'Synthetic drill' });
    expect(screen.queryByText('Create a company')).toBeNull();
    expect(screen.queryByText('Owner recovery')).toBeNull();
  });
});

describe('documents: my own notes without the people list', () => {
  it('a card that cannot read the people list names itself as the contributor', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({
      listSources: () => page([]),
      createSource: () => ({ id: ID(24), status: 'awaiting_content', title: 'My notes' }),
      uploadSourceContent: () => ({ status: 'ready', failure_code: null, chunk_count: 1, pending_chunks: 0, duplicate_of: null }),
    });
    renderScreen(<DocumentsScreen />, { api, session: as('listSources', 'createSource', 'uploadSourceContent') });
    await user.type(await screen.findByLabelText('Title'), 'My notes');
    await user.selectOptions(screen.getByLabelText('Whose material is it?'), ME);
    await user.upload(screen.getByLabelText('File'), new File(['Synthetic notes.'], 'notes.txt', { type: 'text/plain' }));
    await user.click(screen.getByRole('button', { name: 'Add document' }));
    expect(await screen.findByText('The document is ready')).toBeTruthy();
    expect(api.callsTo('createSource')[0]?.body).toEqual({ title: 'My notes', sensitivity: 1, contributor_person_id: ME });
  });
});
