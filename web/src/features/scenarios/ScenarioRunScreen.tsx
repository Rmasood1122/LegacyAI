// One run of a scenario. While it runs: the situation and one step at a time, each answer saved as the learner
// goes, then handing in. Afterwards: what was answered and how it was graded. While the run is in progress NOTHING
// about the expected points or scores is drawn, whatever the API sends (see RunningStep in hooks.ts).
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import type { KScenarioAttemptStep } from '../../api/generated.ts';
import { ScreenLink } from '../../navigation/ScreenLink.tsx';
import { useSession } from '../../session/session.tsx';
import { ScoreOverride, useUnsavedPositions } from '../../ui/answers.tsx';
import { Badge, Banner, Button, Card, ConfirmButton, ErrorNote, Facts, formatDate, Loading, Page, TextArea } from '../../ui/index.tsx';
import { DETAILS_REMOVED_TEXT, isFinishedRun, percent, RUN_STATUS_TEXT, runTone, useOverrideStep, useRun, useSaveStepAnswer, useSubmitRun, WRITE_REFUSALS, type RunningStep } from './hooks.ts';

export function ScenarioRunScreen() {
  const { attemptId = '' } = useParams();
  const { state, can } = useSession();
  const run = useRun(attemptId);
  const submit = useSubmitRun();
  const data = run.data;
  const myPerson = state.status === 'signed_in' ? state.session.person_id : null;
  const mine = data !== undefined && data.learner_person_id === myPerson;
  const taking = data !== undefined && data.status === 'in_progress' && mine && can('saveScenarioAnswer');
  const [current, setCurrent] = useState(0);
  // Steps whose typed answer is not saved yet, as each step reports it. Handing in cannot be undone, so it waits.
  const { waitingFor, markUnsaved } = useUnsavedPositions();
  return (
    <Page title={data?.title ?? 'Scenario'}>
      {run.isPending && <Loading what="the scenario" />}
      <ErrorNote error={run.error ?? submit.error} />
      {data !== undefined && (
        <>
          <Card title="The situation">
            <p>{data.situation === '' ? 'The text of this scenario was erased.' : data.situation}</p>
            <Facts items={[
              ['For', data.job_role],
              ['State', <Badge key="s" tone={runTone(data.status)}>{RUN_STATUS_TEXT[data.status] ?? data.status}</Badge>],
              [data.status === 'in_progress' ? 'Hand in before' : 'Handed in', formatDate(data.status === 'in_progress' ? data.expires_at : data.submitted_at)],
            ]} />
          </Card>
          {taking ? (
            <>
              {/* every step stays mounted, so what was typed in one is not lost by looking at another */}
              {data.steps.map((s, index) => (
                <div key={s.position} hidden={index !== current}>
                  <AnswerStep attemptId={data.id} step={s} total={data.steps.length} onUnsaved={markUnsaved} />
                </div>
              ))}
              <div className="row">
                <Button disabled={current === 0} onClick={() => setCurrent((c) => Math.max(0, c - 1))}>Previous step</Button>
                <Button disabled={current >= data.steps.length - 1} onClick={() => setCurrent((c) => Math.min(data.steps.length - 1, c + 1))}>Next step</Button>
              </div>
              <Card title="Hand in">
                <p>After handing in you cannot change your answers. A step left empty counts as not answered.</p>
                {waitingFor.length > 0 && (
                  <Banner tone="warning" title="An answer is not saved yet">Step {waitingFor.join(', ')}: save what you typed. Handing in would otherwise leave it out.</Banner>
                )}
                <ConfirmButton resetKey={null} variant="primary" label="Hand in" confirmLabel="Yes, hand it in" busy={submit.isPending} disabled={waitingFor.length > 0}
                  onConfirm={() => submit.mutate({ path: { scenario_attempt_id: data.id } })} />
              </Card>
            </>
          ) : (
            <>
              {!isFinishedRun(data.status) && <Banner tone="info" title="This run is still in progress">Answers and scores are shown once it has been handed in.</Banner>}
              {isFinishedRun(data.status) && data.steps.map((s) => <GradedStep key={s.position} step={s} ownRun={mine} runStatus={data.status} />)}
            </>
          )}
        </>
      )}
    </Page>
  );
}

/**
 * One step of a running scenario. This component is the only place that knows whether its answer is saved; it tells
 * the screen through `onUnsaved`. Typed text that differs from the saved text is unsaved; an EMPTY field is not (the
 * answer saved earlier is kept), so clearing the field never blocks handing in.
 */
function AnswerStep({ attemptId, step, total, onUnsaved }: { attemptId: string; step: RunningStep; total: number; onUnsaved: (position: number, dirty: boolean) => void }) {
  const save = useSaveStepAnswer();
  const [text, setText] = useState(step.answer_text ?? '');
  const [savedText, setSavedText] = useState((step.answer_text ?? '').trim());
  const sending = useRef(false);
  const typed = text.trim();
  const unsaved = typed !== '' && typed !== savedText;
  const { position } = step;
  useEffect(() => {
    onUnsaved(position, unsaved);
    return () => onUnsaved(position, false);
  }, [onUnsaved, position, unsaved]);
  /** Called by the button and when the field is left, so an answer is not lost by forgetting the button. */
  const saveText = (): void => {
    if (!unsaved || sending.current) return;       // the ref stops a second send when leaving the field and clicking coincide
    const sent = typed;
    sending.current = true;
    // only what was SENT counts as saved: text typed while the save was under way stays unsaved
    save.mutate({ path: { scenario_attempt_id: attemptId }, body: { position, answer_text: sent } }, {
      onSuccess: () => setSavedText(sent),
      onSettled: () => { sending.current = false; },
    });
  };
  return (
    <Card title={`Step ${position} of ${total}`}>
      <TextArea label={step.prompt} rows={5} maxLength={4000} value={text} onChange={(e) => setText(e.target.value)} onBlur={saveText} />
      <div className="row">
        <Button busy={save.isPending} disabled={!unsaved} onClick={saveText}>Save this answer</Button>
        {typed === '' && savedText !== '' && <Button onClick={() => setText(savedText)}>Show the saved answer again</Button>}
      </div>
      {typed !== '' && !unsaved && <p className="muted" role="status">Saved.</p>}
      {unsaved && <p className="muted" role="status">Not saved yet.</p>}
      {typed === '' && savedText !== '' && <p className="muted" role="status">The answer you saved earlier is kept. Type a new one and save it to replace it.</p>}
      <ErrorNote error={save.error} />
    </Card>
  );
}

const DECIDED_BY: Readonly<Record<string, string>> = { ai: 'AI, against the expected points', reviewer: 'A reviewer', auto: 'No answer was given' };

/** What stands where the score would be, for a run that is over but not graded: nothing about scores is sent for it. */
const NO_SCORE_YET: Readonly<Record<string, string>> = {
  submitted: 'Shown once every step is graded. A step is waiting for a person.',
  expired: 'Not graded: the run ended before it was handed in.',
};

function GradedStep({ step, ownRun, runStatus }: { step: KScenarioAttemptStep; ownRun: boolean; runStatus: string }) {
  const { can } = useSession();
  const override = useOverrideStep();
  const refusal = override.error !== null && override.error.code !== null ? WRITE_REFUSALS[override.error.code] : undefined;
  return (
    <Card title={`Step ${step.position}`}>
      <p>{step.prompt === '' ? 'The text of this step was erased.' : step.prompt}</p>
      <Facts items={[
        ['Answer given', step.details_removed === true ? DETAILS_REMOVED_TEXT : step.answer_text ?? 'No answer'],
        ['Score', runStatus !== 'graded' ? NO_SCORE_YET[runStatus] ?? 'Not available yet.'
          : step.final_score === null || step.final_score === undefined ? 'Waiting to be graded by a person' : percent(step.final_score)],
        ['Graded by', step.decided_by === null || step.decided_by === undefined ? '—' : DECIDED_BY[step.decided_by] ?? step.decided_by],
      ]} />
      {step.graded_with_low_confidence === true && <p className="muted">The AI was unsure about this step. A reviewer can change the score.</p>}
      {step.points !== undefined && (
        <>
          <h3>Expected points</h3>
          <ul>
            {step.points.map((p) => <li key={p.text}>{p.text}{p.met === true ? ' — found in the answer' : p.met === false ? ' — not found in the answer' : ''}</li>)}
          </ul>
        </>
      )}
      {step.read_these !== undefined && step.read_these.length > 0 && (
        <>
          <h3>Read this again</h3>
          <ul>
            {step.read_these.map((i) => <li key={i.id}><ScreenLink screen="knowledgeItem" id={i.id}>{i.title || 'Untitled'}</ScreenLink></li>)}
          </ul>
        </>
      )}
      {runStatus === 'submitted' && !ownRun && (
        <p><ScreenLink screen="scenarioGrade" id={step.answer_id}>Read this step and set its score</ScreenLink></p>
      )}
      {can('overrideScenarioAnswer') && !ownRun && runStatus === 'graded' && (
        <ScoreOverride busy={override.isPending} changed={override.isSuccess}
          onSet={(score, done) => override.mutate({ path: { scenario_answer_id: step.answer_id }, body: { score } }, { onSuccess: done })} />
      )}
      {refusal !== undefined ? <Banner tone="danger" title="Not possible">{refusal}</Banner> : <ErrorNote error={override.error} />}
    </Card>
  );
}
