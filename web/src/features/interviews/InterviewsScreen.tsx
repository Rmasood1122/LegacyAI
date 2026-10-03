// Interviews: the list, and (for people who run the programme) inviting someone.
import { useState, type FormEvent } from 'react';
import { ScreenLink } from '../../navigation/ScreenLink.tsx';
import { useSession } from '../../session/session.tsx';
import { Badge, Banner, Button, Card, DataTable, Empty, ErrorNote, formatDate, Loading, Page, PartialListNote, SelectField, TextField } from '../../ui/index.tsx';
import { INTERVIEW_STATUS_TEXT, interviewTone, useInterviewList, useInvitablePeople, useInviteToInterview } from './hooks.ts';

export function InterviewsScreen() {
  const { can } = useSession();
  const interviews = useInterviewList();
  const items = interviews.items ?? [];
  return (
    <Page title="Interviews" intro="An interview asks an expert about their work, one question at a time. Each answer becomes a draft knowledge item that a second person checks.">
      {can('createInterview') && <Invite />}
      <h2>Interviews you may see</h2>
      {interviews.isPending && <Loading what="interviews" />}
      <ErrorNote error={interviews.error} />
      {interviews.items !== undefined && (items.length === 0 ? <Empty>No interviews yet.</Empty> : (
        <DataTable caption="Interviews" columns={['Job role', 'State', 'Questions answered', 'Invited', 'Open']}>
          {items.map((i) => (
            <tr key={i.id}>
              <td>{i.job_role}</td>
              <td><Badge tone={interviewTone(i.status)}>{INTERVIEW_STATUS_TEXT[i.status] ?? i.status}</Badge></td>
              <td>{i.turn_count} of at most {i.max_turns}</td>
              <td>{formatDate(i.created_at)}</td>
              <td><ScreenLink screen="interview" id={i.id}>Open the interview</ScreenLink></td>
            </tr>
          ))}
        </DataTable>
      ))}
      {interviews.hasMore && <PartialListNote shown={items.length} noun="interviews" busy={interviews.isLoadingMore} onLoadMore={interviews.loadMore} />}
    </Page>
  );
}

function Invite() {
  const { can } = useSession();
  const mayList = can('listPeople');
  const people = useInvitablePeople({ enabled: mayList });
  const invite = useInviteToInterview();
  const [person, setPerson] = useState('');
  const [jobRole, setJobRole] = useState('');
  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    invite.mutate({ body: { expert_person_id: person, job_role: jobRole.trim() } }, { onSuccess: () => setPerson('') });
  };
  if (!mayList) return null;
  return (
    <Card title="Invite someone to an interview">
      <form onSubmit={onSubmit} noValidate>
        <SelectField label="Who is the expert?" hint="They must have given consent for their own words before the interview can start." value={person} onChange={(e) => setPerson(e.target.value)}>
          <option value="">Choose a person…</option>
          {(people.items ?? []).map((p) => <option key={p.id} value={p.id}>{p.display_name}</option>)}
        </SelectField>
        {people.hasMore && <PartialListNote shown={people.items?.length ?? 0} noun="people" busy={people.isLoadingMore} onLoadMore={people.loadMore} />}
        <TextField label="About which job role?" hint="The questions follow the topics set for this job role." maxLength={120} value={jobRole} onChange={(e) => setJobRole(e.target.value)} />
        <ErrorNote error={invite.error ?? people.error} />
        {invite.isSuccess && <Banner tone="success" title="The invitation was created">The expert sees it in their list of interviews.</Banner>}
        <Button type="submit" variant="primary" busy={invite.isPending} disabled={person === '' || jobRole.trim() === ''}>Invite</Button>
      </form>
    </Card>
  );
}
