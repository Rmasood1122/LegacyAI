// Readiness test, the start: a learner names the job role and begins. People who may read results
// can open a test or its report by its reference.
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useScreenPath } from '../../navigation/ScreenLink.tsx';
import { useSession } from '../../session/session.tsx';
import { Banner, Button, Card, ErrorNote, Page, TextField } from '../../ui/index.tsx';
import { useStartAttempt } from './hooks.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function ReadinessScreen() {
  const { can } = useSession();
  const start = useStartAttempt();
  const navigate = useNavigate();
  const pathTo = useScreenPath();
  const [jobRole, setJobRole] = useState('');
  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    start.mutate({ body: { job_role: jobRole.trim() } }, {
      onSuccess: (attempt) => {
        const next = pathTo({ screen: 'attempt', id: attempt.id });
        if (next !== null) void navigate(next);
      },
    });
  };
  const noQuestions = start.error !== null && start.error.status === 422;
  return (
    <Page title="Readiness test" intro="A short test on the verified knowledge for a job role. It shows what you know and where the material itself is still thin. It is not a certificate.">
      <Card title="Start a test">
        <form onSubmit={onSubmit} noValidate>
          <TextField label="For which job role?" hint="Type the name you were given, for example “Boiler operator”." maxLength={120} value={jobRole} onChange={(e) => setJobRole(e.target.value)} />
          {noQuestions
            ? <Banner tone="warning" title="There is no test for this job role yet">No approved questions exist for it that you are allowed to see. Check the spelling, or ask the person who runs the programme.</Banner>
            : <ErrorNote error={start.error} />}
          <p className="muted">The test has a time limit, which starts when you press the button. A chosen option is saved at once; a typed answer is saved when you leave its field or press “Save this answer”.</p>
          <Button type="submit" variant="primary" busy={start.isPending} disabled={jobRole.trim() === ''}>Start the test</Button>
        </form>
      </Card>
      {can('getReadinessReport') && <OpenByReference />}
    </Page>
  );
}

/** The service has no list of tests taken, so a test is opened by the reference shown on it. */
export function OpenByReference() {
  const navigate = useNavigate();
  const pathTo = useScreenPath();
  const [reference, setReference] = useState('');
  const valid = UUID.test(reference.trim());
  const open = (screen: 'attempt' | 'report'): void => {
    const next = pathTo({ screen, id: reference.trim() });
    if (next !== null) void navigate(next);
  };
  return (
    <Card title="Open a test by its reference">
      <TextField label="Reference of the test" hint="It is shown at the top of every test and report. There is no list of past tests yet." value={reference}
        error={reference.trim() !== '' && !valid ? 'A reference looks like 01234567-89ab-cdef-0123-456789abcdef.' : null} onChange={(e) => setReference(e.target.value)} />
      <div className="row">
        <Button disabled={!valid} onClick={() => open('report')}>Open the report</Button>
        <Button disabled={!valid} onClick={() => open('attempt')}>Open the answers</Button>
      </div>
    </Card>
  );
}
