// Features 26, 11 and 5 in a real browser, against the real API and the AI service with the FAKE provider:
// an admin adds a department template; the owner records a leaving date and the radar lists the person; an
// anomaly rule locks a card after real refused requests of a signed-in card, and an admin unlocks it.
// Synthetic company and people only. Runs after the other files (one worker, files in name order); the
// anomaly test is last because it changes the learner card's 3-digit code.
import { expect, test, type Page } from '@playwright/test';
import { checkScreen, keepPageTextOnFailure, signIn } from './support.ts';

test.describe.configure({ mode: 'serial' });
test.afterEach(async ({ page }, info) => keepPageTextOnFailure(page, info));

const manage = (page: Page, name: string) => page.getByRole('navigation', { name: 'Manage' }).getByRole('link', { name, exact: true });
const signOut = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to LegacyAI' })).toBeVisible();
};

test('an admin looks at a department template, adds it, and its topics and job roles are there; adding it again adds nothing', async ({ page }) => {
  await signIn(page, 'admin');
  await manage(page, 'Topics').click();
  await expect(page.getByRole('heading', { name: 'Start from a department template' })).toBeVisible();
  await page.getByLabel('Kind of department').selectOption('warehouse');
  const preview = page.getByRole('table', { name: 'Topics of the template Warehouse and logistics' });
  await expect(preview.getByRole('row')).toHaveCount(7);                                          // the heading row and six topics
  await checkScreen(page, '40-template-preview');
  await page.getByRole('button', { name: 'Add the 6 topics and 2 job roles…' }).click();          // nothing is sent before the second click
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/v1/topic-templates/warehouse/apply')),
    page.getByRole('button', { name: 'Yes, add the template “Warehouse and logistics”' }).click(),
  ]);
  expect(response.status()).toBe(200);
  const first = await response.json() as { topics_created: number; created_topic_ids: string[]; topics_existing: number; links_created: number };
  expect(first).toMatchObject({ topics_created: 6, topics_existing: 0, links_created: 8, links_existing: 0 });
  expect(first.created_topic_ids).toHaveLength(6);
  await expect(page.getByText('The template was added')).toBeVisible();
  await expect(page.getByRole('table', { name: 'Topics', exact: true }).getByText('Goods receiving')).toBeVisible();
  await checkScreen(page, '41-template-added');

  // the same template again: nothing new
  const again = await page.request.post('/v1/topic-templates/warehouse/apply', {
    headers: { 'x-csrf-token': ((await (await page.request.get('/v1/auth/session')).json()) as { csrf_token: string }).csrf_token, 'idempotency-key': `e2e-${Date.now()}`, origin: new URL(page.url()).origin },
  });
  expect(again.status()).toBe(200);
  expect(await again.json()).toMatchObject({ topics_created: 0, created_topic_ids: [], topics_existing: 6, links_created: 0, links_existing: 8 });

  // the job roles of the template can be picked on the gap screen
  await manage(page, 'Job roles and gaps').click();
  // (each job role is offered with its number of topics, e.g. "Warehouse operative (4 topics)")
  await expect(page.getByText(/^Warehouse operative \(\d+ topics?\)$/).first()).toBeVisible();
});

test('the owner records when a person plans to leave, and the retirement radar lists the person', async ({ page }) => {
  await signIn(page, 'owner');
  await manage(page, 'People').click();
  await page.getByRole('row', { name: /Synthetic learner/ }).getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByRole('heading', { name: 'Planned leaving date' })).toBeVisible();
  const date = new Date(Date.now() + 300 * 86_400_000).toISOString().slice(0, 10);                // about ten months from now
  await page.getByLabel('Leaves on').fill(date);
  await page.getByRole('button', { name: 'Save the date' }).click();
  await expect(page.getByText(new RegExp(`Leaves on ${date} — less than a year`))).toBeVisible();
  await checkScreen(page, '42-leaving-date');

  await manage(page, 'Retirement radar').click();
  const row = page.getByRole('table', { name: 'People who leave within 24 months' }).getByRole('row', { name: /Synthetic learner/ });
  await expect(row).toBeVisible();
  await expect(row).toContainText(date);
  await expect(row).toContainText('Less than a year');
  await checkScreen(page, '43-retirement-radar');

  // the date is personal: the person reads their own from the API, a colleague is refused, and the people list does not carry it
  const people = await page.request.get('/v1/people?limit=100');
  expect(JSON.stringify(await people.json())).not.toContain(date);
  await signOut(page);
  await signIn(page, 'author');
  await expect(page.getByRole('navigation', { name: 'Manage' }).getByRole('link', { name: 'Retirement radar' })).toHaveCount(0);
  const own = await page.request.get('/v1/retirement-radar');
  expect(own.status()).toBe(200);
  expect(((await own.json()) as { items: unknown[] }).items).toEqual([]);                          // the author has no date; the learner's is not shown to a colleague
});

test('an anomaly rule locks a card after refused requests of its own session, and an admin unlocks it with a new code', async ({ page }) => {
  // the owner switches the rule on with the lowest threshold (it is off in the test app so that other tests may collect refusals)
  await signIn(page, 'owner');
  await manage(page, 'Settings').click();
  await expect(page.getByRole('heading', { name: 'Unusual use of a card' })).toBeVisible();
  await page.getByLabel('Lock cards that are used in an unusual way').check();
  await page.getByLabel('Lock a card after this many refused actions …').fill('5');
  await page.getByRole('button', { name: 'Save these rules' }).click();
  await expect(page.getByText('The rules were saved')).toBeVisible();
  await checkScreen(page, '44-anomaly-rules');
  await signOut(page);

  // the learner's own session asks five times for something it may not read
  await signIn(page, 'learner');
  for (let i = 0; i < 5; i += 1) expect((await page.request.get('/v1/audit/events')).status(), `refusal ${i + 1}`).toBe(403);
  expect((await page.request.get('/v1/auth/session')).status()).toBe(401);                         // the card is locked: its session has ended

  // an admin sees the lock and undoes it
  await signIn(page, 'admin');
  await manage(page, 'Cards').click();
  const locks = page.getByRole('table', { name: 'Anomaly locks' });
  await expect(locks.getByText('Card was locked').first()).toBeVisible();
  await expect(locks.getByText('Many refused actions in a short time')).toBeVisible();
  await checkScreen(page, '45-anomaly-locks');
  // the card is named by its masked number; the newest lock is the first row
  await locks.getByRole('link').first().click();
  await expect(page.getByText('Locked by an anomaly rule', { exact: true })).toBeVisible();   // the badge on the card, not the list's heading
  await page.getByRole('button', { name: 'Unlock with a new 3-digit code…' }).click();
  await page.getByRole('button', { name: 'Yes, unlock it' }).click();
  await expect(page.getByText('The card was unlocked')).toBeVisible();
  await expect(page.getByText('Locked by an anomaly rule')).toHaveCount(0);
  await checkScreen(page, '46-card-unlocked');
  await signOut(page);

  // the owner switches the rule off again
  await signIn(page, 'owner');
  await manage(page, 'Settings').click();
  await page.getByLabel('Lock cards that are used in an unusual way').uncheck();
  await page.getByRole('button', { name: 'Save these rules' }).click();
  await expect(page.getByText('The rules were saved')).toBeVisible();
});
