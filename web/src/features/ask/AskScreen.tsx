// Ask: a question box, and an answer that shows where it comes from - or a plain "I don't know".
import { useState, type FormEvent } from 'react';
import { useApiList, useApiMutation } from '../../api/context.tsx';
import type { KAnswer, KCitation } from '../../api/generated.ts';
import { ScreenLink } from '../../navigation/ScreenLink.tsx';
import { useSession } from '../../session/session.tsx';
import { Badge, Banner, Button, Card, ErrorNote, humanize, Page, PartialListNote, SelectField, TextArea } from '../../ui/index.tsx';

const DONT_KNOW_REASONS: Readonly<Record<string, string>> = {
  no_relevant_sources: 'Nothing you are allowed to read answers this question.',
  sources_conflict: 'The sources disagree with each other, so no single answer can be given. Read them below and ask an expert.',
  not_grounded: 'An answer could not be backed by exact quotes from the sources, so none is shown.',
  budget_exhausted: 'The AI budget for this period is used up. The matching passages are listed instead.',
  ai_unavailable: 'The AI service is not available right now. The matching passages are listed instead.',
};

const isVerified = (status: string): boolean => status === 'verified' || status === 'corrected';

export function AskScreen() {
  const ask = useApiMutation('askKnowledge');
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
        </Banner>
      )}
      {answer.citations.length > 0 && (
        <Card title={answer.outcome === 'answered' ? 'Sources' : 'Passages that may help'}>
          <ul className="sources">{answer.citations.map((c) => <Citation key={`${c.ref}:${c.id}`} citation={c} />)}</ul>
        </Card>
      )}
      {answer.can_ask_expert && <AskExpert question={question} />}
    </div>
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
  const people = useApiList('listPeople', { query: { status: 'active', limit: 100 } }, { enabled: allowed });
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
