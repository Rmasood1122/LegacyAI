// Features 4 (QR), 27 (activity numbers) and 30 (knowledge map) in a real browser, against the real API and the
// AI service with the FAKE provider. Synthetic company only. Runs after the other files; it uses the owner card
// only (the learner's 3-digit code was changed by the file before it). Assertions are about presence and about
// the screen matching what the API answered - never about exact numbers, which depend on what earlier files did.
import { readFile } from 'node:fs/promises';
import { expect, test, type Download, type Page } from '@playwright/test';
import { checkScreen, keepPageTextOnFailure, signIn } from './support.ts';

test.describe.configure({ mode: 'serial' });
test.afterEach(async ({ page }, info) => keepPageTextOnFailure(page, info));

const main = (page: Page, name: string) => page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true });
const manage = (page: Page, name: string) => page.getByRole('navigation', { name: 'Manage' }).getByRole('link', { name, exact: true });

/** The text of a file the browser was handed to save (a real download event, not a network answer). */
async function savedText(download: Download): Promise<string> {
  const where = await download.path();
  return readFile(where, 'utf8');
}

test('a card is shown as a QR code, and its address fills in the card number on the sign-in screen - nothing more', async ({ page }) => {
  await signIn(page, 'owner');
  await manage(page, 'Cards').click();
  await page.getByRole('table', { name: 'Cards' }).getByRole('row').filter({ hasText: 'Person' }).first().getByRole('link').click();
  const picture = page.getByRole('img', { name: /^QR code that opens the sign-in screen for card LGY-\d{4}-\d{4}-\d{4}-\d{4}$/ });
  await expect(picture).toBeVisible();
  await expect(page.getByText('It holds the card number only.')).toBeVisible();
  await expect(page.getByText(/NFC cards are not supported/)).toBeVisible();
  await checkScreen(page, '50-card-qr');
  const cardNumber = (await picture.getAttribute('aria-label') ?? '').slice(-23);
  expect(cardNumber).toMatch(/^LGY-\d{4}-\d{4}-\d{4}-\d{4}$/);
  // what goes on paper is the card only: it is in the page, but not shown on the screen
  const paper = page.getByRole('region', { name: 'The card as it is printed', includeHidden: true });
  await expect(paper).toBeHidden();
  await expect(paper).toContainText(cardNumber);
  // someone already signed in who opens a card's address: the number does not stay in the address bar either
  await page.goto(`/#card=${cardNumber}`);
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await expect.poll(() => new URL(page.url()).hash).toBe('');

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to LegacyAI' })).toBeVisible();
  // what a phone does after scanning: it opens the address fresh
  await page.goto('about:blank');
  await page.goto(`/#card=${cardNumber}`);
  await expect(page.getByLabel('Card number')).toHaveValue(cardNumber);
  await expect.poll(() => new URL(page.url()).hash).toBe('');                        // the number does not stay in the address bar
  await expect(page.getByLabel('3-digit code')).toHaveCount(0);                      // the code is still asked for, after Continue
  // a fragment with anything extra is ignored
  await page.goto('about:blank');
  await page.goto(`/#card=${cardNumber}&sc=123`);
  await expect(page.getByLabel('Card number')).toHaveValue('');
});

test('the owner reads the activity numbers; the screen shows what the API answered, says what the numbers are not, and saves them as a file', async ({ page }) => {
  await signIn(page, 'owner');
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/v1/analytics/activity')),
    manage(page, 'Activity').click(),
  ]);
  expect(response.status()).toBe(200);
  const body = await response.json() as {
    months: Array<{ month_start: string; items_captured: number; interviews_completed: number | null; tests_handed_in: number | null }>;
    items_now: { verified: number; stale_items: number; not_yet_verified: number };
    job_role_results: {
      state: string; minimum_group: number; window_start: string; window_end: string;
      rows: Array<{ job_role: string; state: string; people: number | null }>;
    };
  };
  test.info().annotations.push({ type: 'activity', description: JSON.stringify(body) });
  expect(body.months).toHaveLength(6);                                               // every month of the range, also the empty ones
  expect(body.months[0]?.interviews_completed).not.toBeNull();                       // the Owner may read interviews and results: numbers, not null
  expect(body.months[0]?.tests_handed_in).not.toBeNull();
  expect(body.job_role_results).toMatchObject({ state: 'shown', minimum_group: 5 });
  expect(body.job_role_results.window_end > body.job_role_results.window_start).toBe(true);
  for (const j of body.job_role_results.rows) {
    if (j.state === 'too_few_people') expect(j.people).toBeNull();
    else expect(j.people).toBeGreaterThanOrEqual(5);
  }
  await expect(page.getByRole('heading', { name: 'Activity', exact: true })).toBeVisible();
  await expect(page.getByText(/they do not show what it was worth/)).toBeVisible();
  await expect(page.getByRole('table', { name: 'Activity by month' }).getByRole('row')).toHaveCount(body.months.length + 1);
  await expect(page.getByText(/always the twelve complete months before the/)).toBeVisible();
  if (body.job_role_results.rows.some((j) => j.state === 'too_few_people')) await expect(page.getByText('Too few people to show (fewer than 5)').first()).toBeVisible();
  await checkScreen(page, '51-activity');
  // the numbers as a file: a real download, with one line per month under the header
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Save these numbers as a file (CSV)' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('legacyai-activity.csv');
  const lines = (await savedText(download)).trim().split('\r\n');
  expect(lines[0]).toBe('"month_start","documents_added","items_captured","items_verified","median_hours_to_verify","interviews_completed","tests_handed_in"');
  expect(lines).toHaveLength(body.months.length + 1);
  expect(lines[1]).toContain(`"${body.months[0]?.month_start}"`);
  // a learner-level card is refused by the API itself: checked in the API tests (the learner's code was changed by an earlier file)
});

test('the knowledge map can be walked from a topic to what it is linked to; the owner, who may export, takes it away as one file', async ({ page }) => {
  await signIn(page, 'owner');
  await main(page, 'Knowledge map').click();
  await expect(page.getByRole('heading', { name: 'Knowledge map' })).toBeVisible();
  await expect(page.getByText(/it is written to\s+the audit log/)).toBeVisible();
  await checkScreen(page, '52-map-start');

  // taking the map out is a real download of what the export answered
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Save the map as a file' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('legacyai-knowledge-graph.json');
  const graph = JSON.parse(await savedText(download)) as {
    schema: string; truncated: boolean; limits: { nodes_per_kind: number; edges: number };
    nodes: Array<{ kind: string; id: string; label: string }>;
    edges: Array<{ kind: string; from: { kind: string; id: string }; to: { kind: string; id: string } }>;
  };
  expect(graph.schema).toBe('legacyai-knowledge-graph/1');
  expect(graph.limits).toEqual({ nodes_per_kind: 2000, edges: 10000 });
  const known = new Set(graph.nodes.map((n) => `${n.kind}~${n.id}`));
  for (const e of graph.edges) expect(known.has(`${e.from.kind}~${e.from.id}`) && known.has(`${e.to.kind}~${e.to.id}`), JSON.stringify(e)).toBe(true);
  expect((await page.request.get('/v1/knowledge/graph/export')).status()).toBe(404);  // it is not a plain read
  // a topic that has at least one item linked to it, if earlier files made one; otherwise any topic
  const linked = graph.edges.find((e) => e.kind === 'item_topic');
  const topic = graph.nodes.find((n) => n.kind === 'topic' && (linked === undefined || n.id === linked.to.id));
  if (topic === undefined) throw new Error('earlier files created topics, so the map cannot be without one');

  await page.goto(`/graph/${encodeURIComponent(`topic~${topic.id}`)}`);
  await expect(page.getByRole('heading', { name: topic.label, level: 2 })).toBeVisible();
  await expect(page.getByText(/something hidden from this card looks the same as something that does not exist/)).toBeVisible();
  await checkScreen(page, '53-map-topic');
  if (linked !== undefined) {
    const item = graph.nodes.find((n) => n.kind === 'item' && n.id === linked.from.id);
    await page.locator('.plain-list').getByRole('link', { name: item?.label || 'Untitled', exact: true }).first().click();
    await expect(page.getByRole('link', { name: 'Open this item' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Topics', level: 2 })).toBeVisible();
  }
  // something that is not on the map
  await page.goto(`/graph/${encodeURIComponent('item~00000000-0000-7000-8000-000000000000')}`);
  await expect(page.getByText('It does not exist, or this card may not read it.')).toBeVisible();
  expect((await page.request.get('/v1/knowledge/graph?kind=person&id=x')).status()).toBe(400);
});
