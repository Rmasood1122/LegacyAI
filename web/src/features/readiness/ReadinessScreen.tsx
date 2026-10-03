// Readiness test, the start: a learner names the job role and begins, and sees the tests taken so far.
// People who may read results see the company's tests, and can open one by its reference.
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { ScreenLink, useScreenPath } from '../../navigation/ScreenLink.tsx';
import { useSession } from '../../session/session.tsx';
import { Badge, Banner, Button, Card, DataTable, Empty, ErrorNote, formatDate, Loading, Page, PartialListNote, TextField } from '../../ui/index.tsx';
import { ATTEMPT_STATUS_TEXT, attemptTone, isFinishedAttempt, useAttemptList, useJobRoleChoices, useStartAttempt } from './hooks.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function ReadinessScreen() {
  const { can } = useSession();
  const start = useStartAttempt();
  const navigate = useNavigate();
  const pathTo = useScreenPath();
  const [jobRole, setJobRole] = useState('');
  const roles = useJobRoleChoices({ enabled: can('listJobRoles') });
  const known = roles.items ?? [];
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
          <TextField label="For which job role?" hint="Type the name you were given, for example “Boiler operator”, or pick one below." maxLength={120} value={jobRole} onChange={(e) => setJobRole(e.target.value)} />
          {known.length > 0 && (
            <div className="row">
              {known.map((r) => <Button key={r.job_role} onClick={() => setJobRole(r.job_role)}>{r.job_role}</Button>)}
            </div>
          )}
          {roles.hasMore && <PartialListNote shown={known.length} noun="job roles" busy={roles.isLoadingMore} onLoadMore={roles.loadMore} />}
          {noQuestions
            ? <Banner tone="warning" title="There is no test for this job role yet">No approved questions exist for it that you are allowed to see. Check the spelling, or ask the person who runs the programme.</Banner>
            : <ErrorNote error={start.error} />}
          <p className="muted">The test has a time limit, which starts when you press the button. A chosen option is saved at once; a typed answer is saved when you leave its field or press “Save this answer”.</p>
          <Button type="submit" variant="primary" busy={start.isPending} disabled={jobRole.trim() === ''}>Start the test</Button>
        </form>
      </Card>
      {can('listReadinessAttempts') && <TestsTaken />}
      {can('getReadinessReport') && <OpenByReference />}
    </Page>
  );
}

/** Tests taken, newest first. What the list holds is decided by the API: a learner's own tests, or the company's. */
export function TestsTaken() {
  const attempts = useAttemptList();
  const items = attempts.items ?? [];
  return (
    <Card title="Tests taken">
      {attempts.isPending && <Loading what="tests" />}
      <ErrorNote error={attempts.error} />
      {attempts.items !== undefined && (items.length === 0 ? <Empty>No test has been taken yet.</Empty> : (
        <DataTable caption="Tests taken" columns={['Job role', 'State', 'Started', 'Open']}>
          {items.map((a) => (
            <tr key={a.id}>
              <td>{a.job_role}</td>
              <td><Badge tone={attemptTone(a.status)}>{ATTEMPT_STATUS_TEXT[a.status] ?? a.status}</Badge></td>
              <td>{formatDate(a.started_at)}</td>
              <td>
                <div className="row">
                  <ScreenLink screen="attempt" id={a.id}>{isFinishedAttempt(a.status) ? 'Answers' : 'Continue'}</ScreenLink>
                  {isFinishedAttempt(a.status) && <ScreenLink screen="report" id={a.id}>Report</ScreenLink>}
                </div>
              </td>
            </tr>
          ))}
        </DataTable>
      ))}
      {attempts.hasMore && <PartialListNote shown={items.length} noun="tests" busy={attempts.isLoadingMore} onLoadMore={attempts.loadMore} />}
    </Card>
  );
}

/** A test can also be opened by the reference shown on it (for example one sent by a colleague). */
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
      <TextField label="Reference of the test" hint="It is shown at the top of every test and report." value={reference}
        error={reference.trim() !== '' && !valid ? 'A reference looks like 01234567-89ab-cdef-0123-456789abcdef.' : null} onChange={(e) => setReference(e.target.value)} />
      <div className="row">
        <Button disabled={!valid} onClick={() => open('report')}>Open the report</Button>
        <Button disabled={!valid} onClick={() => open('attempt')}>Open the answers</Button>
      </div>
    </Card>
  );
}
