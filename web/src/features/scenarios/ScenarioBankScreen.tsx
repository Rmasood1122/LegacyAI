// Scenarios, for the people who write and approve them: the list, and one scenario (read, edit, approve, retire).
// The address ".../new" opens an empty form.
import { useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router';
import type { KScenario } from '../../api/generated.ts';
import { ScreenLink, useScreenPath } from '../../navigation/ScreenLink.tsx';
import { useSession } from '../../session/session.tsx';
import {
  Badge, Banner, Button, Card, CheckboxField, ConfirmButton, DataTable, Empty, ErrorNote, Facts, formatDate, Loading, Page, PartialListNote, TextArea, TextField,
} from '../../ui/index.tsx';
import {
  bodyOf, draftOf, draftProblems, emptyDraft, emptyStep, FLAG_TEXT, MAX_POINTS, MAX_STEPS, pointsOf, SCENARIO_STATUS_TEXT, scenarioTone, useApproveScenario,
  useCreateScenario, useProposeRubric, useRetireScenario, useScenario, useScenarioList, useUpdateScenario, useVerifiedItems, WRITE_REFUSALS,
  type ScenarioDraft, type StepDraft,
} from './hooks.ts';

const NEW = 'new';

export function ScenarioBankScreen() {
  const { can } = useSession();
  const scenarios = useScenarioList();
  const items = scenarios.items ?? [];
  return (
    <Page title="Scenario writing" intro="A scenario asks a learner what they would do in a situation, step by step. Each step is tied to verified knowledge and has expected points. A second person approves it before learners can run it.">
      {can('createScenario') && <p><ScreenLink screen="scenarioEdit" id={NEW}>Write a new scenario</ScreenLink></p>}
      {scenarios.isPending && <Loading what="scenarios" />}
      <ErrorNote error={scenarios.error} />
      {scenarios.items !== undefined && (items.length === 0 ? <Empty>No scenario has been written yet.</Empty> : (
        <DataTable caption="Scenarios" columns={['Title', 'Job role', 'State', 'Steps', 'Changed']}>
          {items.map((s) => (
            <tr key={s.id}>
              <td><ScreenLink screen="scenarioEdit" id={s.id}>{s.title || 'Untitled'}</ScreenLink></td>
              <td>{s.job_role}</td>
              <td>
                <Badge tone={scenarioTone(s.status)}>{SCENARIO_STATUS_TEXT[s.status] ?? s.status}</Badge>
                {s.flag_reason !== null && <> <Badge tone="danger">Needs attention</Badge></>}
              </td>
              <td>{s.step_count}</td>
              <td>{formatDate(s.updated_at)}</td>
            </tr>
          ))}
        </DataTable>
      ))}
      {scenarios.hasMore && <PartialListNote shown={items.length} noun="scenarios" busy={scenarios.isLoadingMore} onLoadMore={scenarios.loadMore} />}
    </Page>
  );
}

export function ScenarioEditScreen() {
  const { scenarioId = '' } = useParams();
  const isNew = scenarioId === NEW;
  const scenario = useScenario(scenarioId, { enabled: !isNew });
  return (
    <Page title={isNew ? 'Write a scenario' : scenario.data?.title || 'Scenario'}>
      <p><ScreenLink screen="scenarioBank">All scenarios</ScreenLink></p>
      {isNew ? <Editor key={NEW} scenario={null} /> : (
        <>
          {scenario.isPending && <Loading what="the scenario" />}
          <ErrorNote error={scenario.error} />
          {scenario.data !== undefined && <Existing key={`${scenario.data.id}:${scenario.data.updated_at}`} scenario={scenario.data} />}
        </>
      )}
    </Page>
  );
}

/** One stored scenario: its state, what may be done with it, its text - and the form, where it may still be changed. */
function Existing({ scenario }: { scenario: KScenario }) {
  const { can } = useSession();
  const approve = useApproveScenario();
  const retire = useRetireScenario();
  const failed = approve.error ?? retire.error;
  const refusal = failed !== null && failed.code !== null ? WRITE_REFUSALS[failed.code] : undefined;
  const editable = scenario.status !== 'retired' && !scenario.has_attempts && can('updateScenario');
  return (
    <>
      <Card>
        <Facts items={[
          ['State', <Badge key="s" tone={scenarioTone(scenario.status)}>{SCENARIO_STATUS_TEXT[scenario.status] ?? scenario.status}</Badge>],
          ['For the job role', scenario.job_role],
          ['Last changed', formatDate(scenario.updated_at)],
          ['Approved', scenario.approved_at === null ? 'Not approved' : formatDate(scenario.approved_at)],
        ]} />
        {scenario.flag_reason !== null && <Banner tone="warning" title="Needs attention">{FLAG_TEXT[scenario.flag_reason] ?? scenario.flag_reason}</Banner>}
        {scenario.status === 'draft' && scenario.written_by_me && (
          <Banner tone="info" title="A second person approves it">You created this scenario or last changed its text, so somebody else has to approve it.</Banner>
        )}
        {scenario.has_attempts && scenario.status !== 'retired' && (
          <Banner tone="info" title="It has been run">Learners have run this scenario, so its text can no longer be changed. To change it, retire it and write a new one.</Banner>
        )}
        <div className="row">
          {scenario.status === 'draft' && can('approveScenario') && !scenario.written_by_me && (
            <ConfirmButton resetKey={scenario.updated_at} variant="primary" label="Approve" confirmLabel="Yes, learners may run it" busy={approve.isPending}
              onConfirm={() => approve.mutate({ path: { scenario_id: scenario.id }, body: { updated_at: scenario.updated_at } })} />
          )}
          {scenario.status !== 'retired' && can('retireScenario') && (
            <ConfirmButton resetKey={scenario.updated_at} label="Retire for good" confirmLabel="Yes, retire it" busy={retire.isPending}
              onConfirm={() => retire.mutate({ path: { scenario_id: scenario.id } })} />
          )}
        </div>
        {refusal !== undefined ? <Banner tone="danger" title="Not possible">{refusal}</Banner> : <ErrorNote error={failed} />}
      </Card>
      {editable ? <Editor scenario={scenario} /> : <ReadOnly scenario={scenario} />}
    </>
  );
}

function ReadOnly({ scenario }: { scenario: KScenario }) {
  return (
    <>
      <Card title="The situation"><p>{scenario.situation === '' ? 'The text of this scenario was erased.' : scenario.situation}</p></Card>
      {scenario.steps.map((s) => (
        <Card key={s.position} title={`Step ${s.position}`}>
          {s.erased ? <p className="muted">The text of this step was erased because a linked item was withdrawn.</p> : (
            <>
              <p>{s.prompt}</p>
              <h3>Expected points</h3>
              <ul>{s.rubric.map((p) => <li key={p}>{p}</li>)}</ul>
              <h3>Knowledge it is tied to</h3>
              <ul>{s.items.map((i) => (
                <li key={i.id}>{i.title === null ? 'An item you may not read' : <ScreenLink screen="knowledgeItem" id={i.id}>{i.title || 'Untitled'}</ScreenLink>}</li>
              ))}</ul>
            </>
          )}
        </Card>
      ))}
    </>
  );
}

/** The form for a new scenario (scenario = null) or for changing a stored one. */
function Editor({ scenario }: { scenario: KScenario | null }) {
  const { can } = useSession();
  const create = useCreateScenario();
  const update = useUpdateScenario();
  const navigate = useNavigate();
  const pathTo = useScreenPath();
  const [draft, setDraft] = useState<ScenarioDraft>(() => (scenario === null ? emptyDraft() : draftOf(scenario)));
  const [tried, setTried] = useState(false);
  const items = useVerifiedItems({ enabled: can('listKnowledgeItems') });
  // only knowledge released to learners can be asked about
  const released = (items.items ?? []).filter((i) => i.sensitivity === 0);
  const problems = draftProblems(draft);
  const saving = create.isPending || update.isPending;
  const failed = create.error ?? update.error;
  const refusal = failed !== null && failed.code !== null ? WRITE_REFUSALS[failed.code] : undefined;

  // A step is named by its key, not by its place: a suggestion that arrives after another step was removed still
  // lands on the step it was asked for (or nowhere, if that step is gone).
  const setStep = (key: number, change: (step: StepDraft) => Partial<StepDraft>): void =>
    setDraft((d) => ({ ...d, steps: d.steps.map((s) => (s.key === key ? { ...s, ...change(s) } : s)) }));
  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    setTried(true);
    if (problems.length > 0) return;
    if (scenario === null) {
      create.mutate({ body: bodyOf(draft) }, {
        onSuccess: (made) => {
          const next = pathTo({ screen: 'scenarioEdit', id: made.id });
          if (next !== null) void navigate(next);
        },
      });
    } else {
      update.mutate({ path: { scenario_id: scenario.id }, body: bodyOf(draft, scenario.updated_at) });
    }
  };

  return (
    <form onSubmit={onSubmit} noValidate>
      <Card title={scenario === null ? 'The scenario' : 'Change the scenario'}>
        {scenario !== null && scenario.status === 'approved' && (
          <Banner tone="warning" title="Saving takes it out of use">A changed scenario is a draft again and needs a new approval - by somebody other than you.</Banner>
        )}
        <TextField label="Title" maxLength={200} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
        <TextArea label="The situation" hint="What happens: “what would you do if …”. The learner reads this. Personal details are blanked out when it is saved."
          rows={4} maxLength={2000} value={draft.situation} onChange={(e) => setDraft({ ...draft, situation: e.target.value })} />
        <TextField label="For which job role?" maxLength={120} value={draft.jobRole} onChange={(e) => setDraft({ ...draft, jobRole: e.target.value })} />
      </Card>
      {draft.steps.map((step, index) => (
        <StepEditor key={step.key} index={index} step={step} released={released} loadingItems={items.isPending && can('listKnowledgeItems')}
          canRemove={draft.steps.length > 1} onChange={(change) => setStep(step.key, change)}
          onRemove={() => setDraft((d) => ({ ...d, steps: d.steps.filter((s) => s.key !== step.key) }))} />
      ))}
      {items.hasMore && <PartialListNote shown={(items.items ?? []).length} noun="verified items" busy={items.isLoadingMore} onLoadMore={items.loadMore} />}
      <div className="row">
        <Button disabled={draft.steps.length >= MAX_STEPS} onClick={() => setDraft((d) => ({ ...d, steps: [...d.steps, emptyStep()] }))}>Add a step</Button>
      </div>
      <Card title="Save">
        {tried && problems.length > 0 && (
          <Banner tone="danger" title="Not ready to save">
            <ul>{problems.map((p) => <li key={p}>{p}</li>)}</ul>
          </Banner>
        )}
        {refusal !== undefined ? <Banner tone="danger" title="Not possible">{refusal}</Banner> : <ErrorNote error={failed} />}
        {update.isSuccess && <p className="muted" role="status">Saved as a draft.</p>}
        <Button type="submit" variant="primary" busy={saving}>{scenario === null ? 'Save as a draft' : 'Save the changes'}</Button>
      </Card>
    </form>
  );
}

function StepEditor({ index, step, released, loadingItems, canRemove, onChange, onRemove }: {
  index: number; step: StepDraft; released: ReadonlyArray<{ id: string; title: string }>; loadingItems: boolean; canRemove: boolean;
  onChange: (change: (current: StepDraft) => Partial<StepDraft>) => void; onRemove: () => void;
}) {
  const { can } = useSession();
  const propose = useProposeRubric();
  const toggle = (id: string, on: boolean): void => onChange((s) => ({ itemIds: on ? [...s.itemIds, id] : s.itemIds.filter((i) => i !== id) }));
  // items the step is tied to but that are not (any longer) in the list of released items: shown, so they can be taken off
  const missing = step.itemIds.filter((id) => !released.some((i) => i.id === id));
  const suggest = (): void => {
    propose.mutate({ body: { item_ids: step.itemIds } }, {
      // proposals are ADDED below what is there, for the writer to edit; nothing is replaced
      // (added to what the step holds WHEN the answer arrives, not to what it held when the button was pressed)
      onSuccess: (made) => onChange((s) => ({ points: [...pointsOf(s.points), ...made.rubric].slice(0, MAX_POINTS).join('\n') })),
    });
  };
  return (
    <Card title={`Step ${index + 1}`}>
      <TextArea label="What the learner is asked" rows={2} maxLength={1000} value={step.prompt} onChange={(e) => onChange(() => ({ prompt: e.target.value }))} />
      <fieldset>
        <legend>Verified knowledge this step is about</legend>
        {loadingItems && <Loading what="verified items" />}
        {!loadingItems && released.length === 0 && <p className="muted">No verified item is released to learners yet.</p>}
        {released.map((i) => (
          <CheckboxField key={i.id} label={i.title || 'Untitled'} checked={step.itemIds.includes(i.id)} onChange={(on) => toggle(i.id, on)} />
        ))}
        {missing.map((id) => (
          <CheckboxField key={id} label="An item that is no longer verified and released (take it off)" checked onChange={(on) => toggle(id, on)} />
        ))}
      </fieldset>
      <TextArea label="Expected points, one per line" hint="What a good answer contains. The learner never sees these before handing in, so none of them may appear in the title, the situation or a question."
        rows={4} value={step.points} onChange={(e) => onChange(() => ({ points: e.target.value }))} />
      <div className="row">
        {can('proposeScenarioRubric') && (
          <Button busy={propose.isPending} disabled={step.itemIds.length === 0} onClick={suggest}>Suggest points from the chosen items (AI)</Button>
        )}
        {canRemove && <Button onClick={onRemove}>Remove this step</Button>}
      </div>
      {propose.isSuccess && <p className="muted" role="status">Suggestions were added. Check and edit them: they are a starting point, not checked by anyone.</p>}
      <ErrorNote error={propose.error} />
    </Card>
  );
}
