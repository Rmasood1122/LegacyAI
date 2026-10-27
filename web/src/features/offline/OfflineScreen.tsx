// Offline reading (feature 9, decision D42): take a copy of a job role's verified knowledge onto this device, read and
// search it without a connection for 7 days, and remove it. What a copy holds is decided by the API: verified or
// corrected knowledge at levels 0 and 1 that this card may read, for the job role's topics.
import { useState, type FormEvent } from 'react';
import { useApiList, useApiMutation } from '../../api/context.tsx';
import { useOfflineStore } from '../../offline/context.tsx';
import { PACK_DAYS, PackRefused } from '../../offline/store.ts';
import { useSession } from '../../session/session.tsx';
import { Banner, Button, Card, ConfirmButton, ErrorNote, Facts, formatDate, Loading, Page, SelectField, TextField } from '../../ui/index.tsx';
import { useOpenedPack } from './hooks.ts';
import { OfflineReader } from './OfflineReader.tsx';

export function OfflineScreen() {
  const store = useOfflineStore();
  const { state, can } = useSession();
  const cardId = state.status === 'signed_in' ? state.session.card_id : '';
  const { opened, failed, reload } = useOpenedPack();
  const download = useApiMutation('getOfflinePack');
  const roles = useApiList('listJobRoles', { query: { limit: 50 } }, { enabled: can('listJobRoles') });
  const [jobRole, setJobRole] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // A copy taken by another card is never shown (the frame removes it).
  const mine = opened?.state === 'open' && opened.cardId === cardId ? opened : undefined;

  const onDownload = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setSaveError(null);
    setSaving(true);
    try {
      let pack;
      try {
        pack = await download.mutateAsync({ query: { job_role: jobRole.trim() } });
      } catch {
        return; // shown below by the error note
      }
      try {
        await store.save(cardId, pack);
      } catch (err) {
        setSaveError(err instanceof PackRefused ? err.message : 'This browser could not keep the copy. It may be in private mode, or out of space.');
        return;
      }
      reload();
    } finally {
      setSaving(false);
    }
  };

  const onRemove = async (): Promise<void> => {
    await store.remove().catch(() => undefined);
    reload();
  };

  return (
    <Page title="Offline reading" intro="Keep a copy of a job role's verified knowledge on this device, to read and search without a connection.">
      <Card title="Take a copy">
        <p>A copy holds verified knowledge at the two lowest levels only (&quot;Public inside the company&quot; and
          &quot;Internal&quot;), and only what your card may read. It can be opened for {PACK_DAYS} days, then it must be taken again. Taking a copy
          replaces the one on this device, and is recorded in the company&apos;s audit log.</p>
        <form onSubmit={(e) => void onDownload(e)}>
          {can('listJobRoles') && (roles.items?.length ?? 0) > 0
            ? (
              <SelectField label="Job role" value={jobRole} onChange={(e) => setJobRole(e.target.value)} required>
                <option value="">Choose a job role</option>
                {roles.items?.map((r) => <option key={r.job_role} value={r.job_role}>{r.job_role}</option>)}
              </SelectField>
            )
            : <TextField label="Job role" value={jobRole} onChange={(e) => setJobRole(e.target.value)} required maxLength={120}
              hint="As your company writes it, for example: Boiler operator." />}
          <Button type="submit" variant="primary" busy={saving} disabled={jobRole.trim() === ''}>Take a copy</Button>
        </form>
        <ErrorNote error={download.error} />
        {saveError !== null && <Banner tone="danger" title="The copy was not kept">{saveError}</Banner>}
      </Card>

      {opened === undefined && <Loading what="the copy on this device" />}
      {failed && <Banner tone="danger" title="The copy on this device could not be read">This browser&apos;s storage did not answer. Take a copy again.</Banner>}
      {opened?.state === 'expired' && (
        <Banner tone="info" title="The copy on this device had expired">It could be opened until {formatDate(opened.expiresAt)} and has been removed.</Banner>
      )}
      {opened?.state === 'clock_behind' && (
        <Banner tone="warning" title="This device's clock is behind">
          The copy was last opened on {formatDate(opened.notBefore)}, later than this device&apos;s clock says. Set the clock right to open it.
        </Banner>
      )}
      {opened?.state === 'unreadable' && <Banner tone="warning" title="The copy on this device could not be opened">It has been removed. Take a copy again.</Banner>}
      {mine !== undefined && (
        <>
          <Card title="On this device">
            <Facts items={[
              ['Job role', mine.pack.job_role],
              ['As of', formatDate(mine.asOf)],
              ['Can be opened until', formatDate(mine.expiresAt)],
              ['Items', String(mine.pack.items.length)],
            ]} />
            <ConfirmButton label="Remove it from this device" confirmLabel="Remove the copy" resetKey={mine.asOf} onConfirm={() => void onRemove()} />
          </Card>
          <OfflineReader opened={mine} />
        </>
      )}

      <Card title="Reading without a connection">
        <p>Install LegacyAI on this device so it opens without a connection: in Chrome or Edge, choose &quot;Install&quot; in
          the address bar or the menu; on an iPhone or iPad, in Safari, choose Share, then &quot;Add to Home Screen&quot;.
          Open it once while connected. Without a connection, LegacyAI then shows the copy on this device.</p>
        <p className="muted">Signing out removes the copy. The browser may also remove it when the device is short of space.</p>
      </Card>
    </Page>
  );
}
