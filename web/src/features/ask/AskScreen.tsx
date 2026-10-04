// Ask: a question box, and an answer that shows where it comes from - or a plain "I don't know".
import { useState, type FormEvent } from 'react';
import { useActivePeople, useApiMutation } from '../../api/context.tsx';
import type { KAnswer, KCitation, KConflictSide, KFeedbackVerdict } from '../../api/generated.ts';
import { ScreenLink } from '../../navigation/ScreenLink.tsx';
import { useSession } from '../../session/session.tsx';
import { Badge, Banner, Button, Card, CheckboxField, ErrorNote, humanize, Page, PartialListNote, SelectField, TextArea } from '../../ui/index.tsx';
import { useAsk, useMyFeedback, usePutFeedback, useWithdrawFeedback, VALUE_CHECK_LIMITS } from './hooks.ts';

const DONT_KNOW_REASONS: Readonly<Record<string, string>> = {
  no_relevant_sources: 'Nothing you are allowed to read answers this question.',
  sources_conflict: 'The sources disagree with each other, so no single answer can be given. Read them below and ask an expert.',
  not_grounded: 'An answer could not be backed by exact quotes from the sources, so none is shown.',
  budget_exhausted: 'The AI budget for this period is used up. The matching passages are listed instead.',
  ai_unavailable: 'The AI service is not available right now. The matching passages are listed instead.',
};

const VERDICT_TEXT: Readonly<Record<KFeedbackVerdict, string>> = { helpful: 'helpful', unhelpful: 'not helpful', wrong: 'wrong' };
const FOUND_BY_TEXT = {
  value_check: 'Found by comparing the values the sources state.',
  ai_model: 'The AI model reported that its sources disagree.',
} as const;

const isVerified = (status: string): boolean => status === 'verified' || status === 'corrected';

export function AskScreen() {
  const ask = useAsk();
  const [question, setQuestion] = useState('');
  const [asked, setAsked] = useState('');

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    const text = question.trim();
    setAsked(text);
    ask.mutate({ body: { question: text } });
  };

  return (
    <Page title="Ask" intro="Answers use only documents and knowledge you are allowed to read. Every statement points to its source.">
      <Card>
        <form onSubmit={onSubmit} noValidate>
          <TextArea label="Your question" rows={3} maxLength={2000} value={question} onChange={(e) => setQuestion(e.target.value)} />
          <Button type="submit" variant="primary" busy={ask.isPending} disabled={question.trim() === ''}>Ask</Button>
        </form>
      </Card>
      {ask.isPending && <p role="status" className="muted">Looking through the sources…</p>}
      <ErrorNote error={ask.error} />
      {ask.data !== undefined && !ask.isPending && <Answer answer={ask.data} question={asked} />}
    </Page>
  );
}

export function Answer({ answer, question }: { answer: KAnswer; question: string }) {
  return (
    <div aria-live="polite">
      {answer.outcome === 'answered' && answer.answer !== null ? (
        <Card title="Answer">
          <p className="answer">{answer.answer}</p>
          <div className="row">
            {answer.confidence !== null && <Badge tone={answer.confidence === 'high' ? 'success' : 'warning'}>{humanize(answer.confidence)} confidence</Badge>}
            {answer.contains_unverified_sources
              ? <Badge tone="warning">Uses sources nobody has verified yet</Badge>
              : <Badge tone="success">Verified sources only</Badge>}
          </div>
        </Card>
      ) : (
        <Banner tone="warning" title={answer.outcome === 'search_only' ? 'No written answer — here is what was found' : 'I don’t know'}>
          <p>{DONT_KNOW_REASONS[answer.reason ?? ''] ?? 'No answer could be given from the sources you may read.'}</p>
          {answer.conflicts.length > 0 && (
            <ul className="conflicts">
              {answer.conflicts.map((c) => (
                <li key={`${c.a.kind}:${c.a.id}:${c.a.value}:${c.b.kind}:${c.b.id}:${c.b.value}`}>
                  <ConflictSide side={c.a} /> says <strong>{c.a.value}</strong>; <ConflictSide side={c.b} /> says <strong>{c.b.value}</strong>.
                </li>
              ))}
            </ul>
          )}
          {answer.conflict_found_by !== null && <p className="muted">{FOUND_BY_TEXT[answer.conflict_found_by]}</p>}
          {answer.conflict_check_partial && <p className="muted">The material was too large to compare completely; only the first part was read.</p>}
          {answer.reason === 'sources_conflict' && <p className="muted">{VALUE_CHECK_LIMITS}</p>}
        </Banner>
      )}
      {answer.citations.length > 0 && (
        <Card title={answer.outcome === 'answered' ? 'Sources' : 'Passages that may help'}>
          <ul className="sources">{answer.citations.map((c) => <Citation key={`${c.ref}:${c.id}`} citation={c} />)}</ul>
        </Card>
      )}
      {answer.answer_id !== null && <Feedback key={answer.answer_id} answerId={answer.answer_id} />}
      {answer.can_ask_expert && <AskExpert question={question} />}
    </div>
  );
}

/** One side of a disagreement: the source's title, as a link when the card may open it (the same kind and id as a citation). */
function ConflictSide({ side }: { side: KConflictSide }) {
  const title = side.title || (side.kind === 'item' ? 'A knowledge item' : 'A document');
  return side.kind === 'item'
    ? <ScreenLink screen="knowledgeItem" id={side.id}>{title}</ScreenLink>
    : <ScreenLink screen="document" id={side.id}>{title}</ScreenLink>;
}

/** The reader's opinion of this answer. "Wrong" asks for a few words and sends the answer to a reviewer.
 *  The question itself stays private unless the reader ticks the box. The opinion can be taken back. */
function Feedback({ answerId }: { answerId: string }) {
  const { can } = useSession();
  const send = usePutFeedback();
  const withdraw = useWithdrawFeedback();
  // What this card said about this answer before (for example before the page was loaded again). "Not found" = nothing yet.
  const earlier = useMyFeedback(answerId, { enabled: can('getAnswerFeedback') });
  const [wrong, setWrong] = useState(false);
  const [comment, setComment] = useState('');
  const [shareQuestion, setShareQuestion] = useState(false);
  const [takenBack, setTakenBack] = useState(false);
  if (!can('putAnswerFeedback')) return null;
  const busy = send.isPending || withdraw.isPending;
  const say = (verdict: KFeedbackVerdict): void => {
    const words = comment.trim();
    setTakenBack(false);
    send.mutate({
      path: { knowledge_answer_id: answerId },
      body: { verdict, share_question: shareQuestion, ...(verdict === 'wrong' && words !== '' ? { comment: words } : {}) },
    });
  };
  const takeBack = (): void => {
    withdraw.mutate({ path: { knowledge_answer_id: answerId } }, {
      onSuccess: () => {
        send.reset();
        setWrong(false);
        setComment('');
        setTakenBack(true);
      },
    });
  };
  // the opinion just sent wins; one taken back is not shown again even while the earlier read is still in memory
  const given = send.isSuccess ? send.data : takenBack ? undefined : earlier.data;
  if (given !== undefined) {
    return (
      <Banner tone="success" title="Thank you">
        <p>
          You said: {VERDICT_TEXT[given.verdict]}.{' '}
          {given.verdict === 'wrong' ? 'A reviewer will look at this answer.' : 'Your opinion was recorded.'}{' '}
          {given.question_shared ? 'Your question is shown with it to the people who look after answer quality.' : 'Your question is not shown to anyone.'}
        </p>
        {can('withdrawAnswerFeedback') && <Button busy={withdraw.isPending} onClick={takeBack}>Take it back</Button>}
        <ErrorNote error={withdraw.error} />
      </Banner>
    );
  }
  return (
    <Card title="Was this useful?">
      {takenBack && <p role="status" className="muted">Your opinion was removed.</p>}
      {!wrong ? (
        <div className="row">
          <Button busy={busy} onClick={() => say('helpful')}>Helpful</Button>
          <Button busy={busy} onClick={() => say('unhelpful')}>Not helpful</Button>
          <Button busy={busy} onClick={() => setWrong(true)}>It is wrong…</Button>
        </div>
      ) : (
        <div>
          <TextArea label="What is wrong? (optional)" hint="Personal details are blanked out before this is stored. A reviewer will see it." rows={2} maxLength={500}
            value={comment} onChange={(e) => setComment(e.target.value)} />
          <div className="row">
            <Button onClick={() => setWrong(false)}>Cancel</Button>
            <Button variant="primary" busy={busy} onClick={() => say('wrong')}>Report as wrong</Button>
          </div>
        </div>
      )}
      <CheckboxField label="Let reviewers see my question" checked={shareQuestion} onChange={setShareQuestion} disabled={busy} />
      <p className="muted">
        If ticked, the owner and the administrators of your company can read the question you asked (personal details blanked out) next to your
        opinion. If not, they see your opinion and comment, and not what you asked.
      </p>
      <ErrorNote error={send.error} />
    </Card>
  );
}

function Citation({ citation }: { citation: KCitation }) {
  return (
    <li>
      <div className="row">
        <strong>[{citation.ref}]</strong>
        <ScreenLink screen={citation.kind === 'item' ? 'knowledgeItem' : 'document'} id={citation.id}>{citation.title || 'Untitled'}</ScreenLink>
        <Badge tone="neutral">{citation.kind === 'item' ? 'Knowledge item' : 'Document'}</Badge>
        {isVerified(citation.verification_status) ? <Badge tone="success">Verified</Badge> : <Badge tone="warning">Not verified</Badge>}
        {citation.expert_display_name !== null && <span className="muted">from {citation.expert_display_name}</span>}
      </div>
      <p className="snippet">“{citation.snippet}”</p>
    </li>
  );
}

/** Sends the question to a named colleague. Shown only when the API says it is possible. */
function AskExpert({ question }: { question: string }) {
  const { can } = useSession();
  const allowed = can('createExpertQuestion') && can('listPeople');
  const people = useActivePeople({ enabled: allowed });
  const send = useApiMutation('createExpertQuestion');
  const [expert, setExpert] = useState('');
  if (!allowed) return null;
  if (send.isSuccess) return <Banner tone="success" title="Your question was sent">The expert will see it in their list. You are told when there is an answer.</Banner>;
  return (
    <Card title="Ask an expert instead">
      <SelectField label="Who should answer?" value={expert} onChange={(e) => setExpert(e.target.value)}>
        <option value="">Choose a colleague…</option>
        {(people.items ?? []).map((p) => <option key={p.id} value={p.id}>{p.display_name}</option>)}
      </SelectField>
      {people.hasMore && <PartialListNote shown={people.items?.length ?? 0} noun="people" busy={people.isLoadingMore} onLoadMore={people.loadMore} />}
      <ErrorNote error={send.error ?? people.error} />
      <Button busy={send.isPending} disabled={expert === '' || question === ''} onClick={() => send.mutate({ body: { expert_person_id: expert, question } })}>
        Send my question
      </Button>
    </Card>
  );
}
