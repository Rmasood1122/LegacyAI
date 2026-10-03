// Job roles and gaps: for one job role, which topics it needs, who holds it and who follows, and
// where the captured knowledge is missing, unverified or thin.
import { useState, type FormEvent } from 'react';
import { useSession } from '../../session/session.tsx';
import { Badge, Banner, Button, Card, CheckboxField, ConfirmButton, DataTable, Empty, ErrorNote, Loading, Page, PartialListNote, SelectField, TextField } from '../../ui/index.tsx';
import { GAP_TEXT, gapTone, useGapReport, useJobRoles, useRolePeople, useRolePeopleChoices, useRoleTopics, useSetRolePeople, useSetRoleTopics, useTopicList } from './hooks.ts';

const IMPORTANCE = ['', 'Nice to know', 'Important', 'Critical'] as const;

export function GapsScreen() {
  const { can } = useSession();
  const [typed, setTyped] = useState('');
  const [jobRole, setJobRole] = useState('');
  const report = useGapReport(jobRole);
  const roles = useJobRoles({ enabled: can('listJobRoles') });
  const known = roles.items ?? [];
  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    setJobRole(typed.trim());
  };
  const topics = report.data?.topics ?? [];
  return (
    <Page title="Job roles and gaps" intro="Pick a job role to see what it needs to know and where the knowledge is missing. The labels are rules, not a judgement by an AI.">
      <Card>
        <form onSubmit={onSubmit} noValidate>
          <TextField label="Job role" hint="Type the name, for example “Boiler operator”. A name that is not listed below starts a new job role." maxLength={120}
            value={typed} onChange={(e) => setTyped(e.target.value)} />
          <Button type="submit" variant="primary" disabled={typed.trim() === ''}>Show</Button>
        </form>
        <ErrorNote error={roles.error} />
        {known.length > 0 && (
          <div>
            <p className="muted">Job roles that have topics:</p>
            <div className="row">
              {known.map((r) => (
                <Button key={r.job_role} onClick={() => { setTyped(r.job_role); setJobRole(r.job_role); }}>
                  {r.job_role} ({r.topic_count} {r.topic_count === 1 ? 'topic' : 'topics'})
                </Button>
              ))}
            </div>
            {roles.hasMore && <PartialListNote shown={known.length} noun="job roles" busy={roles.isLoadingMore} onLoadMore={roles.loadMore} />}
          </div>
        )}
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
          {can('setRoleTopics') && can('getRoleTopics') && <RoleTopics key={jobRole} jobRole={jobRole} />}
          {can('setRolePeople') && can('listPeople') && can('getRolePeople') && <RolePeople key={jobRole} jobRole={jobRole} />}
        </>
      )}
    </Page>
  );
}

/**
 * Which topics the job role needs. The form starts from what is stored for the role as this card may see it
 * (getRoleTopics), not from the gap report, and sends exactly the rows it shows: the API replaces only those and keeps
 * any topic this card cannot see.
 */
function RoleTopics({ jobRole }: { jobRole: string }) {
  const current = useRoleTopics(jobRole);
  if (current.data === undefined) {
    return (
      <Card title="Topics this job role needs">
        {current.isPending && <Loading what="the topics of this job role" />}
        <ErrorNote error={current.error} />
      </Card>
    );
  }
  // a fresh form whenever what is stored changes (after a save, or when someone else changed it)
  return <RoleTopicsForm key={current.data.topics.map((t) => `${t.topic_id}:${t.importance ?? 2}:${t.required ?? true}`).join(',')} jobRole={jobRole} current={current.data.topics} />;
}

function RoleTopicsForm({ jobRole, current }: { jobRole: string; current: ReadonlyArray<{ topic_id: string; importance?: number; required?: boolean }> }) {
  const all = useTopicList('active');
  const save = useSetRoleTopics();
  const [chosen, setChosen] = useState<ReadonlyMap<string, number>>(() => new Map(current.map((t) => [t.topic_id, t.importance ?? 2])));
  const set = (id: string, importance: number | null): void => {
    const next = new Map(chosen);
    if (importance === null) next.delete(id);
    else next.set(id, importance);
    setChosen(next);
  };
  const items = all.items ?? [];
  // A topic that is set for the role but is not in the list of topics in use (it is only proposed so far) still gets a row,
  // so that nothing is sent that the form does not show.
  const listed = new Set(items.map((t) => t.id));
  const rows = [...items.map((t) => ({ id: t.id, name: t.name })),
    ...(all.items === undefined || all.hasMore ? [] : current.filter((t) => !listed.has(t.topic_id)).map((t) => ({ id: t.topic_id, name: 'A topic that is not in use yet (still proposed)' })))];
  const shown = new Set(rows.map((r) => r.id));
  const toSend = [...chosen].filter(([id]) => shown.has(id));
  const removed = current.filter((t) => !chosen.has(t.topic_id)).length;
  return (
    <Card title="Topics this job role needs">
      {all.isPending && <Loading what="topics" />}
      <ErrorNote error={all.error ?? save.error} />
      {all.items !== undefined && rows.length === 0 && <p className="muted">There are no topics in use yet. Add some on the Topics screen.</p>}
      {rows.map((t) => (
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
      <p role="status">
        {toSend.length} {toSend.length === 1 ? 'topic is' : 'topics are'} ticked{removed > 0 ? `; ${removed} that ${removed === 1 ? 'is' : 'are'} set now will be removed` : ''}.
        {' '}Topics you may not see, and retired ones, are not shown and stay as they are.
      </p>
      <Button variant="primary" busy={save.isPending} disabled={all.items === undefined || all.hasMore}
        onClick={() => save.mutate({
          path: { job_role: jobRole },
          body: { topics: toSend.map(([topic_id, importance]) => ({ topic_id, importance, required: current.find((t) => t.topic_id === topic_id)?.required ?? true })) },
        })}>
        Save the topics
      </Button>
      {all.hasMore && <p className="hint">Show all topics first, so that every topic of this job role has its row.</p>}
    </Card>
  );
}

type Relation = '' | 'holder' | 'successor';

/** Who holds the job role and who is to follow. The form starts from the people set now; saving replaces the whole list. */
function RolePeople({ jobRole }: { jobRole: string }) {
  const current = useRolePeople(jobRole, { enabled: true });
  if (current.data === undefined) {
    return (
      <Card title="People in this job role">
        {current.isPending && <Loading what="the people in this job role" />}
        <ErrorNote error={current.error} />
      </Card>
    );
  }
  // a fresh form whenever what is stored changes (after a save, or when someone else changed it)
  return <RolePeopleForm key={current.data.people.map((p) => `${p.person_id}:${p.relation}`).join(',')} jobRole={jobRole} current={current.data.people} />;
}

function RolePeopleForm({ jobRole, current }: { jobRole: string; current: ReadonlyArray<{ person_id: string; relation: string }> }) {
  const people = useRolePeopleChoices({ enabled: true });
  const save = useSetRolePeople();
  const [relations, setRelations] = useState<ReadonlyMap<string, Relation>>(
    () => new Map(current.map((p) => [p.person_id, p.relation === 'holder' ? 'holder' : 'successor'])));
  const items = people.items ?? [];
  // Someone who is set for the role but is no longer among the active people still gets a row: nothing is sent that the form does not show.
  const listed = new Set(items.map((p) => p.id));
  const rows = [...items.map((p) => ({ id: p.id, name: p.display_name })),
    ...(people.items === undefined || people.hasMore ? [] : current.filter((p) => !listed.has(p.person_id)).map((p) => ({ id: p.person_id, name: 'A person who is no longer active' })))];
  const shown = new Set(rows.map((r) => r.id));
  const chosen = [...relations].filter((entry): entry is [string, 'holder' | 'successor'] => entry[1] !== '' && shown.has(entry[0]));
  return (
    <Card title="People in this job role">
      <p className="muted">{current.length === 0 ? 'Nobody is set for this job role yet.' : `${current.length} ${current.length === 1 ? 'person is' : 'people are'} set now; they are shown below.`} Saving replaces the whole list.</p>
      {people.isPending && <Loading what="people" />}
      <ErrorNote error={people.error ?? save.error} />
      {rows.map((p) => (
        <SelectField key={p.id} label={p.name} value={relations.get(p.id) ?? ''} onChange={(e) => setRelations(new Map(relations).set(p.id, e.target.value as Relation))}>
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
          : `${chosen.length} ${chosen.length === 1 ? 'person is' : 'people are'} chosen; saving sets exactly ${chosen.length === 1 ? 'this one' : 'these'} and removes everyone else shown here.`}
      </p>
      <ConfirmButton variant="primary" label="Save the people" busy={save.isPending} disabled={people.items === undefined || people.hasMore} resetKey={chosen.map(([id, relation]) => `${id}:${relation}`).join(',')}
        confirmLabel={chosen.length === 0 ? 'Yes, leave this job role with no people' : `Yes, replace the list with ${chosen.length === 1 ? 'this 1 person' : `these ${chosen.length} people`}`}
        onConfirm={() => save.mutate({ path: { job_role: jobRole }, body: { people: chosen.map(([person_id, relation]) => ({ person_id, relation })) } })} />
    </Card>
  );
}
