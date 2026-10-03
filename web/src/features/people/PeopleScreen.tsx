// People and departments: who works here. A person gets access only through a card (Cards screen).
import { useState, type FormEvent } from 'react';
import type { Department, Person } from '../../api/generated.ts';
import { ScreenLink } from '../../navigation/ScreenLink.tsx';
import { useSession } from '../../session/session.tsx';
import { Badge, Banner, Button, Card, ConfirmButton, DataTable, Empty, ErrorNote, formatDate, Loading, Page, PartialListNote, SelectField, TextField } from '../../ui/index.tsx';
import { useCreateDepartment, useCreatePerson, useDepartments, usePeopleList, useUpdatePerson, type PersonStatus } from './hooks.ts';

export function PeopleScreen() {
  const { can } = useSession();
  const [status, setStatus] = useState<PersonStatus>('active');
  const people = usePeopleList(status);
  const departments = useDepartments();
  const update = useUpdatePerson();
  const [editing, setEditing] = useState<Person | null>(null);
  const items = people.items ?? [];
  const departmentName = (id: string | null): string => (id === null ? '—' : departments.data?.items.find((d) => d.id === id)?.name ?? 'Unknown');
  return (
    <Page title="People" intro="The people of the company. Adding a person gives no access yet; that takes a card." actions={<ScreenLink screen="cards">Cards</ScreenLink>}>
      {can('createPerson') && <NewPerson departments={departments.data?.items ?? []} />}
      {can('createDepartment') && <NewDepartment existing={departments.data?.items ?? []} />}
      <h2>The list</h2>
      <SelectField label="Show" value={status} onChange={(e) => setStatus(e.target.value as PersonStatus)}>
        <option value="active">People who work here</option>
        <option value="departed">People who have left</option>
      </SelectField>
      {people.isPending && <Loading what="people" />}
      <ErrorNote error={people.error ?? departments.error ?? update.error} />
      {editing !== null && <EditPerson key={editing.id} person={editing} departments={departments.data?.items ?? []} onClose={() => setEditing(null)} />}
      {people.items !== undefined && (items.length === 0 ? <Empty>Nobody here.</Empty> : (
        <DataTable caption="People" columns={['Name', 'Email', 'Department', 'State', 'Added', 'Actions']}>
          {items.map((p) => (
            <tr key={p.id}>
              <td>{p.display_name}</td>
              <td>{p.email ?? '—'}</td>
              <td>{departmentName(p.department_id)}</td>
              <td><Badge tone={p.status === 'active' ? 'success' : 'neutral'}>{p.status === 'active' ? 'Works here' : 'Has left'}</Badge></td>
              <td>{formatDate(p.created_at)}</td>
              <td>
                {can('updatePerson') && (
                  <div className="row">
                    <Button onClick={() => setEditing(p)}>Edit</Button>
                    {p.status === 'active'
                      ? <ConfirmButton label="Mark as left" confirmLabel={`Yes, ${p.display_name} has left`} busy={update.isPending} onConfirm={() => update.mutate({ path: { person_id: p.id }, body: { status: 'departed' } })} />
                      : <Button busy={update.isPending} onClick={() => update.mutate({ path: { person_id: p.id }, body: { status: 'active' } })}>Mark as working here</Button>}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </DataTable>
      ))}
      {people.hasMore && <PartialListNote shown={items.length} noun="people" busy={people.isLoadingMore} onLoadMore={people.loadMore} />}
    </Page>
  );
}

function DepartmentSelect({ departments, value, onChange }: { departments: readonly Department[]; value: string; onChange: (value: string) => void }) {
  return (
    <SelectField label="Department" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">No department</option>
      {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
    </SelectField>
  );
}

function NewPerson({ departments }: { departments: readonly Department[] }) {
  const create = useCreatePerson();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [department, setDepartment] = useState('');
  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    create.mutate({ body: { display_name: name.trim(), email: email.trim() === '' ? null : email.trim(), department_id: department === '' ? null : department } }, {
      onSuccess: () => {
        setName('');
        setEmail('');
      },
    });
  };
  return (
    <Card title="Add a person">
      <form onSubmit={onSubmit} noValidate>
        <TextField label="Name" maxLength={200} autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
        <TextField label="Email (optional)" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
        <DepartmentSelect departments={departments} value={department} onChange={setDepartment} />
        <ErrorNote error={create.error} />
        {create.isSuccess && <Banner tone="success" title="The person was added">Issue a card on the Cards screen to give them access.</Banner>}
        <Button type="submit" variant="primary" busy={create.isPending} disabled={name.trim() === ''}>Add person</Button>
      </form>
    </Card>
  );
}

function EditPerson({ person, departments, onClose }: { person: Person; departments: readonly Department[]; onClose: () => void }) {
  const update = useUpdatePerson();
  const [name, setName] = useState(person.display_name);
  const [email, setEmail] = useState(person.email ?? '');
  const [department, setDepartment] = useState(person.department_id ?? '');
  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    update.mutate({
      path: { person_id: person.id },
      body: { display_name: name.trim(), email: email.trim() === '' ? null : email.trim(), department_id: department === '' ? null : department },
    }, { onSuccess: onClose });
  };
  return (
    <Card title="Edit a person">
      <form onSubmit={onSubmit} noValidate>
        <TextField label="Name" maxLength={200} autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
        <TextField label="Email (optional)" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
        <DepartmentSelect departments={departments} value={department} onChange={setDepartment} />
        <ErrorNote error={update.error} />
        <div className="row">
          <Button type="submit" variant="primary" busy={update.isPending} disabled={name.trim() === ''}>Save</Button>
          <Button onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}

function NewDepartment({ existing }: { existing: readonly Department[] }) {
  const create = useCreateDepartment();
  const [name, setName] = useState('');
  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    create.mutate({ body: { name: name.trim() } }, { onSuccess: () => setName('') });
  };
  return (
    <Card title="Departments">
      <p className="muted">{existing.length === 0 ? 'There are no departments yet.' : existing.map((d) => d.name).join(', ')}</p>
      <form onSubmit={onSubmit} noValidate>
        <TextField label="New department" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
        <ErrorNote error={create.error} />
        <Button type="submit" busy={create.isPending} disabled={name.trim() === ''}>Add department</Button>
      </form>
    </Card>
  );
}
