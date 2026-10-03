// The remaining screens in a real browser, against the real API and the AI service with the FAKE
// provider: topics and gaps, interviews, the readiness test, people and cards, settings and the
// audit log. Synthetic company and people only. Rows are found by their place, not by a title that
// redaction could change. Runs after core-loop.spec.ts (one worker, files in name order).
import { expect, test } from '@playwright/test';
import { checkScreen, credentials, keepPageTextOnFailure, seedReadiness, signIn } from './support.ts';

test.describe.configure({ mode: 'serial' });
test.afterEach(async ({ page }, info) => keepPageTextOnFailure(page, info));

let jobRole = '';
test.beforeAll(async () => {
  jobRole = (await seedReadiness()).job_role;
});

const manage = (page: import('@playwright/test').Page, name: string) => page.getByRole('navigation', { name: 'Manage' }).getByRole('link', { name, exact: true });
const main = (page: import('@playwright/test').Page, name: string) => page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true });

test('the owner adds a topic and reads the gap report of a job role', async ({ page }) => {
  await signIn(page, 'owner');
  await manage(page, 'Topics').click();
  await page.getByLabel('Name', { exact: true }).fill('Pump seals');
  await page.getByLabel('What it covers').fill('replacing the seals of the feed pump');
  await page.getByRole('button', { name: 'Add topic' }).click();
  await expect(page.getByText('The topic was added')).toBeVisible();
  await expect(page.getByRole('table', { name: 'Topics' }).getByRole('row')).not.toHaveCount(1);   // the header row plus at least one topic
  await checkScreen(page, '20-topics');

  await manage(page, 'Job roles and gaps').click();
  await page.getByLabel('Job role', { exact: true }).fill(jobRole);
  await page.getByRole('button', { name: 'Show' }).click();
  const report = page.getByRole('table', { name: 'Gap report' });
  await expect(report).toBeVisible();
  await expect(report.getByRole('row')).toHaveCount(2);                                            // header + the one seeded topic
  await expect(page.getByRole('heading', { name: 'Topics this job role needs' })).toBeVisible();
  await checkScreen(page, '21-gaps');
});

test('interview: the owner invites an expert, who gives consent, starts it and answers a question', async ({ page }) => {
  await signIn(page, 'owner');
  await main(page, 'Interviews').click();
  await page.getByLabel('Who is the expert?').selectOption({ label: 'Synthetic reviewer' });
  await page.getByLabel('About which job role?').fill(jobRole);
  await page.getByRole('button', { name: 'Invite' }).click();
  await expect(page.getByText('The invitation was created')).toBeVisible();
  await checkScreen(page, '22-interviews');
  await page.getByRole('button', { name: 'Sign out' }).click();

  await signIn(page, 'reviewer');
  await main(page, 'My consent').click();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Give consent' }).click();
  await expect(page.getByText('Active', { exact: true })).toBeVisible();
  await main(page, 'Interviews').click();
  await page.getByRole('link', { name: 'Open the interview' }).first().click();
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByTestId('interview-question')).toBeVisible();
  await checkScreen(page, '23-interview-question');
  await page.getByLabel('Your answer').fill('Before a relief valve test I tell the control room, because the noise sets off the alarm panel otherwise.');
  await page.getByRole('button', { name: 'Send my answer' }).click();
  await expect(page.locator('ol > li')).toHaveCount(1);                                            // one answered question is listed
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByRole('heading', { name: 'The interview is paused' })).toBeVisible();
  await checkScreen(page, '24-interview-paused');
});

test('readiness: one reviewer writes and edits a question, a second approves it', async ({ page }) => {
  await signIn(page, 'reviewer');
  await manage(page, 'Test questions').click();
  await page.getByRole('group', { name: 'From which verified items?' }).getByRole('checkbox').first().check();
  await page.getByRole('button', { name: 'Write draft questions' }).click();
  await expect(page.getByText(/draft questions? written/)).toBeVisible();
  await page.getByRole('button', { name: 'Edit' }).first().click();
  await page.getByLabel('Question', { exact: true }).fill('How often is a relief valve lever tested?');
  for (const [i, option] of ['Monthly', 'Yearly', 'Never', 'Daily'].entries()) await page.getByLabel(`Option ${i + 1}`, { exact: true }).fill(option);
  await page.getByLabel('Which option is right?').selectOption('0');
  await page.getByRole('button', { name: 'Save the question' }).click();
  await expect(page.getByText('How often is a relief valve lever tested?')).toBeVisible();
  await checkScreen(page, '25-question-bank');
  await page.getByRole('button', { name: 'Sign out' }).click();

  await signIn(page, 'reviewer2');
  await manage(page, 'Test questions').click();
  await page.getByRole('button', { name: 'Approve' }).first().click();
  await expect(page.getByText('No questions here.')).toBeVisible();                                // the draft list is empty again
  await page.getByLabel('Show').selectOption('approved');
  await expect(page.getByText('How often is a relief valve lever tested?')).toBeVisible();
});

test('readiness: the learner takes the test, hands it in and reads the report', async ({ page }) => {
  await signIn(page, 'learner');
  await main(page, 'Readiness test').click();
  await checkScreen(page, '26-readiness-start');
  await page.getByLabel('For which job role?').fill(jobRole);
  await page.getByRole('button', { name: 'Start the test' }).click();
  await expect(page.getByRole('heading', { name: /Question 1 of/ })).toBeVisible();
  // While the test runs the page must not say which option is right.
  await expect(page.getByText(/right answer/i)).toHaveCount(0);
  await page.getByRole('radio').first().check();
  await expect(page.getByText('Saved.')).toBeVisible();
  await checkScreen(page, '27-readiness-question');
  await page.getByRole('button', { name: 'Hand in the test…' }).click();
  await page.getByRole('button', { name: 'Yes, hand it in' }).click();
  await page.getByRole('link', { name: 'Open the report for this test' }).click();
  await expect(page.getByRole('heading', { name: 'Readiness report' })).toBeVisible();
  await expect(page.getByText(/not a certificate/)).toBeVisible();
  await expect(page.getByRole('table', { name: 'Scores by topic' }).getByRole('row')).toHaveCount(2);
  await checkScreen(page, '28-readiness-report');
});

test('an administrator adds a person, issues a card (secrets shown once) and suspends it', async ({ page }) => {
  await signIn(page, 'admin');
  await manage(page, 'People').click();
  await page.getByLabel('Name', { exact: true }).fill('Synthetic Newhire');
  await page.getByRole('button', { name: 'Add person' }).click();
  await expect(page.getByText('The person was added')).toBeVisible();
  await checkScreen(page, '29-people');

  await manage(page, 'Cards').click();
  await page.getByLabel('For whom?').selectOption({ label: 'Synthetic Newhire' });
  await page.getByRole('group', { name: 'Roles' }).getByRole('checkbox', { name: /successor/i }).check();
  await page.getByRole('button', { name: 'Issue the card' }).click();
  await expect(page.getByTestId('secret-sc')).toHaveText(/^\d{3}$/);
  await expect(page.getByTestId('secret-token')).not.toBeEmpty();
  await page.getByRole('button', { name: 'I have written these down' }).click();
  await expect(page.getByTestId('secret-sc')).toHaveCount(0);
  await checkScreen(page, '30-cards');

  // Suspend and reinstate a card that is in use (a card that was only issued can be revoked, not suspended).
  const inUse = (await credentials('author')).card_number;
  await page.getByRole('link', { name: inUse }).click();
  await expect(page.getByRole('heading', { name: 'Card', exact: true })).toBeVisible();
  await page.getByLabel('Reason', { exact: true }).fill('Synthetic test of suspending');
  await page.getByRole('button', { name: 'Suspend', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Reinstate' })).toBeVisible();
  await expect(page.getByText('Suspended', { exact: true }).first()).toBeVisible();   // the state badge (the history lists it too)
  await checkScreen(page, '31-card');
  await page.getByRole('button', { name: 'Reinstate' }).click();
  await expect(page.getByRole('button', { name: 'Suspend', exact: true })).toBeVisible();
});

test('the owner opens the settings, the consents and the audit log, and checks the log', async ({ page }) => {
  await signIn(page, 'owner');
  await manage(page, 'Settings').click();
  await expect(page.getByRole('heading', { name: 'Cards and signing in' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'AI budget this month' })).toBeVisible();
  await checkScreen(page, '32-settings');

  await manage(page, 'Consents').click();
  await expect(page.getByRole('table', { name: 'Consents' })).toBeVisible();
  await checkScreen(page, '33-consents');

  await manage(page, 'Audit log').click();
  await expect(page.getByRole('table', { name: 'Audit entries' }).getByRole('row')).not.toHaveCount(1);
  await page.getByRole('button', { name: 'Check the log' }).click();
  await expect(page.getByText(/No alteration was found/)).toBeVisible();
  await checkScreen(page, '34-audit');
});

test('a learner is shown none of the management screens, and the API refuses each of them directly', async ({ page }) => {
  await signIn(page, 'learner');
  await expect(page.getByRole('navigation', { name: 'Manage' })).toHaveCount(0);
  const guarded = [
    { path: '/audit', api: '/v1/audit/events' },
    { path: '/settings', api: '/v1/tenants/current/settings' },
    { path: '/readiness/questions', api: '/v1/readiness/questions' },
    { path: '/gaps', api: `/v1/gaps?job_role=${encodeURIComponent(jobRole)}` },
    { path: '/operator', api: '/v1/tenants' },
  ];
  for (const g of guarded) {
    await page.goto(g.path);
    await expect(page.getByRole('heading', { name: 'This screen is not available' })).toBeVisible();
    expect((await page.request.get(g.api)).status(), `GET ${g.api}`).toBe(403);
  }
  // Consents are different: a learner may read its OWN consent records, so the address answers 200 - but the
  // company screen is not offered, and the API hands over nobody else's records.
  await page.goto('/consents');
  await expect(page.getByRole('heading', { name: 'This screen is not available' })).toBeVisible();
  const session = await page.request.get('/v1/auth/session');
  const me = ((await session.json()) as { person_id: string | null }).person_id;
  const consents = await page.request.get('/v1/consents?limit=50');
  expect(consents.status(), 'GET /v1/consents').toBe(200);
  const owners = ((await consents.json()) as { items: Array<{ person_id: string }> }).items.map((c) => c.person_id);
  expect(owners.filter((p) => p !== me), 'consent records of other people').toEqual([]);
  // The operator console is for the platform operator only: even the company's owner has no way to it.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await signIn(page, 'owner');
  await expect(manage(page, 'Operator console')).toHaveCount(0);
  expect((await page.request.get('/v1/tenants')).status()).toBe(403);
});
