// Documents: the list, and adding one (describe it, send the file, see what happened).
import { useState, type FormEvent } from 'react';
import { ScreenLink } from '../../navigation/ScreenLink.tsx';
import { useSession } from '../../session/session.tsx';
import {
  Badge, Banner, Button, Card, DataTable, Empty, ErrorNote, formatDate, humanize, Loading, Page, PartialListNote, SelectField, SENSITIVITY_LABELS, sensitivityLabel, TextField,
} from '../../ui/index.tsx';
import {
  ACCEPTED_FILES, AWAITING_CONFIRMATION_TEXT, contentTypeForFileName, documentStatusTone, failureText, useAddDocument, useContributorChoices, useDocumentList,
} from './hooks.ts';

export function DocumentsScreen() {
  const { can } = useSession();
  const documents = useDocumentList();
  return (
    <Page title="Documents" intro="Text, Markdown and PDF files with a text layer. Personal details are blanked out before anything is stored or sent to an AI.">
      {can('createSource') && can('uploadSourceContent') && <AddDocument />}
      <h2>Documents you may see</h2>
      {documents.isPending && <Loading what="documents" />}
      <ErrorNote error={documents.error} />
      {documents.items !== undefined && (documents.items.length === 0 ? <Empty>No documents yet.</Empty> : (
        <DataTable caption="Documents" columns={['Title', 'Status', 'Sensitivity', 'Passages', 'Added']}>
          {documents.items.map((d) => (
            <tr key={d.id}>
              <td><ScreenLink screen="document" id={d.id}>{d.title || 'Untitled'}</ScreenLink></td>
              <td><Badge tone={documentStatusTone(d.status)}>{humanize(d.status)}</Badge></td>
              <td>{sensitivityLabel(d.sensitivity)}</td>
              <td>{d.chunk_count}</td>
              <td>{formatDate(d.created_at)}</td>
            </tr>
          ))}
        </DataTable>
      ))}
      {documents.hasMore && <PartialListNote shown={documents.items?.length ?? 0} noun="documents" busy={documents.isLoadingMore} onLoadMore={documents.loadMore} />}
    </Page>
  );
}

function AddDocument() {
  const { can } = useSession();
  const { state, add, reset } = useAddDocument();
  const mayNamePeople = can('listPeople');
  const people = useContributorChoices({ enabled: mayNamePeople });
  const [title, setTitle] = useState('');
  const [sensitivity, setSensitivity] = useState(1);
  const [contributor, setContributor] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [formKey, setFormKey] = useState(0);
  const fileProblem = file !== null && contentTypeForFileName(file.name) === null ? 'Choose a .txt, .md or .pdf file.' : null;
  const busy = state.step === 'creating' || state.step === 'uploading';

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    if (file === null || fileProblem !== null) return;
    void add({ title: title.trim(), sensitivity, contributorPersonId: contributor === '' ? null : contributor, file });
  };
  const again = (): void => {
    reset();
    setTitle('');
    setFile(null);
    setContributor('');
    setFormKey((k) => k + 1);
  };

  return (
    <Card title="Add a document">
      {state.step === 'awaiting_confirmation' ? (
        <div>
          <Banner tone="info" title="Waiting for the contributor to confirm">{AWAITING_CONFIRMATION_TEXT}</Banner>
          <div className="row">
            <ScreenLink screen="document" id={state.sourceId}>Open the document</ScreenLink>
            <Button onClick={again}>Add another</Button>
          </div>
        </div>
      ) : state.step === 'done' ? (
        <div>
          {state.result.status === 'ready' && <Banner tone="success" title="The document is ready">{state.result.chunk_count ?? 0} passages can now be found and cited.</Banner>}
          {state.result.status === 'processing' && (
            <Banner tone="info" title="The document was received">It is still being processed. Its status is shown in the list.</Banner>
          )}
          {state.result.status === 'failed' && <Banner tone="danger" title="The document could not be used">{failureText(state.result.failure_code)}</Banner>}
          {state.result.duplicate_of !== null && <Banner tone="warning">The same file was added before.</Banner>}
          <div className="row">
            <ScreenLink screen="document" id={state.sourceId}>See what was blanked out</ScreenLink>
            <Button onClick={again}>Add another</Button>
          </div>
        </div>
      ) : (
        <form key={formKey} onSubmit={onSubmit} noValidate>
          <TextField label="Title" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
          <SelectField label="Who may read it" hint="People with a lower clearance will not see it, nor answers that use it." value={sensitivity} onChange={(e) => setSensitivity(Number(e.target.value))}>
            {SENSITIVITY_LABELS.map((label, level) => <option key={label} value={level}>{label}</option>)}
          </SelectField>
          {mayNamePeople && (
            <SelectField label="Whose material is it?" hint="A person’s own notes need that person’s consent. Company documents do not." value={contributor} onChange={(e) => setContributor(e.target.value)}>
              <option value="">The company’s (not one person’s own notes)</option>
              {(people.items ?? []).map((p) => <option key={p.id} value={p.id}>{p.display_name}</option>)}
            </SelectField>
          )}
          {mayNamePeople && people.hasMore && <PartialListNote shown={people.items?.length ?? 0} noun="people" busy={people.isLoadingMore} onLoadMore={people.loadMore} />}
          <TextField label="File" type="file" accept={Object.keys(ACCEPTED_FILES).join(',')} error={fileProblem} hint="Plain text, Markdown, or a PDF that contains text. The file itself is not kept."
            onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          {state.step === 'failed' && <ErrorNote error={state.error} />}
          {busy && <p role="status" className="muted">{state.step === 'creating' ? 'Creating the document…' : 'Sending and processing the file…'}</p>}
          <Button type="submit" variant="primary" busy={busy} disabled={title.trim() === '' || file === null || fileProblem !== null}>Add document</Button>
        </form>
      )}
    </Card>
  );
}
