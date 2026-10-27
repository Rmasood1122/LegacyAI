// The offline reading screen (feature 9, D42): taking a copy for a job role, reading and searching it, removing it.
// Synthetic data only.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { OfflineScreen } from './offline/OfflineScreen.tsx';
import { FakeApi, makeSession, memoryOfflineStore, permissionsFor, problem, renderScreen, sessionValue } from '../test/harness.tsx';

const NOW = Date.parse('2026-10-27T10:00:00Z');
const DAY = 86_400_000;
const pack = (expiresIn = 7 * DAY) => ({
  job_role: 'Boiler operator', as_of: new Date(NOW).toISOString(), expires_at: new Date(NOW + expiresIn).toISOString(), max_sensitivity: 1 as const,
  topics: [{ topic_id: 't1', name: 'Relief valves' }, { topic_id: 't2', name: 'Boiler water' }], truncated: false,
  items: [
    { id: 'i1', title: 'Relief valve check', body: 'Lift the lever monthly.', status: 'verified' as const, sensitivity: 0, verified_at: null, topic_ids: ['t1'] },
    { id: 'i2', title: 'Blowdown', body: 'Blow down for ten seconds each shift.', status: 'corrected' as const, sensitivity: 1, verified_at: null, topic_ids: ['t2'] },
  ],
});
const session = (...extra: Parameters<typeof permissionsFor>) => sessionValue(makeSession(permissionsFor('getOfflinePack', ...extra)));

describe('offline reading', () => {
  it('takes a copy for the job role typed in, keeps it locked on the device, and shows it with its "as of" date', async () => {
    const offline = memoryOfflineStore({ now: NOW + 1000 });
    const api = new FakeApi({ getOfflinePack: () => pack() });
    renderScreen(<OfflineScreen />, { api, session: session(), offline: offline.store });
    await userEvent.type(screen.getByLabelText('Job role'), '  Boiler operator ');
    await userEvent.click(screen.getByRole('button', { name: 'Take a copy' }));
    expect(await screen.findByRole('heading', { name: 'On this device' })).toBeTruthy();
    expect(api.callsTo('getOfflinePack')).toEqual([{ query: { job_role: 'Boiler operator' } }]);
    expect(offline.storage.record?.card_id).toBe(makeSession([]).card_id);
    expect(new TextDecoder().decode(new Uint8Array(offline.storage.record?.sealed ?? new ArrayBuffer(0)))).not.toContain('Relief');
    expect(screen.getByText(/^As of /)).toBeTruthy();
    // search, narrow by topic, open an item
    await userEvent.type(screen.getByLabelText('Search this copy'), 'seconds');
    expect(screen.queryByRole('button', { name: 'Relief valve check' })).toBeNull();
    await userEvent.clear(screen.getByLabelText('Search this copy'));
    await userEvent.selectOptions(screen.getByLabelText('Topic'), 't1');
    expect(screen.queryByRole('button', { name: 'Blowdown' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Relief valve check' }));
    expect(screen.getByText('Lift the lever monthly.')).toBeTruthy();
    expect(screen.getByText(/^As of /)).toBeTruthy();
  });

  it('offers the company\'s job roles to choose from when the card may list them', async () => {
    const api = new FakeApi({ listJobRoles: () => ({ items: [{ job_role: 'Boiler operator', topic_count: 2 }], next_cursor: null }), getOfflinePack: () => pack() });
    renderScreen(<OfflineScreen />, { api, session: session('listJobRoles') });
    await screen.findByRole('option', { name: 'Boiler operator' });
    await userEvent.selectOptions(screen.getByLabelText('Job role'), 'Boiler operator');
    await userEvent.click(screen.getByRole('button', { name: 'Take a copy' }));
    await waitFor(() => expect(api.callsTo('getOfflinePack')).toEqual([{ query: { job_role: 'Boiler operator' } }]));
  });

  it('when the API refuses, nothing is kept and the reason is shown', async () => {
    const offline = memoryOfflineStore({ now: NOW });
    const api = new FakeApi({ getOfflinePack: () => { throw problem(503, 'The company\'s own encryption key cannot be used right now', 'unavailable'); } });
    renderScreen(<OfflineScreen />, { api, session: session(), offline: offline.store });
    await userEvent.type(screen.getByLabelText('Job role'), 'Boiler operator');
    await userEvent.click(screen.getByRole('button', { name: 'Take a copy' }));
    expect(await screen.findByText('The company\'s own encryption key cannot be used right now')).toBeTruthy();
    expect(offline.storage.record).toBeNull();
  });

  it('a copy that claims more than 7 days is not kept', async () => {
    const offline = memoryOfflineStore({ now: NOW });
    renderScreen(<OfflineScreen />, { api: new FakeApi({ getOfflinePack: () => pack(30 * DAY) }), session: session(), offline: offline.store });
    await userEvent.type(screen.getByLabelText('Job role'), 'Boiler operator');
    await userEvent.click(screen.getByRole('button', { name: 'Take a copy' }));
    expect(await screen.findByText('The copy was not kept')).toBeTruthy();
    expect(offline.storage.record).toBeNull();
  });

  it('removes the copy from the device after asking', async () => {
    const offline = memoryOfflineStore({ now: NOW });
    await offline.store.save(makeSession([]).card_id, pack());
    renderScreen(<OfflineScreen />, { session: session(), offline: offline.store });
    await userEvent.click(await screen.findByRole('button', { name: 'Remove it from this device…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove the copy' }));
    await waitFor(() => expect(offline.storage.record).toBeNull());
    expect(screen.queryByRole('heading', { name: 'On this device' })).toBeNull();
  });

  it('never shows a copy another card took', async () => {
    const offline = memoryOfflineStore({ now: NOW });
    await offline.store.save('01a10174-0000-7000-8000-0000000000ff', pack());
    renderScreen(<OfflineScreen />, { session: session(), offline: offline.store });
    expect(await screen.findByRole('heading', { name: 'Take a copy' })).toBeTruthy();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText('Relief valve check')).toBeNull();
  });
});
