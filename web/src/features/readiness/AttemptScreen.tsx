// One test. While it runs: the questions, answers saved as the learner goes, then handing in.
// Afterwards: what was answered and how it was graded. While the test runs NOTHING about the right
// answers is drawn, whatever the API sends.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import type { KAttempt } from '../../api/generated.ts';
import { ScreenLink } from '../../navigation/ScreenLink.tsx';
import { useSession } from '../../session/session.tsx';
import { Badge, Banner, Button, Card, ConfirmButton, ErrorNote, Facts, formatDate, Loading, Page, TextArea } from '../../ui/index.tsx';
import { ATTEMPT_STATUS_TEXT, attemptTone, isFinishedAttempt, percent, useAttempt, useOverrideAnswer, useSaveAnswer, useSubmitAttempt } from './hooks.ts';

type Question = KAttempt['questions'][number];
/** What the view of a RUNNING test may see of a question: nothing about the right answer or the grading. */
type RunningQuestion = Omit<Question, 'correct_option' | 'final_score' | 'decided_by'>;

export function AttemptScreen() {
  const { attemptId = '' } = useParams();
  const { state, can } = useSession();
  const attempt = useAttempt(attemptId);
  const submit = useSubmitAttempt();
  const data = attempt.data;
  const myPerson = state.status === 'signed_in' ? state.session.person_id : null;
  const taking = data !== undefined && data.status === 'in_progress' && data.learner_person_id === myPerson && can('saveAttemptAnswer');
  // Questions whose answer is not saved yet, as each question reports it (see AnswerQuestion). Handing in cannot be
  // undone, so it waits for them.
  const [unsaved, setUnsaved] = useState<ReadonlySet<number>>(new Set());
  const markUnsaved = useCallback((position: number, dirty: boolean): void => {
    setUnsaved((before) => {
      if (before.has(position) === dirty) return before;
      const next = new Set(before);
      if (dirty) next.add(position); else next.delete(position);
      return next;
    });
  }, []);
  const waitingFor = [...unsaved].sort((a, b) => a - b);
  return (
    <Page title="Readiness test">
      {attempt.isPending && <Loading what="the test" />}
      <ErrorNote error={attempt.error ?? submit.error} />
      {data !== undefined && (
        <>
          <Card>
            <Facts items={[
              ['Job role', data.job_role],
              ['State', <Badge key="s" tone={attemptTone(data.status)}>{ATTEMPT_STATUS_TEXT[data.status] ?? data.status}</Badge>],
              [data.status === 'in_progress' ? 'Hand in before' : 'Handed in', formatDate(data.status === 'in_progress' ? data.expires_at : data.submitted_at)],
              ['Reference', <span key="r" className="code">{data.id}</span>],
            ]} />
          </Card>
          {taking ? (
            <>
              {data.questions.map((q) => <AnswerQuestion key={q.position} attemptId={data.id} question={q} total={data.questions.length} onUnsaved={markUnsaved} />)}
              <Card title="Hand in">
                <p>After handing in you cannot change your answers.</p>
                {waitingFor.length > 0 && (
                  <Banner tone="warning" title="An answer is not saved yet">
                    Question {waitingFor.join(', ')}: save what you typed, or choose the option again. Handing in would otherwise leave it out.
                  </Banner>
                )}
                <ConfirmButton resetKey={null} variant="primary" label="Hand in the test" confirmLabel="Yes, hand it in" busy={submit.isPending} disabled={waitingFor.length > 0}
                  onConfirm={() => submit.mutate({ path: { attempt_id: data.id } })} />
              </Card>
            </>
          ) : (
            <>
              {!isFinishedAttempt(data.status) && <Banner tone="info" title="This test is still running">Answers are shown once it has been handed in.</Banner>}
              {isFinishedAttempt(data.status) && (
                <>
                  {can('getReadinessReport') && <p><ScreenLink screen="report" id={data.id}>Open the report for this test</ScreenLink></p>}
                  {data.questions.map((q) => <GradedQuestion key={q.position} question={q} />)}
                </>
              )}
            </>
          )}
        </>
      )}
    </Page>
  );
}

/**
 * One question of a running test. This component is the ONLY place that knows whether its answer is saved; it
 * tells the screen through `onUnsaved` from one effect, so the two cannot disagree.
 *  - Open question: typed text that differs from the saved text is unsaved. An EMPTY field is not: the answer saved
 *    earlier is kept (the API does not store an empty answer), so clearing the field never blocks handing in.
 *  - Multiple choice: the chosen option is unsaved until the API confirmed that very option (pending or failed = unsaved).
 */
function AnswerQuestion({ attemptId, question, total, onUnsaved }: {
  attemptId: string; question: RunningQuestion; total: number; onUnsaved: (position: number, dirty: boolean) => void;
}) {
  const save = useSaveAnswer();
  const [text, setText] = useState(question.answer_text ?? '');
  const [savedText, setSavedText] = useState((question.answer_text ?? '').trim());
  const [chosen, setChosen] = useState<number | null>(question.chosen_option);
  const [savedChoice, setSavedChoice] = useState<number | null>(question.chosen_option);
  const sending = useRef(false);
  const typed = text.trim();
  const isChoice = question.kind === 'mcq' && question.options !== null;
  const textUnsaved = typed !== '' && typed !== savedText;
  const choiceUnsaved = chosen !== savedChoice;
  const unsaved = isChoice ? choiceUnsaved : textUnsaved;
  const { position } = question;
  useEffect(() => {
    onUnsaved(position, unsaved);
    return () => onUnsaved(position, false);
  }, [onUnsaved, position, unsaved]);

  const choose = (index: number): void => {
    setChosen(index);
    save.mutate({ path: { attempt_id: attemptId }, body: { position, chosen_option: index } }, { onSuccess: () => setSavedChoice(index) });
  };
  /** Saves what is typed. Called by the button and when the field is left, so an answer is not lost by forgetting the button. */
  const saveText = (): void => {
    // The ref (not the mutation's state) stops a second send: leaving the field and clicking the button happen in the
    // same moment, before the screen has drawn "saving".
    if (!textUnsaved || sending.current) return;
    const sent = typed;
    sending.current = true;
    // Only what was SENT counts as saved: text typed while the save was under way stays unsaved.
    save.mutate({ path: { attempt_id: attemptId }, body: { position, answer_text: sent } }, {
      onSuccess: () => setSavedText(sent),
      onSettled: () => { sending.current = false; },
    });
  };
  return (
    <Card title={`Question ${position} of ${total}`}>
      {isChoice ? (
        <fieldset>
          <legend>{question.stem}</legend>
          {(question.options ?? []).map((option, index) => (
            <label key={option} className="choice">
              <input type="radio" name={`q${position}`} checked={chosen === index} onChange={() => choose(index)} />
              <span>{option}</span>
            </label>
          ))}
          {!choiceUnsaved && savedChoice !== null && <p className="muted" role="status">Saved.</p>}
          {choiceUnsaved && <p className="muted" role="status">{save.isPending ? 'Saving…' : 'Your choice was not saved. Choose it again.'}</p>}
        </fieldset>
      ) : (
        <>
          <TextArea label={question.stem} rows={4} maxLength={4000} value={text} onChange={(e) => setText(e.target.value)} onBlur={saveText} />
          <div className="row">
            <Button busy={save.isPending} disabled={!textUnsaved} onClick={saveText}>Save this answer</Button>
            {typed === '' && savedText !== '' && <Button onClick={() => setText(savedText)}>Show the saved answer again</Button>}
          </div>
          {typed !== '' && !textUnsaved && <p className="muted" role="status">Saved.</p>}
          {textUnsaved && <p className="muted" role="status">Not saved yet.</p>}
          {typed === '' && savedText !== '' && <p className="muted" role="status">The answer you saved earlier is kept. Type a new one and save it to replace it.</p>}
        </>
      )}
      <ErrorNote error={save.error} />
    </Card>
  );
}

function GradedQuestion({ question }: { question: Question }) {
  const { can } = useSession();
  const override = useOverrideAnswer();
  const [score, setScore] = useState('');
  const given = question.kind === 'mcq' && question.options !== null
    ? (question.chosen_option === null ? null : question.options[question.chosen_option] ?? null)
    : question.answer_text;
  return (
    <Card title={`Question ${question.position}`}>
      <p>{question.stem}</p>
      <Facts items={[
        ['Answer given', given ?? 'No answer'],
        ...(question.correct_option !== undefined && question.options !== null ? [['Right answer', question.options[question.correct_option] ?? '—'] as const] : []),
        ['Score', question.final_score === null ? 'Waiting to be graded by a person' : percent(question.final_score)],
        ['Graded by', question.decided_by === null ? '—' : question.decided_by === 'ai' ? 'AI, against the rubric' : question.decided_by === 'reviewer' ? 'A reviewer' : 'The answer key'],
      ]} />
      {can('overrideQuizAnswer') && (
        <div className="row">
          <label>New score <select className="input" value={score} onChange={(e) => setScore(e.target.value)}>
            <option value="">Choose a score…</option>
            <option value="1">Right (100 %)</option>
            <option value="0.5">Half right (50 %)</option>
            <option value="0">Wrong (0 %)</option>
          </select></label>
          <ConfirmButton variant="primary" label="Set the score" confirmLabel="Yes, change the score" busy={override.isPending} disabled={score === ''} resetKey={score}
            onConfirm={() => override.mutate({ path: { answer_id: question.answer_id }, body: { score: Number(score) } }, { onSuccess: () => setScore('') })} />
          {override.isSuccess && <span className="muted" role="status">Score changed.</span>}
        </div>
      )}
      <ErrorNote error={override.error} />
    </Card>
  );
}
