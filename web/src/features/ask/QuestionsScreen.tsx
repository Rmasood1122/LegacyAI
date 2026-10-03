// Questions between colleagues: the ones sent to me as an expert (answer or decline), and the
// ones I asked (see what became of them).
import { useState, type FormEvent } from 'react';
import { useApiList, useApiMutation } from '../../api/context.tsx';
import type { KExpertQuestion } from '../../api/generated.ts';
import { ScreenLink } from '../../navigation/ScreenLink.tsx';
import { useSession } from '../../session/session.tsx';
import { Badge, Banner, Button, Card, Empty, ErrorNote, formatDate, Loading, Page, PartialListNote, SelectField, TextArea, TextField } from '../../ui/index.tsx';

type Box = 'addressed' | 'asked';
type DeclineReason = 'not_my_area' | 'not_allowed_to_share' | 'unclear' | 'other';
const CHANGED = ['listExpertQuestions', 'listKnowledgeItems', 'listMyContributions'] as const;
const LIMIT = 50;

const STATUS: Readonly<Record<string, { text: string; tone: 'success' | 'warning' | 'neutral' }>> = {
  open: { text: 'Waiting for an answer', tone: 'warning' },
  answered: { text: 'Answered', tone: 'success' },
  declined: { text: 'Declined', tone: 'neutral' },
  expired: { text: 'Expired without an answer', tone: 'neutral' },
};
const DECLINE_TEXT: Readonly<Record<DeclineReason, string>> = {
  not_my_area: 'This is not my area',
  not_allowed_to_share: 'I am not allowed to share this',
  unclear: 'The question is not clear',
  other: 'Another reason',
};

export function QuestionsScreen() {
  const { can } = useSession();
  const mayAnswer = can('replyExpertQuestion');
  const [box, setBox] = useState<Box>(mayAnswer ? 'addressed' : 'asked');
  const questions = useApiList('listExpertQuestions', { query: { box, limit: LIMIT } });
  const items = questions.items ?? [];
  return (
    <Page title="Questions" intro="When the documents cannot answer, a colleague can be asked. An expert’s answer becomes a draft knowledge item that a second person checks.">
      {mayAnswer && (
        <SelectField label="Show" value={box} onChange={(e) => setBox(e.target.value as Box)}>
          <option value="addressed">Questions sent to me</option>
          <option value="asked">Questions I asked</option>
        </SelectField>
      )}
      {questions.isPending && <Loading what="questions" />}
      <ErrorNote error={questions.error} />
      {questions.items !== undefined && items.length === 0 && <Empty>{box === 'addressed' ? 'Nobody is waiting for an answer from you.' : 'You have not asked a colleague anything.'}</Empty>}
      {items.map((q) => <QuestionCard key={q.id} question={q} mine={box === 'addressed' && mayAnswer} />)}
      {questions.hasMore && <PartialListNote shown={items.length} noun="questions" busy={questions.isLoadingMore} onLoadMore={questions.loadMore} />}
    </Page>
  );
}

function QuestionCard({ question, mine }: { question: KExpertQuestion; mine: boolean }) {
  const reply = useApiMutation('replyExpertQuestion', CHANGED);
  const decline = useApiMutation('declineExpertQuestion', CHANGED);
  const [answer, setAnswer] = useState('');
  const [title, setTitle] = useState('');
  const [reason, setReason] = useState<DeclineReason>('not_my_area');
  const status = STATUS[question.status] ?? { text: question.status, tone: 'neutral' as const };
  const path = { question_id: question.id };
  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    reply.mutate({ path, body: { answer: answer.trim(), ...(title.trim() === '' ? {} : { title: title.trim() }) } });
  };
  return (
    <Card>
      <div className="row">
        <Badge tone={status.tone}>{status.text}</Badge>
        <span className="muted">Asked {formatDate(question.created_at)}{question.status === 'open' ? ` · expires ${formatDate(question.expires_at)}` : ''}</span>
      </div>
      <p className="question">{question.question}</p>
      {question.status === 'declined' && question.decline_reason !== null && <p className="muted">Reason: {DECLINE_TEXT[question.decline_reason as DeclineReason] ?? question.decline_reason}</p>}
      {question.answer_item_id !== null && <p><ScreenLink screen="knowledgeItem" id={question.answer_item_id}>Read the answer</ScreenLink></p>}
      <ErrorNote error={reply.error ?? decline.error} />
      {reply.isSuccess && <Banner tone="success" title="Your answer was saved as a draft knowledge item">A second person checks it before it counts as verified.</Banner>}
      {mine && question.status === 'open' && !reply.isSuccess && (
        <>
          <form onSubmit={onSubmit} noValidate>
            <TextArea label="Your answer" hint="Personal details are blanked out when it is saved. It needs your consent for “My own words”." rows={4} maxLength={4000} value={answer} onChange={(e) => setAnswer(e.target.value)} />
            <TextField label="A short title for it (optional)" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
            <Button type="submit" variant="primary" busy={reply.isPending} disabled={answer.trim() === ''}>Send my answer</Button>
          </form>
          <div className="row">
            <SelectField label="Or decline, because" value={reason} onChange={(e) => setReason(e.target.value as DeclineReason)}>
              {(Object.keys(DECLINE_TEXT) as DeclineReason[]).map((r) => <option key={r} value={r}>{DECLINE_TEXT[r]}</option>)}
            </SelectField>
            <Button busy={decline.isPending} onClick={() => decline.mutate({ path, body: { reason } })}>Decline</Button>
          </div>
        </>
      )}
    </Card>
  );
}
