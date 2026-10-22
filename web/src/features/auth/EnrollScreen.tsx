// First-time set-up of a card: the card number, the 3-digit code and the one-time set-up token,
// then a passkey on this device, an authenticator app, or the company's own sign-in (SSO, when the company set it up:
// the person signs in at the company's identity provider and comes back to /sso/return, which finishes the set-up).
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import type { EnrollmentBeginResponse } from '../../api/generated.ts';
import { Banner, Button, Card, ErrorNote, TextField } from '../../ui/index.tsx';
import { goToProvider, keepDigits, useEnrollmentBegin, useEnrollmentComplete, useSsoStart, type GoTo } from './hooks.ts';
import { browserPasskeys, passkeyProblem, type Passkeys } from './passkeys.ts';

type Method = 'passkey' | 'totp' | 'sso';

export function EnrollScreen({ passkeys = browserPasskeys, goTo = goToProvider }: { passkeys?: Passkeys; goTo?: GoTo }) {
  const begin = useEnrollmentBegin();
  const complete = useEnrollmentComplete();
  const ssoStart = useSsoStart();
  const canUsePasskey = passkeys.supported();
  const [cardNumber, setCardNumber] = useState('');
  const [sc, setSc] = useState('');
  const [token, setToken] = useState('');
  const [method, setMethod] = useState<Method>(canUsePasskey ? 'passkey' : 'totp');
  const [started, setStarted] = useState<EnrollmentBeginResponse | null>(null);
  const [code, setCode] = useState('');
  const [deviceProblem, setDeviceProblem] = useState<string | null>(null);

  const createPasskey = async (step: EnrollmentBeginResponse): Promise<void> => {
    if (step.webauthn_options === undefined) return;
    setDeviceProblem(null);
    try {
      complete.mutate({ body: { enrollment_txn: step.enrollment_txn, attestation: await passkeys.register(step.webauthn_options) } });
    } catch (err) {
      setDeviceProblem(passkeyProblem(err));
    }
  };

  const onStart = (e: FormEvent): void => {
    e.preventDefault();
    begin.mutate(
      { body: { card_number: cardNumber.trim(), sc, enrollment_token: token.trim(), factor_type: method, ...(method === 'passkey' ? { label: 'This device' } : {}) } },
      {
        onSuccess: (step) => {
          setStarted(step);
          if (step.factor_type === 'passkey') void createPasskey(step);
          if (step.factor_type === 'sso') ssoStart.mutate({ body: { txn: step.enrollment_txn } }, { onSuccess: (r) => goTo(r.authorization_url) });
        },
      },
    );
  };

  const onCode = (e: FormEvent): void => {
    e.preventDefault();
    if (started !== null) complete.mutate({ body: { enrollment_txn: started.enrollment_txn, totp_code: code } });
  };

  if (complete.isSuccess) {
    return (
      <div className="narrow">
        <h1>Set-up complete</h1>
        <Banner tone="success" title="Your card is ready">
          {method === 'totp' ? 'Wait for the next code in your app before you sign in: each code works only once.' : 'You can sign in now.'}
        </Banner>
        <p><Link to="/">Go to sign-in</Link></p>
      </div>
    );
  }

  return (
    <div className="narrow">
      <h1>Set up your card</h1>
      {started === null ? (
        <Card>
          <form onSubmit={onStart} noValidate>
            <TextField label="Card number" autoComplete="username" autoFocus value={cardNumber} onChange={(e) => setCardNumber(e.target.value)} />
            <TextField label="3-digit code" inputMode="numeric" autoComplete="off" value={sc} onChange={(e) => setSc(keepDigits(e.target.value, 3))} />
            <TextField label="Set-up token" hint="Given to you once, together with the card. It expires." autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
            <fieldset>
              <legend>How do you want to sign in?</legend>
              <label className="choice">
                <input type="radio" name="method" checked={method === 'passkey'} disabled={!canUsePasskey} onChange={() => setMethod('passkey')} />
                <span>A passkey on this device (fingerprint, face or security key){canUsePasskey ? '' : ' — not available in this browser'}</span>
              </label>
              <label className="choice">
                <input type="radio" name="method" checked={method === 'totp'} onChange={() => setMethod('totp')} />
                <span>An authenticator app that shows 6-digit codes</span>
              </label>
              <label className="choice">
                <input type="radio" name="method" checked={method === 'sso'} onChange={() => setMethod('sso')} />
                <span>My company's account (only if your company set this up)</span>
              </label>
            </fieldset>
            <ErrorNote error={begin.error} />
            <Button type="submit" variant="primary" busy={begin.isPending} disabled={cardNumber.trim().length < 16 || sc.length !== 3 || token.trim().length < 20}>Continue</Button>
          </form>
          <p className="hint">Already set up? <Link to="/">Sign in</Link>.</p>
        </Card>
      ) : started.factor_type === 'sso' ? (
        <Card title="Signing in with your company's account">
          {ssoStart.error === null ? <p>Taking you to your company's sign-in page…</p> : (
            <Banner tone="warning" title="Your company's sign-in is not available">Choose a passkey or an authenticator app instead.</Banner>
          )}
        </Card>
      ) : started.factor_type === 'totp' && started.totp !== undefined ? (
        <Card title="Add this card to your authenticator app">
          <p>Type this key into the app (choose “time-based”). It is shown only now.</p>
          <p className="code" data-testid="totp-secret">{started.totp.secret}</p>
          <form onSubmit={onCode} noValidate>
            <TextField label="Code shown by the app" hint="6 digits." inputMode="numeric" autoComplete="one-time-code" autoFocus
              value={code} onChange={(e) => setCode(keepDigits(e.target.value, 6))} />
            <ErrorNote error={complete.error} />
            <Button type="submit" variant="primary" busy={complete.isPending} disabled={code.length !== 6}>Finish set-up</Button>
          </form>
        </Card>
      ) : (
        <Card title="Create the passkey">
          <p>Follow your device’s prompt.</p>
          {deviceProblem !== null && <Banner tone="warning">{deviceProblem}</Banner>}
          <ErrorNote error={complete.error} />
          <Button variant="primary" busy={complete.isPending} onClick={() => void createPasskey(started)}>Try again</Button>
        </Card>
      )}
    </div>
  );
}
