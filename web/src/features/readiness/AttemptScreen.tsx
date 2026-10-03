// One test. While it runs: the questions, answers saved as the learner goes, then handing in.
// Afterwards: what was answered and how it was graded. While the test runs NOTHING about the right
// answers is drawn, whatever the API sends.
import { useState } from 'react';
import { useParams } from 'react-router';
import type { KAttempt } from '../../api/generated.ts';
import { ScreenLink } from '../../navigation/ScreenLink.tsx';
import { useSession } from '../../session/session.tsx';
import { Badge, Banner, Button, Card, ConfirmButton, ErrorNote, Facts, formatDate, Loading, Page, TextArea } from '../../ui/index.tsx';
import { ATTEMPT_STATUS_TEXT, attemptTone, percent, useAttempt, useOverrideAnswer, useSaveAnswer, useSubmitAttempt } from './hooks.ts';

type Question = KAttempt['questions'][number];

export function AttemptScreen() {
  const { attemptId = '' } = useParams();
  const { state, can } = useSession();
  const attempt = useAttempt(attemptId);
  const submit = useSubmitAttempt();
  const data = attempt.data;
  const myPerson = state.status === 'signed_in' ? state.session.person_id : null;
  const taking = data !== undefined && data.status === 'in_progress' && data.learner_person_id === myPerson && can('saveAttemptAnswer');
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
              {data.questions.map((q) => <AnswerQuestion key={q.position} attemptId={data.id} question={q} total={data.questions.length} />)}
              <Card title="Hand in">
                <p>After handing in you cannot change your answers.</p>
                <ConfirmButton variant="primary" label="Hand in the test" confirmLabel="Yes, hand it in" busy={submit.isPending} onConfirm={() => submit.mutate({ path: { attempt_id: data.id } })} />
              </Card>
            </>
          ) : (
            <>
              {data.status === 'in_progress' && <Banner tone="info" title="This test is still running">Answers are shown once it has been handed in.</Banner>}
              {data.status !== 'in_progress' && (
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

function AnswerQuestion({ attemptId, question, total }: { attemptId: string; question: Question; total: number }) {
  const save = useSaveAnswer();
  const [text, setText] = useState(question.answer_text ?? '');
  const [chosen, setChosen] = useState<number | null>(question.chosen_option);
  const choose = (index: number): void => {
    setChosen(index);
    save.mutate({ path: { attempt_id: attemptId }, body: { position: question.position, chosen_option: index } });
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
        </fieldset>
      ) : (
        <>
          <TextArea label={question.stem} rows={4} maxLength={4000} value={text} onChange={(e) => setText(e.target.value)} />
          <Button busy={save.isPending} disabled={text.trim() === ''}
            onClick={() => save.mutate({ path: { attempt_id: attemptId }, body: { position: question.position, answer_text: text.trim() } })}>
            Save this answer
          </Button>
        </>
      )}
      <ErrorNote error={save.error} />
      {save.isSuccess && <p className="muted" role="status">Saved.</p>}
    </Card>
  );
}

function GradedQuestion({ question }: { question: Question }) {
  const { can } = useSession();
  const override = useOverrideAnswer();
  const [score, setScore] = useState('1');
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
            <option value="1">Right (100 %)</option>
            <option value="0.5">Half right (50 %)</option>
            <option value="0">Wrong (0 %)</option>
          </select></label>
          <Button busy={override.isPending} onClick={() => override.mutate({ path: { answer_id: question.answer_id }, body: { score: Number(score) } })}>Set the score</Button>
          {override.isSuccess && <span className="muted" role="status">Score changed.</span>}
        </div>
      )}
      <ErrorNote error={override.error} />
    </Card>
  );
}
