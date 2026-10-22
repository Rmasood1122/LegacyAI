// The company's own sign-in (SSO, feature 16) on the screens. Synthetic data only; the "secrets" below are made-up words.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { SsoConnection } from '../api/generated.ts';
import { FakeApi, makeSession, permissionsFor, problem, renderScreen, sessionValue } from '../test/harness.tsx';
import { EnrollScreen } from './auth/EnrollScreen.tsx';
import type { Passkeys } from './auth/passkeys.ts';
import { SignInScreen } from './auth/SignInScreen.tsx';
import { SsoReturnScreen } from './auth/SsoReturnScreen.tsx';
import { SsoScreen } from './sso/SsoScreen.tsx';

const CARD = 'LGY-1234-5678-9012-3456';
const TXN = 'txn-0123456789abcdefghij';
const NEXT = 'txn-continue-0123456789abc';
const PROVIDER = 'https://idp.example.com/authorize?state=s';
const noPasskeys: Passkeys = { supported: () => false, authenticate: vi.fn(), register: vi.fn() };
const SETUP_TOKEN = ['synthetic', 'setup', 'token', 'value'].join('-');
const CLIENT_SECRET = ['synthetic', 'client', 'secret'].join('-');
const COMPANY = '01a10174-0000-7000-8000-00000000c0de';
/** The return screen as the router mounts it: the company id is part of the address. */
const returnScreen = { at: `/sso/return/${COMPANY}`, route: '/sso/return/:tenantId' };

describe('signing in with the company account', () => {
  it('the person names the company and leaves for the provider; the 3-digit code is asked for on return', async () => {
    const user = userEvent.setup();
    const goTo = vi.fn();
    const api = new FakeApi({
      loginBegin: () => ({ login_txn: TXN, webauthn_options: {}, totp_allowed: true as const, expires_in: 300 }),
      ssoStart: () => ({ authorization_url: PROVIDER }),
    });
    renderScreen(<SignInScreen passkeys={noPasskeys} goTo={goTo} />, { api, session: sessionValue(null) });
    await user.type(screen.getByLabelText('Card number'), CARD);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    const go = await screen.findByRole('button', { name: "Sign in with my company's account" });
    expect((go as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText("Your company's short name"), 'Acme-Works');
    await user.click(go);
    await waitFor(() => expect(goTo).toHaveBeenCalledWith(PROVIDER));
    expect(api.callsTo('ssoStart')[0]?.body).toEqual({ txn: TXN, company: 'acme-works' });
    expect(api.callsTo('loginVerify')).toEqual([]);
  });

  it('a company without the company sign-in: one plain message, nothing else said', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({
      loginBegin: () => ({ login_txn: TXN, webauthn_options: {}, totp_allowed: true as const, expires_in: 300 }),
      ssoStart: () => {
        throw problem(401, 'Authentication failed');
      },
    });
    renderScreen(<SignInScreen passkeys={noPasskeys} goTo={vi.fn()} />, { api, session: sessionValue(null) });
    await user.type(screen.getByLabelText('Card number'), CARD);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.type(await screen.findByLabelText("Your company's short name"), 'acme');
    await user.click(screen.getByRole('button', { name: "Sign in with my company's account" }));
    expect(await screen.findByText(/Signing in with this company's account is not possible/)).toBeTruthy();
  });

  it('back from the provider: the code is handed on once and removed from the address bar; then the 3-digit code signs in', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', `/sso/return/${COMPANY}?code=provider-code&state=provider-state&iss=https%3A%2F%2Fidp.example.com`);
    const session = makeSession(['knowledge:ask']);
    const signedIn = vi.fn();
    const api = new FakeApi({ ssoFinish: () => ({ purpose: 'login' as const, login_txn: NEXT }), loginVerify: () => session });
    renderScreen(<SsoReturnScreen />, { api, session: sessionValue(null, { signedIn }), ...returnScreen });
    await user.type(await screen.findByLabelText('3-digit code'), '123');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(signedIn).toHaveBeenCalled());
    expect(signedIn.mock.calls[0]?.[0]).toBe(session);
    expect(api.callsTo('ssoFinish')).toEqual([{ body: { code: 'provider-code', state: 'provider-state', tenant_id: COMPANY, iss: 'https://idp.example.com' } }]);
    expect(api.callsTo('loginVerify')[0]?.body).toEqual({ login_txn: NEXT, sc: '123', factor: { type: 'sso' } });
    expect(window.location.search).toBe('');
  });

  it('a return that cannot be confirmed (used, expired, forged) says so and offers to start again', async () => {
    window.history.replaceState(null, '', `/sso/return/${COMPANY}?code=x&state=y`);
    const api = new FakeApi({ ssoFinish: () => { throw problem(401, 'Authentication failed'); } });
    renderScreen(<SsoReturnScreen />, { api, session: sessionValue(null), ...returnScreen });
    expect(await screen.findByText('That did not work')).toBeTruthy();
  });
});

describe('setting up a card with the company account', () => {
  it('chooses the company account, leaves for the provider, and the return finishes the set-up', async () => {
    const user = userEvent.setup();
    const goTo = vi.fn();
    const api = new FakeApi({
      enrollmentBegin: () => ({ enrollment_txn: TXN, factor_type: 'sso' as const }),
      ssoStart: () => ({ authorization_url: PROVIDER }),
    });
    renderScreen(<EnrollScreen passkeys={noPasskeys} goTo={goTo} />, { api, session: sessionValue(null) });
    await user.type(screen.getByLabelText('Card number'), CARD);
    await user.type(screen.getByLabelText('3-digit code'), '123');
    await user.type(screen.getByLabelText('Set-up token'), SETUP_TOKEN);
    await user.click(screen.getByRole('radio', { name: /My company's account/ }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(goTo).toHaveBeenCalledWith(PROVIDER));
    expect(api.callsTo('enrollmentBegin')[0]?.body).toMatchObject({ factor_type: 'sso' });
    expect(api.callsTo('ssoStart')[0]?.body).toEqual({ txn: TXN });

    window.history.replaceState(null, '', `/sso/return/${COMPANY}?code=c&state=s`);
    const back = new FakeApi({ ssoFinish: () => ({ purpose: 'enroll' as const, enrollment_txn: NEXT }), enrollmentComplete: () => undefined });
    renderScreen(<SsoReturnScreen />, { api: back, session: sessionValue(null), ...returnScreen });
    expect(await screen.findByText('Your card is ready')).toBeTruthy();
    expect(back.callsTo('enrollmentComplete')).toEqual([{ body: { enrollment_txn: NEXT } }]);
    expect(back.callsTo('ssoFinish')[0]?.body).toEqual({ code: 'c', state: 's', tenant_id: COMPANY });
  });
});

describe('the Owner\'s company sign-in screen', () => {
  const OWNER = ['getSsoConnection', 'putSsoConnection', 'removeSsoConnection'] as const;
  const as = (...ops: Parameters<typeof permissionsFor>) => sessionValue(makeSession(permissionsFor(...ops)));
  const conn: SsoConnection = {
    id: '01a10174-0000-7000-8000-000000000001', name: 'Company sign-in', protocol: 'oidc', issuer: 'https://idp.example.com', client_id: 'legacyai',
    enabled: true, has_client_secret: true, redirect_uri: `https://app.example.com/sso/return/${COMPANY}`, created_by_card_id: '01a10174-0000-7000-8000-000000000002',
    created_at: '2026-10-07T09:00:00.000Z', updated_at: '2026-10-07T09:00:00.000Z',
  };

  it('shows the address to register, connects a provider, and never shows the secret again', async () => {
    const user = userEvent.setup();
    let stored: SsoConnection | null = null;
    const api = new FakeApi({
      getSsoConnection: () => ({ connection: stored, redirect_uri: `https://app.example.com/sso/return/${COMPANY}` }),
      putSsoConnection: () => {
        stored = conn;
        return conn;
      },
    });
    renderScreen(<SsoScreen />, { api, session: as(...OWNER) });
    expect((await screen.findByTestId('redirect-uri')).textContent).toBe(`https://app.example.com/sso/return/${COMPANY}`);
    await user.clear(screen.getByLabelText('Provider (issuer)'));
    await user.type(screen.getByLabelText('Provider (issuer)'), 'https://idp.example.com');
    await user.type(screen.getByLabelText('Client id'), 'legacyai');
    await user.type(screen.getByLabelText('Client secret'), CLIENT_SECRET);
    await user.click(screen.getByLabelText(/Switched on/));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.callsTo('putSsoConnection')).toHaveLength(1));
    expect(api.callsTo('putSsoConnection')[0]?.body).toEqual({ name: 'Company sign-in', issuer: 'https://idp.example.com', client_id: 'legacyai', enabled: true, client_secret: CLIENT_SECRET });
    expect(await screen.findByText('Stored (never shown)')).toBeTruthy();
    expect(document.body.textContent).not.toContain(CLIENT_SECRET);
  });

  it('removing it asks twice, and the result stays on the screen after the connection is gone (found by the browser test)', async () => {
    const user = userEvent.setup();
    let stored: SsoConnection | null = conn;
    const api = new FakeApi({
      getSsoConnection: () => ({ connection: stored, redirect_uri: conn.redirect_uri }),
      removeSsoConnection: () => {
        stored = null;
        return { removed: true as const, factors_revoked: 2 };
      },
    });
    renderScreen(<SsoScreen />, { api, session: as(...OWNER) });
    await user.click(await screen.findByRole('button', { name: 'Remove the company sign-in…' }));
    expect(api.callsTo('removeSsoConnection')).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Yes, remove it for good' }));
    expect(await screen.findByText(/2 linked company account\(s\) no longer sign anyone in/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Stored (never shown)')).toBeNull());   // the connection is gone ...
    expect(screen.getByText(/no longer sign anyone in/)).toBeTruthy();                     // ... and the result is still there
  });

  it('a card that may only read sees no form and no remove button', async () => {
    const api = new FakeApi({ getSsoConnection: () => ({ connection: conn, redirect_uri: conn.redirect_uri }) });
    renderScreen(<SsoScreen />, { api, session: as('getSsoConnection') });
    expect(await screen.findByText('https://idp.example.com')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Remove/ })).toBeNull();
  });
});
