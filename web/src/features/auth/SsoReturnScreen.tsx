// Back from the company's identity provider (SSO, docs/phase4/07). The address carries the provider's code and the
// state; this screen hands both to the API at once (single use), and removes them from the address bar. Then:
//   - a sign-in: the person types the card's 3-digit code - the provider alone never signs anyone in;
//   - a set-up: the set-up is finished; the person signs in next time with the company's account.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import type { OperationTypes } from '../../api/generated.ts';

type SsoFinishResponse = OperationTypes['ssoFinish']['response'];
import { useSession } from '../../session/session.tsx';
import { Banner, Button, Card, Loading, TextField } from '../../ui/index.tsx';
import { keepDigits, useEnrollmentComplete, useLoginVerify, useSsoFinish } from './hooks.ts';

export function SsoReturnScreen() {
  const { signedIn } = useSession();
  const finish = useSsoFinish();
  const verify = useLoginVerify();
  const complete = useEnrollmentComplete();
  const [step, setStep] = useState<SsoFinishResponse | null>(null);
  const [sc, setSc] = useState('');
  const asked = useRef(false);

  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    // the code and state are spent now; they do not stay in the address bar or the history
    window.history.replaceState(null, '', window.location.pathname);
    if (code === null || state === null) return;
    finish.mutate({ body: { code, state } }, {
      onSuccess: (next) => {
        setStep(next);
        if (next.purpose === 'enroll' && next.enrollment_txn !== undefined) complete.mutate({ body: { enrollment_txn: next.enrollment_txn } });
      },
    });
  }, [finish, complete]);

  const onCode = (e: FormEvent): void => {
    e.preventDefault();
    if (step?.login_txn !== undefined) verify.mutate({ body: { login_txn: step.login_txn, sc, factor: { type: 'sso' } } }, { onSuccess: signedIn });
  };

  const failed = finish.isError || (!finish.isPending && step === null && finish.isIdle);
  return (
    <div className="narrow">
      <h1>Signing in with your company's account</h1>
      {finish.isPending && <Loading what="your company's answer" />}
      {failed && (
        <Banner tone="danger" title="That did not work">
          The sign-in at your company could not be confirmed, or it was already used. <Link to="/">Start again</Link>.
        </Banner>
      )}
      {step?.purpose === 'login' && (
        <Card>
          <form onSubmit={onCode} noValidate>
            <TextField label="3-digit code" hint="The secret code that came with your card." inputMode="numeric" autoComplete="off" autoFocus
              value={sc} onChange={(e) => setSc(keepDigits(e.target.value, 3))} />
            {verify.error !== null && (
              <Banner tone="danger" title="Sign-in did not work">
                Check the 3-digit code, and that you signed in at your company with your own account. <Link to="/">Start again</Link>.
              </Banner>
            )}
            <Button type="submit" variant="primary" busy={verify.isPending} disabled={sc.length !== 3}>Sign in</Button>
          </form>
        </Card>
      )}
      {step?.purpose === 'enroll' && (
        <>
          {complete.isPending && <Loading what="the set-up" />}
          {complete.isSuccess && <Banner tone="success" title="Your card is ready">Next time, sign in with your company's account. <Link to="/">Go to sign-in</Link>.</Banner>}
          {complete.isError && <Banner tone="danger" title="The set-up did not work">This company account may already belong to another card. Ask an administrator of your company.</Banner>}
        </>
      )}
    </div>
  );
}
