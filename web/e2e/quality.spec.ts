// Features 23 and 22 in a real browser, against the real API and the AI service with the FAKE provider:
// two documents that disagree are added through the screen; the answer is refused by the check in code (the fake
// model answers from one document and never reports a conflict); the reader marks it wrong; the task and the
// counts appear. Synthetic company and text only. Runs after the other two files (one worker, files in name order).
import { expect, test, type Page } from '@playwright/test';
import { checkScreen, keepPageTextOnFailure, signIn } from './support.ts';

test.describe.configure({ mode: 'serial' });
test.afterEach(async ({ page }, info) => keepPageTextOnFailure(page, info));

const manage = (page: Page, name: string) => page.getByRole('navigation', { name: 'Manage' }).getByRole('link', { name, exact: true });
const main = (page: Page, name: string) => page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true });
const QUESTION = 'At what pressure does the CO2 low-pressure alarm come?';

async function addDocument(page: Page, title: string, text: string): Promise<void> {
  await page.getByLabel('Title').fill(title);
  await page.getByLabel('File').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from(text) });
  await page.getByRole('button', { name: 'Add document' }).click();
  await expect(page.getByText('The document is ready')).toBeVisible();
  await page.getByRole('button', { name: 'Add another' }).click();
}

test('two documents disagree: the answer is refused by the check in code and shows both values', async ({ page }) => {
  await signIn(page, 'owner');
  await main(page, 'Documents').click();
  await addDocument(page, 'Maintenance handbook (synthetic)', 'The CO2 low-pressure alarm is set at 3.0 bar.');
  await addDocument(page, 'Fault table (synthetic)', 'The CO2 low-pressure alarm comes when the CO2 pressure falls below 3.2 bar.');

  await main(page, 'Ask').click();
  await page.getByLabel('Your question').fill(QUESTION);
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/v1/knowledge/ask')),
    page.getByRole('button', { name: 'Ask', exact: true }).click(),
  ]);
  expect(response.status()).toBe(200);
  // what the API itself answered: the screen must show exactly that
  const answer = await response.json() as {
    outcome: string; reason: string | null; conflict_found_by: string | null; conflict_check_partial: boolean;
    conflicts: Array<{ a: { value: string }; b: { value: string } }>;
  };
  test.info().annotations.push({ type: 'conflict-answer', description: JSON.stringify({ ...answer, citations: undefined }) });
  expect(answer.outcome).toBe('dont_know');
  expect(answer.reason).toBe('sources_conflict');
  expect(answer.conflict_found_by).toBe('value_check');                               // the fake model never reports a conflict
  expect(answer.conflict_check_partial).toBe(false);
  expect(new Set([answer.conflicts[0]?.a.value, answer.conflicts[0]?.b.value])).toEqual(new Set(['3.0 bar', '3.2 bar']));

  await expect(page.getByText('I don’t know')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Answer', exact: true })).toHaveCount(0);
  const conflict = page.locator('ul.conflicts li').first();
  await expect(conflict).toContainText('3.0 bar');
  await expect(conflict).toContainText('3.2 bar');
  await expect(page.getByText('Found by comparing the values the sources state.')).toBeVisible();
  await expect(page.getByText(/does not catch contradictions in ordinary prose/)).toBeVisible();   // an empty list is not a promise
  await checkScreen(page, '30-ask-conflict');

  // the reader says the outcome is wrong; nothing is sent before the second button
  await page.getByRole('button', { name: 'It is wrong…' }).click();
  await page.getByLabel('What is wrong? (optional)').fill('Synthetic comment: the gauge label says 3.2.');
  await expect(page.getByRole('checkbox', { name: 'Let reviewers see my question' })).not.toBeChecked();   // the question stays private by default
  await page.getByRole('button', { name: 'Report as wrong' }).click();
  await expect(page.getByText('A reviewer will look at this answer.')).toBeVisible();
  await expect(page.getByText('Your question is not shown to anyone.')).toBeVisible();
});

test('the task about the answer is in the review queue, and the quality page counts what happened', async ({ page }) => {
  await signIn(page, 'owner');
  await main(page, 'Review queue').click();
  await expect(page.getByRole('table', { name: 'Review tasks' }).getByText('A reader marked an answer wrong')).toBeVisible();

  await manage(page, 'Answer quality').click();
  await expect(page.getByRole('heading', { name: 'Answer quality' })).toBeVisible();
  await expect(page.getByText(/found by comparing values: [1-9]/)).toBeVisible();        // at least the question of the test above
  const said = page.getByRole('table', { name: 'Readers’ feedback' });
  await expect(said.getByRole('row')).toHaveCount(2);                                   // header + the one opinion
  await expect(said).toContainText('Not shared by the reader');                        // the reader did not tick the box ...
  await expect(said).not.toContainText(QUESTION);                                       // ... so nobody else reads the question
  await expect(said).toContainText('Synthetic comment');
  await expect(page.getByRole('table', { name: 'Answer quality by week' }).getByRole('row')).toHaveCount(2);
  await checkScreen(page, '31-quality');

  await main(page, 'Conflicts and old items').click();
  await expect(page.getByRole('heading', { name: 'Verified items that disagree' })).toBeVisible();
  await expect(page.getByText('What the comparison cannot find')).toBeVisible();
  await checkScreen(page, '32-conflicts');
});

test('a learner may say what it thinks of its own answers but not read the company’s numbers', async ({ page }) => {
  await signIn(page, 'learner');
  await expect(manage(page, 'Answer quality')).toHaveCount(0);
  await expect(main(page, 'Conflicts and old items')).toHaveCount(0);
  await page.goto('/quality');
  await expect(page.getByRole('heading', { name: 'This screen is not available' })).toBeVisible();
  expect((await page.request.get('/v1/quality/summary')).status()).toBe(403);
  expect((await page.request.get('/v1/quality/feedback')).status()).toBe(403);
});
