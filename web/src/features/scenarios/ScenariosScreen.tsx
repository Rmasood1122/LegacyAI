// Scenarios, for a learner: the scenarios offered to this card, and the runs so far.
// A scenario is a situation ("what would you do if ...") answered step by step in the learner's own words.
import { useNavigate } from 'react-router';
import { ScreenLink, useScreenPath } from '../../navigation/ScreenLink.tsx';
import { useSession } from '../../session/session.tsx';
import { Badge, Button, Card, DataTable, Empty, ErrorNote, formatDate, Loading, Page, PartialListNote } from '../../ui/index.tsx';
import { isFinishedRun, RUN_STATUS_TEXT, runTone, useOffers, useRunList, useStartRun } from './hooks.ts';

export function ScenariosScreen() {
  const { can } = useSession();
  const offers = useOffers();
  const start = useStartRun();
  const navigate = useNavigate();
  const pathTo = useScreenPath();
  const begin = (scenarioId: string): void => {
    start.mutate({ path: { scenario_id: scenarioId } }, {
      onSuccess: (run) => {
        const next = pathTo({ screen: 'scenarioRun', id: run.id });
        if (next !== null) void navigate(next);
      },
    });
  };
  const items = offers.data?.items ?? [];
  return (
    <Page title="Scenarios" intro="A scenario describes a situation at work and asks what you would do, step by step. You answer in your own words. It shows what you know; it is not a certificate.">
      <Card title="Scenarios you can run">
        {offers.isPending && <Loading what="scenarios" />}
        <ErrorNote error={offers.error ?? start.error} />
        {offers.data !== undefined && (items.length === 0 ? <Empty>No scenario is offered to you at the moment.</Empty> : (
          <ul className="plain-list">
            {items.map((s) => (
              <li key={s.id}>
                <h3>{s.title}</h3>
                <p>{s.situation}</p>
                <p className="muted">For: {s.job_role} · {s.step_count} {s.step_count === 1 ? 'step' : 'steps'}</p>
                <Button variant="primary" busy={start.isPending} onClick={() => begin(s.id)} aria-label={`Start: ${s.title}`}>Start</Button>
              </li>
            ))}
          </ul>
        ))}
        {offers.data?.truncated === true && <p className="muted">Only the first 200 approved scenarios were looked at; there may be more.</p>}
        <p className="muted">A run has a time limit, which starts when you press Start. What you type is saved when you leave the field.</p>
      </Card>
      {can('listScenarioAttempts') && <Runs />}
    </Page>
  );
}

/** Runs, newest first. What the list holds is decided by the API: a learner's own runs, or the company's. */
function Runs() {
  const { can } = useSession();
  const runs = useRunList({ enabled: can('listScenarioAttempts') });
  const items = runs.items ?? [];
  return (
    <Card title="Runs so far">
      {runs.isPending && <Loading what="runs" />}
      <ErrorNote error={runs.error} />
      {runs.items !== undefined && (items.length === 0 ? <Empty>No scenario has been run yet.</Empty> : (
        <DataTable caption="Scenario runs" columns={['Scenario', 'Job role', 'State', 'Started', 'Open']}>
          {items.map((r) => (
            <tr key={r.id}>
              <td>{r.title}</td>
              <td>{r.job_role}</td>
              <td><Badge tone={runTone(r.status)}>{RUN_STATUS_TEXT[r.status] ?? r.status}</Badge></td>
              <td>{formatDate(r.started_at)}</td>
              <td><ScreenLink screen="scenarioRun" id={r.id}>{isFinishedRun(r.status) ? 'Result' : 'Continue'}</ScreenLink></td>
            </tr>
          ))}
        </DataTable>
      ))}
      {runs.hasMore && <PartialListNote shown={items.length} noun="runs" busy={runs.isLoadingMore} onLoadMore={runs.loadMore} />}
    </Card>
  );
}
