// Sign in: card number, then the 3-digit code together with a passkey or an authenticator-app code.
// The card number and the 3-digit code alone never sign anyone in; the API enforces that.
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import type { LoginBeginResponse } from '../../api/generated.ts';
import { useSession } from '../../session/session.tsx';
import { Banner, Button, Card, ErrorNote, TextField } from '../../ui/index.tsx';
import { keepDigits, useLoginBegin, useLoginVerify } from './hooks.ts';
import { browserPasskeys, passkeyProblem, type Passkeys } from './passkeys.ts';

export function SignInScreen({ passkeys = browserPasskeys }: { passkeys?: Passkeys }) {
  const { signedIn } = useSession();
  const begin = useLoginBegin();
  const verify = useLoginVerify();
  const [cardNumber, setCardNumber] = useState('');
  const [started, setStarted] = useState<LoginBeginResponse | null>(null);
  const [sc, setSc] = useState('');
  const [code, setCode] = useState('');
  const [deviceProblem, setDeviceProblem] = useState<string | null>(null);
  const canUsePasskey = passkeys.supported();
  const scReady = sc.length === 3;

  const startOver = (): void => {
    setStarted(null);
    setSc('');
    setCode('');
    setDeviceProblem(null);
    verify.reset();
  };

  const onCard = (e: FormEvent): void => {
    e.preventDefault();
    begin.mutate({ body: { card_number: cardNumber.trim() } }, { onSuccess: setStarted });
  };

  const finish = (factor: { type: 'passkey'; assertion: Record<string, unknown> } | { type: 'totp'; code: string }): void => {
    if (started === null) return;
    verify.mutate({ body: { login_txn: started.login_txn, sc, factor } }, { onSuccess: signedIn });
  };

  const withPasskey = async (): Promise<void> => {
    if (started === null) return;
    setDeviceProblem(null);
    try {
      finish({ type: 'passkey', assertion: await passkeys.authenticate(started.webauthn_options) });
    } catch (err) {
      setDeviceProblem(passkeyProblem(err));
    }
  };

  const withCode = (e: FormEvent): void => {
    e.preventDefault();
    finish({ type: 'totp', code });
  };

  return (
    <div className="narrow">
      <h1>Sign in to LegacyAI</h1>
      {started === null ? (
        <Card>
          <form onSubmit={onCard} noValidate>
            <TextField label="Card number" hint="As printed on your card. Spaces and dashes are fine." autoComplete="username" autoFocus required
              value={cardNumber} onChange={(e) => setCardNumber(e.target.value)} />
            <ErrorNote error={begin.error} />
            <Button type="submit" variant="primary" busy={begin.isPending} disabled={cardNumber.trim().length < 16}>Continue</Button>
          </form>
          <p className="hint">First time with this card? <Link to="/set-up">Set it up</Link>.</p>
        </Card>
      ) : (
        <Card>
          <TextField label="3-digit code" hint="The secret code that came with your card." inputMode="numeric" autoComplete="off" autoFocus
            value={sc} onChange={(e) => setSc(keepDigits(e.target.value, 3))} />
          {verify.error !== null && (
            <Banner tone="danger" title="Sign-in did not work">
              Check the card number, the 3-digit code and your passkey or app code. For safety we do not say which one was wrong.
              After several wrong attempts the card is locked for a while.
            </Banner>
          )}
          {deviceProblem !== null && <Banner tone="warning">{deviceProblem}</Banner>}
          <h2>Then prove it is you</h2>
          {canUsePasskey && (
            <p><Button variant="primary" onClick={() => void withPasskey()} busy={verify.isPending} disabled={!scReady}>Use a passkey</Button></p>
          )}
          <form onSubmit={withCode} noValidate>
            <TextField label="Code from your authenticator app" hint="6 keepDigits. Each code works once." inputMode="numeric" autoComplete="one-time-code"
              value={code} onChange={(e) => setCode(keepDigits(e.target.value, 6))} />
            <div className="row">
              <Button type="submit" variant={canUsePasskey ? 'secondary' : 'primary'} busy={verify.isPending} disabled={!scReady || code.length !== 6}>Sign in with the app code</Button>
              <button type="button" className="link-button" onClick={startOver}>Use a different card</button>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}
