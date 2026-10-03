// Documents: reading and changing them, without any markup.
import { useState } from 'react';
import { ApiError } from '../../api/client.ts';
import { useApiList, useApiMutation, useApiQuery, useRefresh } from '../../api/context.tsx';
import type { KUploadResult } from '../../api/generated.ts';
import type { BadgeTone } from '../../ui/index.tsx';

export const ACCEPTED_FILES: Readonly<Record<string, string>> = { '.txt': 'text/plain', '.md': 'text/markdown', '.pdf': 'application/pdf' };

/** The type to send for a file, from its name (browsers often report none for .md). Null = not accepted. */
export function contentTypeForFileName(name: string): string | null {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? null : ACCEPTED_FILES[name.slice(dot).toLowerCase()] ?? null;
}

const CHANGED = ['listSources', 'getSource'] as const;

/** The documents the card may see, a page at a time (`hasMore` / `loadMore`). */
export const useDocumentList = () => useApiList('listSources', { query: { limit: 50 } });
export const useDocument = (sourceId: string) => useApiQuery('getSource', { path: { source_id: sourceId } });
export const useWithdrawDocument = () => useApiMutation('withdrawSource', CHANGED);
export const useConfirmDocument = () => useApiMutation('confirmSource', CHANGED);
/** Active people who can be named as the contributor, a page at a time. */
export const useContributorChoices = ({ enabled }: { enabled: boolean }) => useApiList('listPeople', { query: { status: 'active', limit: 100 } }, { enabled });

export const documentStatusTone = (status: string): BadgeTone =>
  status === 'ready' ? 'success' : status === 'failed' ? 'danger' : status === 'withdrawn' ? 'neutral' : 'warning';

export interface NewDocument {
  title: string;
  sensitivity: number;
  /** null = a company document; otherwise the person whose own material this is (their consent is required). */
  contributorPersonId: string | null;
  file: File;
}

export type AddDocumentState =
  | { step: 'idle' }
  | { step: 'creating' | 'uploading' }
  // The named contributor has to confirm first: NO file was sent.
  | { step: 'awaiting_confirmation'; sourceId: string }
  | { step: 'done'; sourceId: string; result: KUploadResult }
  | { step: 'failed'; error: ApiError; sourceId: string | null };

const asApiError = (err: unknown): ApiError =>
  (err instanceof ApiError ? err : new ApiError('unavailable', 0, 'Something went wrong while adding the document. Try again.'));

/** Two calls in a row: describe the document, then send its file. Reports where it is. */
export function useAddDocument(): { state: AddDocumentState; add(doc: NewDocument): Promise<void>; reset(): void } {
  const create = useApiMutation('createSource');
  const upload = useApiMutation('uploadSourceContent');
  const refresh = useRefresh();
  const [state, setState] = useState<AddDocumentState>({ step: 'idle' });
  const add = async (doc: NewDocument): Promise<void> => {
    // A document that was created but whose file did not arrive is reused: trying again sends the file to the SAME
    // document instead of creating a second one.
    let sourceId: string | null = state.step === 'failed' ? state.sourceId : null;
    const retrying = sourceId !== null;
    try {
      if (sourceId === null) {
        setState({ step: 'creating' });
        const created = await create.mutateAsync({
          body: doc.contributorPersonId === null
            ? { title: doc.title, sensitivity: doc.sensitivity, company_document: true }
            : { title: doc.title, sensitivity: doc.sensitivity, contributor_person_id: doc.contributorPersonId },
        });
        sourceId = created.id;
        if (created.status === 'awaiting_confirmation') {
          setState({ step: 'awaiting_confirmation', sourceId });
          return;
        }
        if (created.status !== 'awaiting_content') {
          setState({ step: 'failed', error: new ApiError('unavailable', 0, `The document is in an unexpected state (${created.status}). Open it from the list.`), sourceId: null });
          return;
        }
      }
      setState({ step: 'uploading' });
      const result = await upload.mutateAsync({ path: { source_id: sourceId }, body: doc.file, contentType: contentTypeForFileName(doc.file.name) ?? '' });
      setState({ step: 'done', sourceId, result });
    } catch (err) {
      const error = asApiError(err);
      // If the kept document no longer takes a file (gone, or already has one), the next try starts a new one.
      const keep = !(retrying && (error.status === 404 || error.status === 409));
      setState({ step: 'failed', error, sourceId: keep ? sourceId : null });
    } finally {
      await refresh(CHANGED);
    }
  };
  return { state, add, reset: () => setState({ step: 'idle' }) };
}

const FAILURES: Readonly<Record<string, string>> = {
  consent_missing: 'The contributor has not given consent for documents (or has withdrawn it).',
  no_text_layer: 'The PDF has no text in it (it is probably a scan). Scanned documents are not supported yet.',
  empty: 'No text was found in the file.',
  too_large: 'The file is too large.',
  too_many_pages: 'The document has too many pages.',
  unsupported_type: 'This kind of file is not supported.',
  parse_failed: 'The file could not be read.',
  storage_full: 'The company’s storage allowance is used up.',
};
export const AWAITING_CONFIRMATION_TEXT = 'The named contributor has to confirm this document before its file can be sent. Nothing was uploaded yet.';
export const failureText = (code: string | null): string => (code === null ? '' : FAILURES[code] ?? `Processing stopped (${code}).`);
