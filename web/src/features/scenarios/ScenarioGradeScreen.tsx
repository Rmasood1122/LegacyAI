// Grading ONE step of a handed-in scenario run. Nobody grades blind: the grader reads the question, the learner's
// words and the expected points here, and sets the score here. Reached from the review task about that step.
import { useParams } from 'react-router';
import { useSession } from '../../session/session.tsx';
import { ScoreOverride } from '../../ui/answers.tsx';
import { Banner, Card, ErrorNote, Facts, Loading, Page } from '../../ui/index.tsx';
import { DETAILS_REMOVED_TEXT, percent, useOverrideStep, useStepForGrading, WRITE_REFUSALS } from './hooks.ts';

const DECIDED_BY: Readonly<Record<string, string>> = { ai: 'AI, against the expected points', reviewer: 'A reviewer', auto: 'No answer was given' };

export function ScenarioGradeScreen() {
  const { answerId = '' } = useParams();
  const { can } = useSession();
  const step = useStepForGrading(answerId);
  const override = useOverrideStep();
  const readRefusal = step.error !== null && step.error.code !== null ? WRITE_REFUSALS[step.error.code] : undefined;
  const writeRefusal = override.error !== null && override.error.code !== null ? WRITE_REFUSALS[override.error.code] : undefined;
  const data = step.data;
  return (
    <Page title="Grade one step" intro="A step of a scenario that a learner handed in. Read the answer against the expected points, then set the score.">
      {step.isPending && <Loading what="the step" />}
      {readRefusal !== undefined ? <Banner tone="danger" title="Not possible">{readRefusal}</Banner> : <ErrorNote error={step.error} />}
      {data !== undefined && (
        <>
          <Card title={`${data.scenario_title || 'Scenario'} — step ${data.position}`}>
            <p>{data.prompt === '' ? 'The text of this step was erased.' : data.prompt}</p>
            <Facts items={[
              ['Answer given', data.details_removed ? DETAILS_REMOVED_TEXT : data.answer_text ?? 'No answer'],
              ['Score', data.final_score === null ? 'Waiting to be graded by a person' : percent(data.final_score)],
              ['Graded by', data.decided_by === null ? '—' : DECIDED_BY[data.decided_by] ?? data.decided_by],
              ['What the AI made of it', data.ai_score === null ? 'It gave no score' : `${percent(data.ai_score)}${data.ai_confidence === null ? '' : ` (how sure it was: ${percent(data.ai_confidence)})`}`],
            ]} />
            <h3>Expected points</h3>
            {data.points.length === 0 ? <p className="muted">None are stored for this step.</p> : (
              <ul>
                {data.points.map((p) => <li key={p.text}>{p.text}{p.met === true ? ' — found in the answer' : p.met === false ? ' — not found in the answer' : ''}</li>)}
              </ul>
            )}
          </Card>
          {can('overrideScenarioAnswer') && (
            <Card title="Set the score">
              <ScoreOverride busy={override.isPending} changed={override.isSuccess}
                onSet={(score, done) => override.mutate({ path: { scenario_answer_id: data.id }, body: { score } }, { onSuccess: done })} />
              {writeRefusal !== undefined ? <Banner tone="danger" title="Not possible">{writeRefusal}</Banner> : <ErrorNote error={override.error} />}
            </Card>
          )}
        </>
      )}
    </Page>
  );
}
