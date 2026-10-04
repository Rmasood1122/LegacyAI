// Activity numbers (feature 27): what was done in the product, month by month.
// These are counts of activity. They are not business outcomes and the screen says so.
import type { KActivityJobRole, KActivityJobRoleResults } from '../../api/generated.ts';
import { ScreenLink } from '../../navigation/ScreenLink.tsx';
import { useSession } from '../../session/session.tsx';
import { saveAsFile } from '../../ui/files.ts';
import { Button, Card, DataTable, Empty, ErrorNote, Facts, Loading, Page } from '../../ui/index.tsx';
import { activityCsv, MONTHS_SHOWN, useActivity, useUsage } from './hooks.ts';

const monthText = (iso: string): string => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const dayText = (iso: string): string => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
/** A number this card has no right to arrives as null: it is said in words, never shown as 0. */
const orNotYours = (n: number | null): string | number => n ?? 'Not shown to this card';

export function ActivityScreen() {
  const { can } = useSession();
  const activity = useActivity();
  const usage = useUsage({ enabled: can('getTenantUsage') });
  const a = activity.data;
  const most = a === undefined ? 1 : Math.max(1, ...a.months.map((m) => m.items_captured));

  return (
    <Page title="Activity" intro="What was done in the product, month by month. These numbers count activity; they do not show what it was worth to the company.">
      {activity.isPending && <Loading what="the numbers" />}
      <ErrorNote error={activity.error} />
      {a !== undefined && (
        <div>
          <Card title="Knowledge items as they stand now">
            <Facts items={[
              ['Verified', a.items_now.verified],
              ['Not yet verified', a.items_now.not_yet_verified],
              ['Verified long ago, to be checked again', a.items_now.stale_items],
            ]} />
            <p className="muted">Counted among the items this card may read. Questions and answers are counted on the answer-quality screen.</p>
            <p><ScreenLink screen="quality">Open answer quality</ScreenLink></p>
          </Card>
          {usage.data !== undefined && (
            <Card title="Cards and people">
              <Facts items={[
                ['People', usage.data.people],
                ['Active cards', usage.data.cards_by_state.active ?? 0],
                ['Sign-ins in the last 30 days', usage.data.logins_last_30_days],
              ]} />
            </Card>
          )}
          <h2>The last {MONTHS_SHOWN} months</h2>
          {a.months.length === 0 ? <Empty>Nothing was recorded in this time.</Empty> : (
            <DataTable caption="Activity by month" columns={['Month', 'Documents added', 'Items captured', 'Compared with the busiest month', 'Items verified', 'Median hours to verify', 'Interviews completed', 'Tests handed in']}>
              {a.months.map((m) => (
                <tr key={m.month_start}>
                  <td>{monthText(m.month_start)}</td>
                  <td>{m.documents_added}</td>
                  <td>{m.items_captured}</td>
                  <td><progress className="bar" max={most} value={m.items_captured} aria-label={`Items captured in ${monthText(m.month_start)}`} /></td>
                  <td>{m.items_verified}</td>
                  <td>{m.median_hours_to_verify ?? '—'}</td>
                  <td>{orNotYours(m.interviews_completed)}</td>
                  <td>{orNotYours(m.tests_handed_in)}</td>
                </tr>
              ))}
            </DataTable>
          )}
          <p className="muted">
            Months are calendar months in UTC; the first one is the current month, which is not over yet. Every number counts only what this card may
            read: documents and items, interviews, and tests each by its own right.
          </p>
          {a.months.length > 0 && (
            <p><Button onClick={() => saveAsFile('legacyai-activity.csv', 'text/csv', activityCsv(a.months))}>Save these numbers as a file (CSV)</Button></p>
          )}

          <h2>Readiness tests by job role</h2>
          <JobRoleResults table={a.job_role_results} />
        </div>
      )}
    </Page>
  );
}

function JobRoleResults({ table }: { table: KActivityJobRoleResults }) {
  if (table.state === 'not_allowed') {
    return <Empty>This card may not read the test results of the whole company, so no table is shown.</Empty>;
  }
  return (
    <div>
      {table.rows.length === 0 ? <Empty>No graded test in this time.</Empty> : (
        <DataTable caption="Readiness tests by job role" columns={['Job role', 'People', 'Graded tests', 'Mean score']}>
          {table.rows.map((j) => <JobRoleRow key={j.job_role} row={j} minimum={table.minimum_group} />)}
        </DataTable>
      )}
      <p className="muted">
        Tests graded from {dayText(table.window_start)} up to, not including, {dayText(table.window_end)}: always the twelve complete months before the
        current one. Numbers for a job role are shown only when at least {table.minimum_group} different people took a graded test in that time, so
        that nobody’s own result can be read from this table. The mean score is rounded and is not a pass mark.
        {table.truncated ? ` Only the first ${table.max_rows} job roles are listed.` : ''}
      </p>
    </div>
  );
}

function JobRoleRow({ row, minimum }: { row: KActivityJobRole; minimum: number }) {
  if (row.state === 'too_few_people') {
    return <tr><td>{row.job_role}</td><td colSpan={3}>Too few people to show (fewer than {minimum})</td></tr>;
  }
  return (
    <tr>
      <td>{row.job_role}</td>
      <td>{row.people}</td>
      <td>{row.attempts}</td>
      <td>{row.state === 'no_graded_answers' || row.mean_score === null ? 'No graded answers yet' : `${Math.round(row.mean_score * 100)} %`}</td>
    </tr>
  );
}
