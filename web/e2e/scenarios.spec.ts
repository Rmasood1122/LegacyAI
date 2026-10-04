// Feature 8 (scenario replay) in a real browser, against the real API and the AI service with the FAKE provider.
// Synthetic company only. One reviewer writes a scenario with two steps, a second reviewer approves it, the learner
// runs it and sees the result. The file is named so that it runs BEFORE step2-safety.spec.ts, which changes the
// learner's 3-digit code. Rows and buttons are found by their place, not by typed titles (text is redacted on saving).
import { expect, test, type Page } from '@playwright/test';
import { checkScreen, keepPageTextOnFailure, seedReadiness, signIn } from './support.ts';

test.describe.configure({ mode: 'serial' });
test.afterEach(async ({ page }, info) => keepPageTextOnFailure(page, info));

const main = (page: Page, name: string) => page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true });
const manage = (page: Page, name: string) => page.getByRole('navigation', { name: 'Manage' }).getByRole('link', { name, exact: true });

// What a good answer contains. A learner must not be able to read these anywhere before handing in.
const POINT_1 = 'Lift the lever until steam escapes';
const POINT_2 = 'Release the lever slowly';
let jobRole = '';

test.beforeAll(async () => {
  jobRole = (await seedReadiness()).job_role;        // the verified, released item the earlier files already use
});

test('a reviewer writes a scenario with two steps; as its author it cannot approve it', async ({ page }) => {
  await signIn(page, 'reviewer');
  await manage(page, 'Scenario writing').click();
  await checkScreen(page, '60-scenario-writing');
  await page.getByRole('link', { name: 'Write a new scenario' }).click();
  await page.getByLabel('Title').fill('Monthly check of the safety valve');
  await page.getByLabel('The situation').fill('It is the first Monday of the month and the safety valve of the steam generator has to be checked.');
  await page.getByLabel('For which job role?').fill(jobRole);
  await page.getByRole('button', { name: 'Add a step' }).click();
  const prompts = page.getByLabel('What the learner is asked');
  const points = page.getByLabel('Expected points, one per line');
  await prompts.nth(0).fill('How do you carry out the check?');
  await points.nth(0).fill(POINT_1);
  await prompts.nth(1).fill('And how do you end it?');
  await points.nth(1).fill(POINT_2);
  // each step is tied to the first verified item that is released to learners
  const stepCards = page.locator('fieldset');
  await stepCards.nth(0).getByRole('checkbox').first().check();
  await stepCards.nth(1).getByRole('checkbox').first().check();
  await checkScreen(page, '61-scenario-new');
  await page.getByRole('button', { name: 'Save as a draft' }).click();
  await expect(page.getByText('A second person approves it')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve…' })).toHaveCount(0);          // not offered to the person who wrote it
  await checkScreen(page, '62-scenario-draft');
});

test('a second reviewer approves it', async ({ page }) => {
  await signIn(page, 'reviewer2');
  await manage(page, 'Scenario writing').click();
  await page.getByRole('table', { name: 'Scenarios' }).getByRole('link').first().click();
  await expect(page.getByLabel('Expected points, one per line').first()).toHaveValue(POINT_1);   // a reviewer reads (and may still edit) the expected points
  await page.getByRole('button', { name: 'Approve…' }).click();
  await page.getByRole('button', { name: 'Yes, learners may run it' }).click();
  await expect(page.getByText('Approved — learners can run it')).toBeVisible();
  await checkScreen(page, '63-scenario-approved');
});

test('the learner runs it step by step, never sees the expected points before handing in, and gets a result', async ({ page }) => {
  await signIn(page, 'learner');
  await expect(page.getByRole('navigation', { name: 'Manage' })).toHaveCount(0);           // no way to the writers' screens
  expect((await page.request.get('/v1/scenarios')).status()).toBe(403);                    // ... and the API refuses them
  await main(page, 'Scenarios').click();
  const start = page.getByRole('button', { name: /^Start: / }).first();
  await expect(start).toBeVisible();
  await checkScreen(page, '64-scenarios-offered');
  const noPoints = async (): Promise<void> => {
    const text = await page.locator('body').innerText();
    expect(text).not.toContain(POINT_1);
    expect(text).not.toContain(POINT_2);
    expect(text).not.toContain('Expected points');
  };
  await noPoints();
  const [started] = await Promise.all([
    page.waitForResponse((r) => /\/v1\/scenarios\/[0-9a-f-]+\/attempts$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST'),
    start.click(),
  ]);
  expect(started.status()).toBe(201);
  expect(JSON.stringify(await started.json())).not.toMatch(/rubric|points/);              // what the API itself answered holds no expected points
  await expect(page.getByRole('heading', { name: 'Step 1 of 2' })).toBeVisible();
  await page.getByLabel('How do you carry out the check?').fill('I lift the lever and wait until steam escapes.');
  await page.getByRole('button', { name: 'Next step' }).click();
  await expect(page.getByRole('heading', { name: 'Step 2 of 2' })).toBeVisible();
  await page.getByLabel('And how do you end it?').fill('I walk away.');
  await page.getByRole('button', { name: 'Save this answer' }).click();
  await expect(page.getByText('Not saved yet.')).toHaveCount(0);
  await noPoints();
  await checkScreen(page, '65-scenario-running');
  await page.getByRole('button', { name: 'Hand in…' }).click();
  await page.getByRole('button', { name: 'Yes, hand it in' }).click();
  await expect(page.getByRole('heading', { name: 'Step 1', exact: true })).toBeVisible();
  // The company does not show answers after grading, so the learner gets neither the expected points nor the list
  // of items to read again - whether the run is already graded or still waits for a person.
  await expect(page.getByRole('heading', { name: 'Expected points' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Read this again' })).toHaveCount(0);
  await noPoints();
  await checkScreen(page, '66-scenario-result');
  // the run is in the learner's list, with a way back to its result
  await main(page, 'Scenarios').click();
  await expect(page.getByRole('table', { name: 'Scenario runs' }).getByRole('link', { name: 'Result' })).toBeVisible();
});
