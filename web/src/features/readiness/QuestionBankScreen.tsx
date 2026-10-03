// The test questions: generate drafts from verified items, edit them, approve them, retire them.
// A generated question is only a draft; a learner sees it only after a person approved it.
import { useState, type FormEvent } from 'react';
import type { KQuizItem } from '../../api/generated.ts';
import { ScreenLink } from '../../navigation/ScreenLink.tsx';
import { useSession } from '../../session/session.tsx';
import { Badge, Banner, Button, Card, CheckboxField, ConfirmButton, ErrorNote, Loading, Page, PartialListNote, SelectField, TextArea, TextField, Empty } from '../../ui/index.tsx';
import {
  GENERATE_REFUSALS, useApproveQuestion, useEditQuestion, useGenerateQuestions, useQuestionList, useRetireQuestion, useVerifiedItems, type QuestionStatus,
} from './hooks.ts';
import { OpenByReference, TestsTaken } from './ReadinessScreen.tsx';

const STATUS_TEXT: Readonly<Record<QuestionStatus, string>> = { draft: 'Drafts — waiting for approval', approved: 'Approved — used in tests', retired: 'Retired' };

export function QuestionBankScreen() {
  const { can } = useSession();
  const [status, setStatus] = useState<QuestionStatus>('draft');
  const questions = useQuestionList(status);
  const approve = useApproveQuestion();
  const retire = useRetireQuestion();
  const [editing, setEditing] = useState<string | null>(null);
  const items = questions.items ?? [];
  const mayManage = can('editQuizQuestion');
  return (
    <Page title="Test questions" intro="Questions for the readiness test. Each is written from one verified knowledge item and must be approved by a person before a learner sees it.">
      {can('generateQuizQuestions') && can('listKnowledgeItems') && <Generate />}
      <h2>The question bank</h2>
      <SelectField label="Show" value={status} onChange={(e) => setStatus(e.target.value as QuestionStatus)}>
        {(Object.keys(STATUS_TEXT) as QuestionStatus[]).map((s) => <option key={s} value={s}>{STATUS_TEXT[s]}</option>)}
      </SelectField>
      {questions.isPending && <Loading what="questions" />}
      <ErrorNote error={questions.error ?? approve.error ?? retire.error} />
      {questions.items !== undefined && items.length === 0 && <Empty>No questions here.</Empty>}
      {items.map((q) => (editing === q.id ? <EditQuestion key={q.id} question={q} onClose={() => setEditing(null)} /> : (
        <Card key={q.id}>
          <div className="row">
            <Badge tone="neutral">{q.kind === 'mcq' ? 'Multiple choice' : 'Open answer'}</Badge>
            <Badge tone={q.status === 'approved' ? 'success' : q.status === 'draft' ? 'warning' : 'neutral'}>{q.status === 'approved' ? 'Approved' : q.status === 'draft' ? 'Draft' : 'Retired'}</Badge>
            {q.topic_id === null && <Badge tone="warning">Not linked to a topic — cannot be used in a test</Badge>}
          </div>
          <p className="question">{q.stem}</p>
          {q.options !== null && <ol>{q.options.map((o, i) => <li key={o}>{o}{i === q.correct_option ? ' — right answer' : ''}</li>)}</ol>}
          {q.rubric !== null && q.rubric.length > 0 && (<><p className="muted">A good answer mentions:</p><ul>{q.rubric.map((r) => <li key={r}>{r}</li>)}</ul></>)}
          <p><ScreenLink screen="knowledgeItem" id={q.knowledge_item_id}>The knowledge item it was written from</ScreenLink></p>
          {mayManage && q.status !== 'retired' && (
            <div className="row">
              <Button onClick={() => setEditing(q.id)}>Edit</Button>
              {q.status === 'draft' && <Button variant="primary" busy={approve.isPending} onClick={() => approve.mutate({ path: { question_id: q.id } })}>Approve</Button>}
              <ConfirmButton resetKey={null} label="Retire" confirmLabel="Yes, retire this question" busy={retire.isPending} onConfirm={() => retire.mutate({ path: { question_id: q.id } })} />
            </div>
          )}
        </Card>
      )))}
      {questions.hasMore && <PartialListNote shown={items.length} noun="questions" busy={questions.isLoadingMore} onLoadMore={questions.loadMore} />}
      {can('listReadinessAttempts') && !can('startReadinessAttempt') && <TestsTaken />}
      {can('getReadinessReport') && !can('startReadinessAttempt') && <OpenByReference />}
    </Page>
  );
}

function Generate() {
  const verified = useVerifiedItems({ enabled: true });
  const generate = useGenerateQuestions();
  const [kind, setKind] = useState<'mcq' | 'open'>('mcq');
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string, on: boolean): void => {
    const next = new Set(chosen);
    if (on) next.add(id);
    else next.delete(id);
    setChosen(next);
  };
  const items = verified.items ?? [];
  return (
    <Card title="Write draft questions from verified items">
      <SelectField label="Kind of question" value={kind} onChange={(e) => setKind(e.target.value as 'mcq' | 'open')}>
        <option value="mcq">Multiple choice (four options)</option>
        <option value="open">Open answer (graded against a list of points)</option>
      </SelectField>
      <fieldset>
        <legend>From which verified items?</legend>
        {verified.isPending && <Loading what="verified items" />}
        {verified.items !== undefined && items.length === 0 && <p className="muted">There are no verified items yet.</p>}
        {items.map((i) => <CheckboxField key={i.id} label={i.title || 'Untitled'} checked={chosen.has(i.id)} onChange={(on) => toggle(i.id, on)} />)}
      </fieldset>
      {verified.hasMore && <PartialListNote shown={items.length} noun="items" busy={verified.isLoadingMore} onLoadMore={verified.loadMore} />}
      <ErrorNote error={generate.error ?? verified.error} />
      {generate.data !== undefined && (
        <Banner tone={generate.data.created.length > 0 ? 'success' : 'warning'} title={`${generate.data.created.length} draft ${generate.data.created.length === 1 ? 'question' : 'questions'} written`}>
          {generate.data.refused.length > 0 && (
            <ul>{generate.data.refused.map((r) => <li key={r.item_id}>One item was skipped: {GENERATE_REFUSALS[r.reason] ?? r.reason}.</li>)}</ul>
          )}
        </Banner>
      )}
      <p className="muted">This uses the AI budget. Drafts appear under “Drafts — waiting for approval”.</p>
      <Button variant="primary" busy={generate.isPending} disabled={chosen.size === 0 || chosen.size > 20}
        onClick={() => generate.mutate({ body: { kind, item_ids: [...chosen] } }, { onSuccess: () => setChosen(new Set()) })}>
        Write draft questions
      </Button>
    </Card>
  );
}

function EditQuestion({ question, onClose }: { question: KQuizItem; onClose: () => void }) {
  const edit = useEditQuestion();
  const [stem, setStem] = useState(question.stem);
  const [options, setOptions] = useState<string[]>(question.options ?? ['', '', '', '']);
  const [correct, setCorrect] = useState(question.correct_option ?? 0);
  const [rubric, setRubric] = useState((question.rubric ?? []).join('\n'));
  const isMcq = question.kind === 'mcq';
  const points = rubric.split('\n').map((r) => r.trim()).filter((r) => r !== '');
  const complete = stem.trim() !== '' && (isMcq ? options.every((o) => o.trim() !== '') : points.length > 0);
  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    edit.mutate({
      path: { question_id: question.id },
      body: isMcq ? { stem: stem.trim(), options: options.map((o) => o.trim()), correct_option: correct } : { stem: stem.trim(), rubric: points },
    }, { onSuccess: onClose });
  };
  return (
    <Card title="Edit the question">
      <form onSubmit={onSubmit} noValidate>
        <TextArea label="Question" hint="It must not contain the right answer." rows={2} maxLength={1000} value={stem} onChange={(e) => setStem(e.target.value)} />
        {isMcq ? (
          <>
            {options.map((o, i) => (
              <TextField key={i} label={`Option ${i + 1}`} maxLength={300} value={o} onChange={(e) => setOptions(options.map((x, j) => (j === i ? e.target.value : x)))} />
            ))}
            <SelectField label="Which option is right?" value={correct} onChange={(e) => setCorrect(Number(e.target.value))}>
              {options.map((_, i) => (
                <option key={i} value={i}>Option {i + 1}</option>
              ))}
            </SelectField>
          </>
        ) : (
          <TextArea label="Points a good answer mentions" hint="One per line. Each must be something the knowledge item itself says." rows={4} value={rubric} onChange={(e) => setRubric(e.target.value)} />
        )}
        {question.status === 'approved' && <Banner tone="warning" title="Saving puts this question back to draft">It has to be approved again before learners see it.</Banner>}
        <ErrorNote error={edit.error} />
        <div className="row">
          <Button type="submit" variant="primary" busy={edit.isPending} disabled={!complete}>Save the question</Button>
          <Button onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}
