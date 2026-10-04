// Features 27 and 30 on the screens: activity numbers (with the small-group rule shown, not worked around) and the
// knowledge map as lists that can be walked. Synthetic data only.
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KActivity, KActivityMonth, KGraphExport, KGraphNeighbourhood } from '../api/generated.ts';
import { FakeApi, makeSession, permissionsFor, problem, renderScreen, sessionValue } from '../test/harness.tsx';
import { saveAsFile, toCsv } from '../ui/files.ts';
import { ActivityScreen } from './insight/ActivityScreen.tsx';
import { GraphNodeScreen, GraphStartScreen } from './insight/GraphScreen.tsx';
import { activityCsv, nodeKey, NODE_KINDS, parseNodeKey } from './insight/hooks.ts';

const ID = (n: number): string => `01a10174-0000-7000-8000-${String(n).padStart(12, '0')}`;
const as = (...ops: Parameters<typeof permissionsFor>) => sessionValue(makeSession(permissionsFor(...ops)));

const activity: KActivity = {
  months: [
    { month_start: '2026-10-01', documents_added: 2, items_captured: 8, items_verified: 5, median_hours_to_verify: 3.5, interviews_completed: 1, tests_handed_in: 6 },
    { month_start: '2026-09-01', documents_added: 0, items_captured: 4, items_verified: 0, median_hours_to_verify: null, interviews_completed: 0, tests_handed_in: 0 },
  ],
  items_now: { verified: 5, stale_items: 1, not_yet_verified: 6 },
  job_role_results: {
    state: 'shown', window_start: '2025-10-01', window_end: '2026-10-01', minimum_group: 5, max_rows: 100, truncated: false,
    rows: [
      { job_role: 'Boiler operator', state: 'too_few_people', people: null, attempts: null, mean_score: null },
      { job_role: 'Line operator', state: 'shown', people: 6, attempts: 7, mean_score: 0.7 },
      { job_role: 'Warehouse operative', state: 'no_graded_answers', people: 5, attempts: 5, mean_score: null },
    ],
  },
};

afterEach(() => vi.restoreAllMocks());

describe('activity', () => {
  it('shows the months and says plainly that these are counts of activity, not of value', async () => {
    const api = new FakeApi({ getActivity: () => activity });
    renderScreen(<ActivityScreen />, { api, session: as('getActivity') });
    const months = within(await screen.findByRole('table', { name: 'Activity by month' }));
    expect(months.getAllByRole('row')).toHaveLength(3);
    expect(months.getByText('October 2026')).toBeTruthy();
    expect(months.getByText('3.5')).toBeTruthy();
    expect(months.getByText('—')).toBeTruthy();                                      // no item verified in September: no median, not "0"
    expect(screen.getByText(/they do not show what it was worth/)).toBeTruthy();
    expect(screen.getByText(/Every number counts only what this card may\s+read/)).toBeTruthy();
    expect(api.callsTo('getActivity')[0]?.query).toEqual({ months: 6 });
    expect(api.callsTo('getTenantUsage')).toEqual([]);                               // not asked for without the right
  });

  it('a number the card has no right to is said in words, never shown as 0', async () => {
    const limited: KActivity = { ...activity, months: activity.months.map((m) => ({ ...m, interviews_completed: null, tests_handed_in: null })) };
    renderScreen(<ActivityScreen />, { api: new FakeApi({ getActivity: () => limited }), session: as('getActivity') });
    const october = within((await screen.findByText('October 2026')).closest('tr') as HTMLElement);
    expect(october.getAllByText('Not shown to this card')).toHaveLength(2);
  });

  it('a job role says why it has no numbers: too few people, or no graded answers - and the fixed time is named', async () => {
    renderScreen(<ActivityScreen />, { api: new FakeApi({ getActivity: () => activity }), session: as('getActivity') });
    const roles = within(await screen.findByRole('table', { name: 'Readiness tests by job role' }));
    const small = within(roles.getByText('Boiler operator').closest('tr') as HTMLElement);
    expect(small.getByText('Too few people to show (fewer than 5)')).toBeTruthy();
    const shown = within(roles.getByText('Line operator').closest('tr') as HTMLElement);
    expect(shown.getByText('70 %')).toBeTruthy();
    const ungraded = within(roles.getByText('Warehouse operative').closest('tr') as HTMLElement);
    expect(ungraded.getByText('No graded answers yet')).toBeTruthy();
    expect(screen.getByText(/nobody’s own result can be read/)).toBeTruthy();
    expect(screen.getByText(/always the twelve complete months before the\s+current one/)).toBeTruthy();
    expect(screen.getByText(/1 October 2025/)).toBeTruthy();
  });

  it('shows no table at all to a card that may not read the whole company’s results', async () => {
    const closed: KActivity = { ...activity, job_role_results: { ...activity.job_role_results, state: 'not_allowed', rows: [] } };
    renderScreen(<ActivityScreen />, { api: new FakeApi({ getActivity: () => closed }), session: as('getActivity') });
    expect(await screen.findByText(/may not read the test results of the whole company/)).toBeTruthy();
    expect(screen.queryByRole('table', { name: 'Readiness tests by job role' })).toBeNull();
  });

  it('takes the cap of the job-role list from the answer, says so when nothing was recorded, and shows the API’s refusal', async () => {
    const cut: KActivity = { ...activity, job_role_results: { ...activity.job_role_results, truncated: true, max_rows: 3 } };
    const first = renderScreen(<ActivityScreen />, { api: new FakeApi({ getActivity: () => cut }), session: as('getActivity') });
    expect(await screen.findByText(/Only the first 3 job roles are listed/)).toBeTruthy();
    first.unmount();
    const empty: KActivity = { months: [], items_now: { verified: 0, stale_items: 0, not_yet_verified: 0 }, job_role_results: { ...activity.job_role_results, rows: [] } };
    const second = renderScreen(<ActivityScreen />, { api: new FakeApi({ getActivity: () => empty }), session: as('getActivity') });
    expect(await screen.findByText('Nothing was recorded in this time.')).toBeTruthy();
    expect(screen.getByText('No graded test in this time.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Save these numbers/ })).toBeNull();
    second.unmount();
    renderScreen(<ActivityScreen />, { api: new FakeApi({ getActivity: () => { throw problem(403, 'Not allowed', 'forbidden'); } }), session: as('getActivity') });
    expect(await screen.findByText('Not allowed')).toBeTruthy();
  });

  it('writes a file that a spreadsheet cannot be tricked by; a number the card may not read is an empty field', () => {
    expect(toCsv(['a', 'b'], [['plain', 1], ['say "hi"', null], ['=1+1', -2]])).toBe('"a","b"\r\n"plain","1"\r\n"say ""hi""",""\r\n"\'=1+1","-2"\r\n');
    const month = activity.months[0] as KActivityMonth;
    expect(activityCsv([{ ...month, interviews_completed: null }])).toBe(
      '"month_start","documents_added","items_captured","items_verified","median_hours_to_verify","interviews_completed","tests_handed_in"\r\n'
      + '"2026-10-01","2","8","5","3.5","","6"\r\n');
  });

  it('hands the browser a file through a link that is in the page, and keeps its address until the download can start', () => {
    vi.useFakeTimers();
    const made = vi.fn(() => 'blob:synthetic');
    const released = vi.fn();
    Object.assign(URL, { createObjectURL: made, revokeObjectURL: released });
    let inPage = false;
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(this: HTMLAnchorElement) {
      inPage = document.body.contains(this);
      expect(this.download).toBe('numbers.csv');
    });
    saveAsFile('numbers.csv', 'text/csv', 'a,b');
    expect(click).toHaveBeenCalledTimes(1);
    expect(inPage).toBe(true);
    expect(document.querySelector('a[download]')).toBeNull();                        // and taken out again
    expect(released).not.toHaveBeenCalled();                                         // not released at once
    vi.advanceTimersByTime(60_000);
    expect(released).toHaveBeenCalledWith('blob:synthetic');
    vi.useRealTimers();
  });
});

const around: KGraphNeighbourhood = {
  node: { kind: 'topic', id: ID(1), label: 'Relief valves', status: null },
  neighbours: [
    {
      group: 'items', edge_kind: 'item_topic', truncated: true,
      nodes: [
        { node: { kind: 'item', id: ID(2), label: 'Monthly lever test', status: 'verified' }, origin: 'reviewer' },
        { node: { kind: 'item', id: ID(3), label: 'Lever stuck', status: 'verified' }, origin: 'similarity' },
      ],
    },
    { group: 'job_roles', edge_kind: 'job_role_topic', truncated: false, nodes: [{ node: { kind: 'job_role', id: 'Boiler operator', label: 'Boiler operator', status: null }, origin: null }] },
  ],
  limit_per_group: 50,
};
const exported: KGraphExport = { schema: 'legacyai-knowledge-graph/1', nodes: [], edges: [], truncated: true, limits: { nodes_per_kind: 2000, edges: 10000 } };

describe('knowledge map', () => {
  const page = <T,>(items: T[]) => ({ items, next_cursor: null });
  const start = () => new FakeApi({
    listTopics: () => page([{ id: ID(1), name: 'Relief valves' }]) as never,
    listKnowledgeItems: () => page([{ id: ID(2), title: 'Monthly lever test' }]) as never,
    exportKnowledgeGraph: () => exported,
  });

  it('starts from topics or items; a card that may read the map but not export is not offered the file', async () => {
    const api = start();
    renderScreen(<GraphStartScreen />, { api, session: as('getGraphNeighbourhood', 'listTopics', 'listKnowledgeItems') });
    expect((await screen.findByRole('link', { name: 'Relief valves' })).getAttribute('href')).toBe(`/graph/${encodeURIComponent(`topic~${ID(1)}`)}`);
    expect((await screen.findByRole('link', { name: 'Monthly lever test' })).getAttribute('href')).toBe(`/graph/${encodeURIComponent(`item~${ID(2)}`)}`);
    expect(screen.queryByRole('button', { name: 'Save the map as a file' })).toBeNull();
    expect(api.callsTo('exportKnowledgeGraph')).toEqual([]);
  });

  it('a card that may export takes the map out only when asked, is told it is recorded, and is told when the file is cut short', async () => {
    const user = userEvent.setup();
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:synthetic'), revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const api = start();
    renderScreen(<GraphStartScreen />, { api, session: as('getGraphNeighbourhood', 'listTopics', 'listKnowledgeItems', 'exportKnowledgeGraph') });
    expect(await screen.findByText(/it is written to\s+the audit log/)).toBeTruthy();
    expect(api.callsTo('exportKnowledgeGraph')).toEqual([]);                          // fetched only when asked for
    await user.click(screen.getByRole('button', { name: 'Save the map as a file' }));
    expect(await screen.findByText(/at most 2000 of each kind and 10000 links/)).toBeTruthy();
    expect(api.callsTo('exportKnowledgeGraph')).toHaveLength(1);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('shows one node and its neighbours by kind; each group says for itself when it is cut short, and how a link was made', async () => {
    const api = new FakeApi({ getGraphNeighbourhood: () => around });
    renderScreen(<GraphNodeScreen />, {
      api, session: as('getGraphNeighbourhood', 'getKnowledgeItem'), at: `/graph/${encodeURIComponent(nodeKey('topic', ID(1)))}`, route: '/graph/:node',
    });
    expect(await screen.findByRole('heading', { name: 'Relief valves' })).toBeTruthy();
    expect(api.callsTo('getGraphNeighbourhood')[0]?.query).toEqual({ kind: 'topic', id: ID(1) });
    expect(screen.getByRole('link', { name: 'Monthly lever test' }).getAttribute('href')).toBe(`/graph/${encodeURIComponent(`item~${ID(2)}`)}`);
    expect(screen.getByRole('link', { name: 'Boiler operator' }).getAttribute('href')).toBe(`/graph/${encodeURIComponent('job_role~Boiler operator')}`);
    expect(screen.getAllByText(/Only the first 50 are listed; there are more/)).toHaveLength(1);       // the items group only
    expect(within(screen.getByText('Lever stuck').closest('li') as HTMLElement).getByText('(linked automatically)')).toBeTruthy();
    expect(within(screen.getByText('Monthly lever test').closest('li') as HTMLElement).queryByText('(linked automatically)')).toBeNull();
    expect(screen.getByText(/something hidden from this card looks the same as something that does not exist/)).toBeTruthy();
  });

  it('an empty group does not claim that nothing is linked', async () => {
    const lonely: KGraphNeighbourhood = { ...around, neighbours: [{ group: 'items', edge_kind: 'item_topic', truncated: false, nodes: [] }] };
    renderScreen(<GraphNodeScreen />, {
      api: new FakeApi({ getGraphNeighbourhood: () => lonely }), session: as('getGraphNeighbourhood'),
      at: `/graph/${encodeURIComponent(nodeKey('topic', ID(1)))}`, route: '/graph/:node',
    });
    expect(await screen.findByText('None that this card may read.')).toBeTruthy();
  });

  it('a node that does not exist and one the card may not read look the same', async () => {
    const api = new FakeApi({ getGraphNeighbourhood: () => { throw problem(404, 'Not found', 'not_found'); } });
    renderScreen(<GraphNodeScreen />, { api, session: as('getGraphNeighbourhood'), at: `/graph/${encodeURIComponent(nodeKey('item', ID(9)))}`, route: '/graph/:node' });
    expect(await screen.findByText('It does not exist, or this card may not read it.')).toBeTruthy();
  });

  it('an address that names no node asks the API nothing; a node’s address and its parts round-trip', () => {
    const api = new FakeApi({});
    renderScreen(<GraphNodeScreen />, { api, session: as('getGraphNeighbourhood'), at: '/graph/person~x', route: '/graph/:node' });
    expect(screen.getByText('This address does not name anything on the map')).toBeTruthy();
    expect(api.calls).toEqual([]);
    for (const kind of NODE_KINDS) {
      for (const id of [ID(1), 'Line 2 ~ night', 'Boiler operator']) expect(parseNodeKey(nodeKey(kind, id))).toEqual({ kind, id });
    }
    for (const bad of ['', 'topic', 'topic~', '~x', 'person~x', `item~${'x'.repeat(121)}`]) expect(parseNodeKey(bad), bad).toBeNull();
  });
});
