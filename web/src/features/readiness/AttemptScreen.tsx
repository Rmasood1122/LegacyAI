// One test. While it runs: the questions, answers saved as the learner goes, then handing in.
// Afterwards: what was answered and how it was graded. While the test runs NOTHING about the right
// answers is drawn, whatever the API sends.
import { useCallback, useState } from 'react';
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
  // Questions whose typed answer is not saved yet. Handing in cannot be undone, so it waits for them.
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
                  <Banner tone="warning" title="A typed answer is not saved yet">
                    Save the answer to question {waitingFor.join(', ')} first (or clear what you typed). Handing in would otherwise leave it out.
                  </Banner>
                )}
                <ConfirmButton variant="primary" label="Hand in the test" confirmLabel="Yes, hand it in" busy={submit.isPending} disabled={waitingFor.length > 0}
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

function AnswerQuestion({ attemptId, question, total, onUnsaved }: {
  attemptId: string; question: RunningQuestion; total: number; onUnsaved: (position: number, dirty: boolean) => void;
}) {
  const save = useSaveAnswer();
  const [text, setText] = useState(question.answer_text ?? '');
  const [savedText, setSavedText] = useState((question.answer_text ?? '').trim());
  const [chosen, setChosen] = useState<number | null>(question.chosen_option);
  const typed = text.trim();
  const dirty = typed !== savedText;
  const change = (value: string): void => {
    setText(value);
    onUnsaved(question.position, value.trim() !== savedText);
  };
  const choose = (index: number): void => {
    setChosen(index);
    save.mutate({ path: { attempt_id: attemptId }, body: { position: question.position, chosen_option: index } });
  };
  /** Saves what is typed. Called by the button and when the field is left, so an answer is not lost by forgetting the button. */
  const saveText = (): void => {
    if (!dirty || typed === '' || save.isPending) return;
    save.mutate({ path: { attempt_id: attemptId }, body: { position: question.position, answer_text: typed } }, {
      onSuccess: () => {
        setSavedText(typed);
        onUnsaved(question.position, false);
      },
    });
  };
  return (
    <Card title={`Question ${question.position} of ${total}`}>
      {question.kind === 'mcq' && question.options !== null ? (
        <fieldset>
          <legend>{question.stem}</legend>
          {question.options.map((option, index) => (
            <label key={option} className="choice">
              <input type="radio" name={`q${question.position}`} checked={chosen === index} onChange={() => choose(index)} />
              <span>{option}</span>
            </label>
          ))}
          {save.isSuccess && <p className="muted" role="status">Saved.</p>}
        </fieldset>
      ) : (
        <>
          <TextArea label={question.stem} rows={4} maxLength={4000} value={text} onChange={(e) => change(e.target.value)} onBlur={saveText} />
          <Button busy={save.isPending} disabled={!dirty || typed === ''} onClick={saveText}>Save this answer</Button>
          {!dirty && savedText !== '' && <p className="muted" role="status">Saved.</p>}
          {dirty && <p className="muted" role="status">{typed === '' ? 'The answer saved earlier is still stored; type an answer and save it to replace it.' : 'Not saved yet.'}</p>}
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
