// Job roles and gaps: for one job role, which topics it needs, who holds it and who follows, and
// where the captured knowledge is missing, unverified or thin.
import { useState, type FormEvent } from 'react';
import { useSession } from '../../session/session.tsx';
import { Badge, Banner, Button, Card, CheckboxField, ConfirmButton, DataTable, Empty, ErrorNote, Loading, Page, PartialListNote, SelectField, TextField } from '../../ui/index.tsx';
import { GAP_TEXT, gapTone, useGapReport, useRolePeopleChoices, useSetRolePeople, useSetRoleTopics, useTopicList } from './hooks.ts';

const IMPORTANCE = ['', 'Nice to know', 'Important', 'Critical'] as const;

export function GapsScreen() {
  const { can } = useSession();
  const [typed, setTyped] = useState('');
  const [jobRole, setJobRole] = useState('');
  const report = useGapReport(jobRole);
  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    setJobRole(typed.trim());
  };
  const topics = report.data?.topics ?? [];
  return (
    <Page title="Job roles and gaps" intro="Pick a job role to see what it needs to know and where the knowledge is missing. The labels are rules, not a judgement by an AI.">
      <Card>
        <form onSubmit={onSubmit} noValidate>
          <TextField label="Job role" hint="Type the name exactly as it was set up, for example “Boiler operator”. There is no list of job roles to choose from yet." maxLength={120}
            value={typed} onChange={(e) => setTyped(e.target.value)} />
          <Button type="submit" variant="primary" disabled={typed.trim() === ''}>Show</Button>
        </form>
      </Card>
      {jobRole !== '' && report.isPending && <Loading what="the gap report" />}
      <ErrorNote error={report.error} />
      {report.data !== undefined && (
        <>
          <h2>Gaps for “{report.data.job_role}”</h2>
          {topics.length === 0 ? <Empty>No topics are set for this job role yet. Choose them below.</Empty> : (
            <DataTable caption="Gap report" columns={['Topic', 'Finding', 'Verified items', 'Contributors', 'Importance']}>
              {topics.map((t) => (
                <tr key={t.topic_id}>
                  <td>{t.name}</td>
                  <td><Badge tone={gapTone(t.label)}>{GAP_TEXT[t.label]}</Badge></td>
                  <td>{t.verified_items}</td>
                  <td>{t.contributors}</td>
                  <td>{IMPORTANCE[t.importance] ?? t.importance}{t.required ? '' : ' (optional)'}</td>
                </tr>
              ))}
            </DataTable>
          )}
          {can('setRoleTopics') && <RoleTopics key={`${jobRole}:${topics.map((t) => `${t.topic_id}${t.importance}`).join(',')}`} jobRole={jobRole} current={topics} />}
          {can('setRolePeople') && can('listPeople') && <RolePeople key={jobRole} jobRole={jobRole} />}
        </>
      )}
    </Page>
  );
}

/** Which topics the job role needs. Saving replaces the whole list for this role. */
function RoleTopics({ jobRole, current }: { jobRole: string; current: ReadonlyArray<{ topic_id: string; importance: number; required: boolean }> }) {
  const all = useTopicList('active');
  const save = useSetRoleTopics();
  const [chosen, setChosen] = useState<ReadonlyMap<string, number>>(() => new Map(current.map((t) => [t.topic_id, t.importance])));
  const set = (id: string, importance: number | null): void => {
    const next = new Map(chosen);
    if (importance === null) next.delete(id);
    else next.set(id, importance);
    setChosen(next);
  };
  const items = all.items ?? [];
  return (
    <Card title="Topics this job role needs">
      {all.isPending && <Loading what="topics" />}
      <ErrorNote error={all.error ?? save.error} />
      {all.items !== undefined && items.length === 0 && <p className="muted">There are no topics in use yet. Add some on the Topics screen.</p>}
      {items.map((t) => (
        <div key={t.id} className="row">
          <CheckboxField label={t.name} checked={chosen.has(t.id)} onChange={(on) => set(t.id, on ? 2 : null)} />
          {chosen.has(t.id) && (
            <select className="input" aria-label={`Importance of ${t.name}`} value={chosen.get(t.id)} onChange={(e) => set(t.id, Number(e.target.value))}>
              {[1, 2, 3].map((n) => <option key={n} value={n}>{IMPORTANCE[n]}</option>)}
            </select>
          )}
        </div>
      ))}
      {all.hasMore && <PartialListNote shown={items.length} noun="topics" busy={all.isLoadingMore} onLoadMore={all.loadMore} />}
      {save.isSuccess && <Banner tone="success" title="The topics for this job role were saved" />}
      <Button variant="primary" busy={save.isPending} disabled={all.hasMore}
        onClick={() => save.mutate({ path: { job_role: jobRole }, body: { topics: [...chosen].map(([topic_id, importance]) => ({ topic_id, importance, required: current.find((t) => t.topic_id === topic_id)?.required ?? true })) } })}>
        Save the topics
      </Button>
      {all.hasMore && <p className="hint">Show all topics first: saving replaces the whole list for this job role.</p>}
    </Card>
  );
}

type Relation = '' | 'holder' | 'successor';

/** Who holds the job role and who is to follow. Saving replaces the whole list; the API cannot show the current one. */
function RolePeople({ jobRole }: { jobRole: string }) {
  const people = useRolePeopleChoices({ enabled: true });
  const save = useSetRolePeople();
  const [relations, setRelations] = useState<ReadonlyMap<string, Relation>>(new Map());
  const items = people.items ?? [];
  const chosen = [...relations].filter((entry): entry is [string, 'holder' | 'successor'] => entry[1] !== '');
  return (
    <Card title="People in this job role">
      <Banner tone="warning" title="Saving replaces the whole list">The people currently set for this job role cannot be shown here (the service has no way to read them back yet). Set everyone who belongs to it, then save.</Banner>
      {people.isPending && <Loading what="people" />}
      <ErrorNote error={people.error ?? save.error} />
      {items.map((p) => (
        <SelectField key={p.id} label={p.display_name} value={relations.get(p.id) ?? ''} onChange={(e) => setRelations(new Map(relations).set(p.id, e.target.value as Relation))}>
          <option value="">Not in this job role</option>
          <option value="holder">Holds the job now</option>
          <option value="successor">Is to take it over</option>
        </SelectField>
      ))}
      {people.hasMore && <PartialListNote shown={items.length} noun="people" busy={people.isLoadingMore} onLoadMore={people.loadMore} />}
      {save.isSuccess && <Banner tone="success" title="The people for this job role were saved" />}
      <p role="status">
        {chosen.length === 0
          ? 'Nobody is chosen: saving would leave this job role with no people.'
          : `${chosen.length} ${chosen.length === 1 ? 'person is' : 'people are'} chosen; saving sets exactly ${chosen.length === 1 ? 'this one' : 'these'} and removes everyone else.`}
      </p>
      <ConfirmButton variant="primary" label="Save the people" busy={save.isPending} disabled={people.hasMore} resetKey={chosen.map(([id, relation]) => `${id}:${relation}`).join(',')}
        confirmLabel={chosen.length === 0 ? 'Yes, leave this job role with no people' : `Yes, replace the list with ${chosen.length === 1 ? 'this 1 person' : `these ${chosen.length} people`}`}
        onConfirm={() => save.mutate({ path: { job_role: jobRole }, body: { people: chosen.map(([person_id, relation]) => ({ person_id, relation })) } })} />
    </Card>
  );
}
