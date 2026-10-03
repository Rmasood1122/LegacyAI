// The report of one test: per topic what was scored, how it was graded, and where the material
// itself has gaps. The statement at the top comes from the service, word for word.
import { useParams } from 'react-router';
import { ScreenLink } from '../../navigation/ScreenLink.tsx';
import { Badge, Banner, Card, DataTable, Empty, ErrorNote, Facts, formatDate, Loading, Page } from '../../ui/index.tsx';
import { ATTEMPT_STATUS_TEXT, attemptTone, percent, useReport } from './hooks.ts';

const GAP_TEXT: Readonly<Record<string, string>> = {
  'no released verified knowledge': 'There is no verified knowledge for learners on this topic yet.',
  'knowledge but no approved questions': 'There is knowledge, but no approved test questions.',
  'too few questions to score': 'There are too few questions to give a score.',
};

export function ReportScreen() {
  const { attemptId = '' } = useParams();
  const report = useReport(attemptId);
  const data = report.data;
  return (
    <Page title="Readiness report" actions={<ScreenLink screen="attempt" id={attemptId}>See the answers</ScreenLink>}>
      {report.isPending && <Loading what="the report" />}
      <ErrorNote error={report.error} />
      {data !== undefined && (
        <>
          <Banner tone="info" title="What this report is">{data.statement}</Banner>
          <Card>
            <Facts items={[
              ['Job role', data.job_role],
              ['State', <Badge key="s" tone={attemptTone(data.status)}>{ATTEMPT_STATUS_TEXT[data.status] ?? data.status}</Badge>],
              ['Started', formatDate(data.started_at)],
              ['Handed in', formatDate(data.submitted_at)],
              ['Approved questions for this role', String(data.bank_size)],
              ['Reference', <span key="r" className="code">{data.attempt_id}</span>],
            ]} />
          </Card>
          <h2>By topic</h2>
          {data.topics.length === 0 ? <Empty>No topics are set for this job role.</Empty> : (
            <DataTable caption="Scores by topic" columns={['Topic', 'Score', 'Questions asked', 'Graded by AI', 'Graded by a person']}>
              {data.topics.map((t) => (
                <tr key={t.topic_id}>
                  <td>{t.name}</td>
                  <td>{t.score === null ? <span className="muted">No score — {t.note ?? 'not available'}</span> : percent(t.score)}</td>
                  <td>{t.questions_asked} of {t.questions_in_bank} in the bank</td>
                  <td>{t.ai_graded}</td>
                  <td>{t.person_graded}</td>
                </tr>
              ))}
            </DataTable>
          )}
          <h2>Where the material is thin</h2>
          {data.coverage_gaps.length === 0 ? <p className="muted">No gaps were found in the material for this job role.</p> : (
            <ul>{data.coverage_gaps.map((g) => <li key={g.topic_id}><strong>{g.name}:</strong> {GAP_TEXT[g.gap] ?? g.gap}</li>)}</ul>
          )}
        </>
      )}
    </Page>
  );
}
