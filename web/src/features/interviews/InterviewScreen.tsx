// One interview: start it, answer the question that is waiting, pause, go on, finish.
import { useState, type FormEvent } from 'react';
import { useParams } from 'react-router';
import { ApiError } from '../../api/client.ts';
import { ScreenLink } from '../../navigation/ScreenLink.tsx';
import { useSession } from '../../session/session.tsx';
import { Badge, Banner, Button, Card, ConfirmButton, ErrorNote, Facts, formatDate, Loading, Page, TextArea } from '../../ui/index.tsx';
import {
  INTERVIEW_STATUS_TEXT, interviewTone, openQuestion, useAcceptInterview, useAnswerTurn, useCompleteInterview, useInterview, usePauseInterview, useResumeInterview,
} from './hooks.ts';

const CONSENT_NEEDED = 'This interview needs your consent for “My own words”. Give it on the “My consent” screen, then come back.';

export function InterviewScreen() {
  const { interviewId = '' } = useParams();
  const { state, can } = useSession();
  const interview = useInterview(interviewId);
  const accept = useAcceptInterview();
  const answer = useAnswerTurn();
  const pause = usePauseInterview();
  const resume = useResumeInterview();
  const complete = useCompleteInterview();
  const [text, setText] = useState('');
  const data = interview.data;
  const myPerson = state.status === 'signed_in' ? state.session.person_id : null;
  // Only the invited expert takes part; everybody else who may open it only reads.
  const mine = data !== undefined && myPerson !== null && data.expert_person_id === myPerson && can('acceptInterview');
  const busy = accept.isPending || answer.isPending || pause.isPending || resume.isPending || complete.isPending;
  const problem = accept.error ?? answer.error ?? pause.error ?? resume.error ?? complete.error;
  // The API has no code of its own for this: it answers 422 with exactly the title "consent missing" (the AI
  // service's reason, see knowledge-gateway/internal/client.ts). The exact title is matched, not any mention of consent.
  const consentMissing = problem instanceof ApiError && problem.status === 422 && problem.message.trim().toLowerCase() === 'consent missing';
  const question = data !== undefined ? openQuestion(data) : null;
  const path = { interview_id: interviewId };

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    answer.mutate({ path, body: { answer: text.trim() } }, { onSuccess: () => setText('') });
  };

  return (
    <Page title="Interview" actions={<ScreenLink screen="interviews">All interviews</ScreenLink>}>
      {interview.isPending && <Loading what="the interview" />}
      <ErrorNote error={interview.error} />
      {data !== undefined && (
        <>
          <Card>
            <Facts items={[
              ['Job role', data.job_role],
              ['State', <Badge key="s" tone={interviewTone(data.status)}>{INTERVIEW_STATUS_TEXT[data.status] ?? data.status}</Badge>],
              ['Questions answered', `${data.turn_count} of at most ${data.max_turns}`],
              ['Invited', formatDate(data.created_at)],
            ]} />
          </Card>
          <ErrorNote error={problem} />
          {consentMissing && <Banner tone="warning" title="Your consent is needed first"><p>{CONSENT_NEEDED}</p><ScreenLink screen="consent">Open my consent</ScreenLink></Banner>}
          {answer.data?.candidate_item_id && <Banner tone="success" title="Your answer was saved as a draft knowledge item">A second person checks it before it counts as verified.</Banner>}

          {mine && data.status === 'invited' && (
            <Card title="Start the interview">
              <p>You will be asked one question at a time. You can pause and come back later. Personal details in your answers are blanked out before they are stored.</p>
              <p className="muted">{CONSENT_NEEDED.replace('This interview needs', 'It needs')}</p>
              <Button variant="primary" busy={busy} onClick={() => accept.mutate({ path })}>Start</Button>
            </Card>
          )}
          {mine && data.status === 'active' && (
            <Card title="The question for you">
              {question === null ? <p className="muted">There is no open question. You can finish the interview.</p> : (
                <form onSubmit={onSubmit} noValidate>
                  <p className="question" data-testid="interview-question">{question}</p>
                  <TextArea label="Your answer" hint="In your own words. Short is fine." rows={5} maxLength={4000} value={text} onChange={(e) => setText(e.target.value)} />
                  <Button type="submit" variant="primary" busy={busy} disabled={text.trim() === ''}>Send my answer</Button>
                </form>
              )}
              <div className="row">
                <Button busy={busy} onClick={() => pause.mutate({ path })}>Pause</Button>
                <ConfirmButton variant="primary" label="Finish the interview" confirmLabel="Yes, finish it" busy={busy} onConfirm={() => complete.mutate({ path })} />
              </div>
            </Card>
          )}
          {mine && (data.status === 'paused' || data.status === 'stopped_budget') && (
            <Card title={data.status === 'paused' ? 'The interview is paused' : 'The interview was stopped'}>
              <p>Your answers so far are kept.</p>
              <Button variant="primary" busy={busy} onClick={() => resume.mutate({ path })}>Go on</Button>
            </Card>
          )}

          <h2>Questions and answers so far</h2>
          {data.turns.filter((t) => t.answer !== null || t.erased).length === 0 ? <p className="muted">Nothing has been answered yet.</p> : (
            <ol>
              {data.turns.filter((t) => t.answer !== null || t.erased).map((t) => (
                <li key={t.ordinal}>
                  <p><strong>{t.erased ? 'Erased' : t.question}</strong></p>
                  <p className="prose">{t.erased ? 'This answer was erased after consent was withdrawn.' : t.answer}</p>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </Page>
  );
}
