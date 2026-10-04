import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FakeApi, makeSession, problem, renderScreen, sessionValue } from '../../test/harness.tsx';
import { EnrollScreen } from './EnrollScreen.tsx';
import type { Passkeys } from './passkeys.ts';
import { SignInScreen } from './SignInScreen.tsx';

const CARD = 'LGY-1234-5678-9012-3456';
const TXN = 'txn-0123456789abcdefghij';
// Synthetic, built from words so that no secret scanner mistakes it for a real token.
const SETUP_TOKEN = ['synthetic', 'setup', 'token', 'value'].join('-');
const noPasskeys: Passkeys = { supported: () => false, authenticate: vi.fn(), register: vi.fn() };
const begun = { login_txn: TXN, webauthn_options: { challenge: 'abc' }, totp_allowed: true as const, expires_in: 300 };

describe('sign-in', () => {
  it('the QR link of a card fills in the card number, is removed from the address bar, and nothing else is skipped', async () => {
    window.history.replaceState(null, '', `/#card=${CARD}`);
    const api = new FakeApi({ loginBegin: () => begun });
    renderScreen(<SignInScreen passkeys={noPasskeys} />, { api, session: sessionValue(null) });
    expect((screen.getByLabelText('Card number') as HTMLInputElement).value).toBe(CARD);
    await waitFor(() => expect(window.location.hash).toBe(''));
    expect(api.calls).toEqual([]);                                   // nothing is sent until the person presses Continue
    expect(screen.queryByLabelText('3-digit code')).toBeNull();      // and the 3-digit code is still asked for afterwards
  });

  it('a fragment that is not exactly a card number is ignored and removed', async () => {
    window.history.replaceState(null, '', `/#card=${CARD}&sc=123`);
    renderScreen(<SignInScreen passkeys={noPasskeys} />, { api: new FakeApi({}), session: sessionValue(null) });
    expect((screen.getByLabelText('Card number') as HTMLInputElement).value).toBe('');
    await waitFor(() => expect(window.location.hash).toBe(''));
  });

  it('signs in with card number, 3-digit code and an authenticator-app code', async () => {
    const user = userEvent.setup();
    const session = makeSession(['knowledge:ask']);
    const signedIn = vi.fn();
    const api = new FakeApi({ loginBegin: () => begun, loginVerify: () => session });
    renderScreen(<SignInScreen passkeys={noPasskeys} />, { api, session: sessionValue(null, { signedIn }) });

    await user.type(screen.getByLabelText('Card number'), CARD);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    const submit = await screen.findByRole('button', { name: 'Sign in with the app code' });
    expect((submit as HTMLInputElement).disabled).toBe(true);
    await user.type(screen.getByLabelText('3-digit code'), '12a3');
    await user.type(screen.getByLabelText('Code from your authenticator app'), '654 321');
    await user.click(submit);

    await waitFor(() => expect(signedIn).toHaveBeenCalled());
    expect(signedIn.mock.calls[0]?.[0]).toBe(session);
    expect(api.callsTo('loginBegin')[0]?.body).toEqual({ card_number: CARD });
    expect(api.callsTo('loginVerify')[0]?.body).toEqual({ login_txn: TXN, sc: '123', factor: { type: 'totp', code: '654321' } });
    expect(screen.queryByRole('button', { name: 'Use a passkey' })).toBeNull();
  });

  it('signs in with a passkey', async () => {
    const user = userEvent.setup();
    const signedIn = vi.fn();
    const assertion = { id: 'cred-1', response: {} };
    const passkeys: Passkeys = { supported: () => true, authenticate: vi.fn(async () => assertion), register: vi.fn() };
    const api = new FakeApi({ loginBegin: () => begun, loginVerify: () => makeSession([]) });
    renderScreen(<SignInScreen passkeys={passkeys} />, { api, session: sessionValue(null, { signedIn }) });
    await user.type(screen.getByLabelText('Card number'), CARD);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.type(await screen.findByLabelText('3-digit code'), '123');
    await user.click(screen.getByRole('button', { name: 'Use a passkey' }));
    await waitFor(() => expect(signedIn).toHaveBeenCalled());
    expect(passkeys.authenticate).toHaveBeenCalledWith(begun.webauthn_options);
    expect(api.callsTo('loginVerify')[0]?.body).toEqual({ login_txn: TXN, sc: '123', factor: { type: 'passkey', assertion } });
  });

  it('a failed sign-in does not say which part was wrong; a cancelled passkey is explained', async () => {
    const user = userEvent.setup();
    const cancelled = Object.assign(new Error('cancelled'), { name: 'NotAllowedError' });
    const passkeys: Passkeys = { supported: () => true, authenticate: vi.fn(async () => { throw cancelled; }), register: vi.fn() };
    const api = new FakeApi({ loginBegin: () => begun, loginVerify: () => { throw problem(401, 'Sign-in failed', 'unauthenticated'); } });
    renderScreen(<SignInScreen passkeys={passkeys} />, { api, session: sessionValue(null) });
    await user.type(screen.getByLabelText('Card number'), CARD);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.type(await screen.findByLabelText('3-digit code'), '123');
    await user.click(screen.getByRole('button', { name: 'Use a passkey' }));
    expect(await screen.findByText(/cancelled or timed out/)).toBeTruthy();
    expect(api.callsTo('loginVerify')).toHaveLength(0);
    await user.type(screen.getByLabelText('Code from your authenticator app'), '000000');
    await user.click(screen.getByRole('button', { name: 'Sign in with the app code' }));
    expect(await screen.findByText('Sign-in did not work')).toBeTruthy();
    expect(screen.getByText(/do not say which one was wrong/)).toBeTruthy();
  });
});

describe('first-time set-up', () => {
  const fill = async (user: ReturnType<typeof userEvent.setup>): Promise<void> => {
    await user.type(screen.getByLabelText('Card number'), CARD);
    await user.type(screen.getByLabelText('3-digit code'), '123');
    await user.type(screen.getByLabelText('Set-up token'), SETUP_TOKEN);
  };

  it('sets up an authenticator app: shows the key once, takes a code, and says to wait for the next one', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({
      enrollmentBegin: () => ({ enrollment_txn: TXN, factor_type: 'totp', totp: { secret: 'JBSWY3DPEHPK3PXP', otpauth_uri: 'otpauth://totp/LegacyAI' } }),
      enrollmentComplete: () => undefined,
    });
    renderScreen(<EnrollScreen passkeys={noPasskeys} />, { api, session: sessionValue(null) });
    await fill(user);
    expect((screen.getByRole('radio', { name: /passkey/ }) as HTMLInputElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('JBSWY3DPEHPK3PXP')).toBeTruthy();
    await user.type(screen.getByLabelText('Code shown by the app'), '111222');
    await user.click(screen.getByRole('button', { name: 'Finish set-up' }));
    expect(await screen.findByText('Your card is ready')).toBeTruthy();
    expect(screen.getByText(/each code works only once/)).toBeTruthy();
    expect(api.callsTo('enrollmentBegin')[0]?.body).toEqual({ card_number: CARD, sc: '123', enrollment_token: SETUP_TOKEN, factor_type: 'totp' });
    expect(api.callsTo('enrollmentComplete')[0]?.body).toEqual({ enrollment_txn: TXN, totp_code: '111222' });
  });

  it('sets up a passkey', async () => {
    const user = userEvent.setup();
    const attestation = { id: 'new-cred' };
    const passkeys: Passkeys = { supported: () => true, authenticate: vi.fn(), register: vi.fn(async () => attestation) };
    const api = new FakeApi({
      enrollmentBegin: () => ({ enrollment_txn: TXN, factor_type: 'passkey', webauthn_options: { challenge: 'xyz' } }),
      enrollmentComplete: () => undefined,
    });
    renderScreen(<EnrollScreen passkeys={passkeys} />, { api, session: sessionValue(null) });
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Your card is ready')).toBeTruthy();
    expect(passkeys.register).toHaveBeenCalledWith({ challenge: 'xyz' });
    expect(api.callsTo('enrollmentComplete')[0]?.body).toEqual({ enrollment_txn: TXN, attestation });
  });

  it('shows the API\'s refusal (wrong or expired token)', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({ enrollmentBegin: () => { throw problem(401, 'These details are not valid', 'unauthenticated'); } });
    renderScreen(<EnrollScreen passkeys={noPasskeys} />, { api, session: sessionValue(null) });
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('These details are not valid')).toBeTruthy();
  });
});
