// The core loop in a real browser, against the real API and the AI service with the FAKE provider.
// Synthetic company and people only. What a fake AI answers says nothing about a real model; these
// tests check that the screens and the API work together.
import { mkdir, writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { checkScreen, codeFor, newCard, sessionPermissions, signIn } from './support.ts';

// A fixed plain title: the database is new for every run, and a random suffix can be mistaken for personal data and blanked out.
const ITEM_TITLE = 'Relief valve lever test';

test.describe.configure({ mode: 'serial' });

// On a failure, keep what the page showed as text: CI publishes it, so the cause can be read without the screenshot.
test.afterEach(async ({ page }, info) => {
  if (info.status === info.expectedStatus) return;
  const text = await page.locator('body').innerText().catch(() => '(page text not available)');
  await mkdir('e2e-artifacts/failures', { recursive: true });
  await writeFile(`e2e-artifacts/failures/${info.title.replace(/[^a-z0-9]+/gi, '-').slice(0, 60)}.txt`, `${page.url()}
${text}`);
});

test('the page is served with the strict browser policy and nothing is kept in browser storage', async ({ page }) => {
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);
  const csp = response?.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("script-src 'self'");
  expect(csp).not.toContain('unsafe-inline');
  const violations: string[] = [];
  page.on('console', (m) => {
    if (m.text().includes('Content Security Policy')) violations.push(m.text());
  });
  await signIn(page, 'owner');
  expect(await page.evaluate(() => window.localStorage.length + window.sessionStorage.length)).toBe(0);
  // the session cookie is not readable by scripts
  expect(await page.evaluate(() => document.cookie)).toBe('');
  expect(violations).toEqual([]);
});

test('sign-in: wrong details are refused without saying which part was wrong', async ({ page }) => {
  await page.goto('/');
  await checkScreen(page, '01-sign-in');
  await page.getByLabel('Card number').fill('LGY-0000-0000-0000-0000');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('3-digit code').fill('000');
  await page.getByLabel('Code from your authenticator app').fill('000000');
  await page.getByRole('button', { name: 'Sign in with the app code' }).click();
  await expect(page.getByText('Sign-in did not work')).toBeVisible();
  await expect(page.getByRole('navigation')).toHaveCount(0);
});

test('first-time set-up with an authenticator app, then sign-in with the new card', async ({ page }) => {
  const card = await newCard();
  await page.goto('/set-up');
  await page.getByLabel('Card number').fill(card.card_number);
  await page.getByLabel('3-digit code').fill(card.sc);
  await page.getByLabel('Set-up token').fill(card.enrollment_token);
  await page.getByLabel(/authenticator app/).check();
  await checkScreen(page, '02-set-up');
  await page.getByRole('button', { name: 'Continue' }).click();
  const secret = (await page.getByTestId('totp-secret').innerText()).trim();
  await page.getByLabel('Code shown by the app').fill(await codeFor(secret));
  await page.getByRole('button', { name: 'Finish set-up' }).click();
  await expect(page.getByText('Your card is ready')).toBeVisible();

  await page.getByRole('link', { name: 'Go to sign-in' }).click();
  await page.getByLabel('Card number').fill(card.card_number);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('3-digit code').fill(card.sc);
  await page.getByLabel('Code from your authenticator app').fill(await codeFor(secret));
  await page.getByRole('button', { name: 'Sign in with the app code' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to LegacyAI' })).toBeVisible();
});

test('the owner adds a document and sees what was blanked out', async ({ page }) => {
  await signIn(page, 'owner');
  await checkScreen(page, '03-home');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Documents', exact: true }).click();
  await page.getByLabel('Title').fill('Boiler manual (synthetic)');
  await page.getByLabel('File').setInputFiles({
    name: 'boiler.txt', mimeType: 'text/plain',
    buffer: Buffer.from('Synthetic boiler manual. The relief valve lever is tested every month. Written by Jane Example, phone 555-0100. The boiler runs at 5 bar.'),
  });
  await page.getByRole('button', { name: 'Add document' }).click();
  await expect(page.getByText('The document is ready')).toBeVisible();
  await page.getByRole('button', { name: 'Add another' }).click();
  // The title is redacted like any other text (in the first run "Boiler" was taken for a person's name and shown as
  // [PERSON_1]), so the row is found by its place in the table, not by the title that was typed.
  const firstDocument = page.getByRole('table', { name: 'Documents' }).getByRole('link').first();
  await expect(firstDocument).toBeVisible();
  await expect(firstDocument).toContainText('manual (synthetic)');
  await checkScreen(page, '04-documents');
  await firstDocument.click();
  await expect(page.getByRole('heading', { name: 'What was blanked out' })).toBeVisible();
  await expect(page.getByText('Ready', { exact: true })).toBeVisible();
  await checkScreen(page, '05-document-detail');
});

test('asking: the screen shows exactly what the API decided - an answer with sources, or "I don\'t know"', async ({ page }) => {
  await signIn(page, 'owner');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Ask', exact: true }).click();
  for (const [n, question] of [[1, 'How often is the relief valve lever tested?'], [2, 'What is the wifi password of the canteen on the moon?']] as const) {
    await page.getByLabel('Your question').fill(question);
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/v1/knowledge/ask')),
      page.getByRole('button', { name: 'Ask', exact: true }).click(),
    ]);
    expect(response.status()).toBe(200);
    const answer = await response.json() as { outcome: string; answer: string | null; citations: unknown[] };
    if (answer.outcome === 'answered') {
      await expect(page.getByRole('heading', { name: 'Answer' })).toBeVisible();
      await expect(page.locator('p.answer')).toHaveText(answer.answer ?? '');   // the quote under Sources may repeat the same words
      await expect(page.getByRole('heading', { name: 'Sources' })).toBeVisible();
    } else {
      await expect(page.getByText(answer.outcome === 'search_only' ? 'No written answer — here is what was found' : 'I don’t know')).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Answer' })).toHaveCount(0);
    }
    await expect(page.locator('.sources li')).toHaveCount(answer.citations.length);
    test.info().annotations.push({ type: 'ask-outcome', description: `${question} -> ${answer.outcome}` });
    await checkScreen(page, `06-ask-${n}-${answer.outcome}`);
  }
});

test('the author gives consent, writes an item and sends it for review', async ({ page }) => {
  await signIn(page, 'author');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'My consent', exact: true }).click();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Give consent' }).click();
  await expect(page.getByText('Active', { exact: true })).toBeVisible();
  await checkScreen(page, '07-consent');

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Knowledge', exact: true }).click();
  await page.getByRole('button', { name: 'Write a new item' }).click();
  await page.getByLabel('Title').fill(ITEM_TITLE);
  await page.getByLabel('What should a successor know?').fill('Lift the relief valve lever once a month and let it snap back. If it sticks, stop the boiler.');
  await page.getByRole('button', { name: 'Save as draft' }).click();
  await expect(page.getByRole('heading', { name: ITEM_TITLE })).toBeVisible();
  await page.getByRole('button', { name: 'Send for review' }).click();
  await expect(page.getByText('Waiting for a reviewer')).toBeVisible();
  await checkScreen(page, '08-item-in-review');
});

test('a second card finds the task in the review queue and verifies the item', async ({ page }) => {
  await signIn(page, 'reviewer');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Review queue', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Verify a knowledge item' }).first()).toBeVisible();
  await checkScreen(page, '09-review-queue');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Knowledge', exact: true }).click();
  await checkScreen(page, '10-knowledge');
  await page.getByRole('link', { name: ITEM_TITLE }).click();
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByText('Verified by a reviewer')).toBeVisible();
  await checkScreen(page, '11-item-verified');
});

test('the author withdraws consent', async ({ page }) => {
  await signIn(page, 'author');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'My consent', exact: true }).click();
  await page.getByRole('button', { name: 'Withdraw…' }).click();
  await page.getByRole('button', { name: 'Yes, withdraw and erase' }).click();
  await expect(page.getByText('Your consent was withdrawn')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Withdraw…' })).toHaveCount(0);
});

test('a card without a permission is shown no way to the screen, and the API refuses it directly', async ({ page }) => {
  await signIn(page, 'learner');
  const permissions = await sessionPermissions(page);
  // Screens of this phase, the permission each needs, and an API address behind it.
  const guarded = [
    { label: 'Review queue', path: '/review', permission: 'review:read', api: '/v1/review/tasks' },
    { label: 'Documents', path: '/documents', permission: 'source:read', api: '/v1/sources' },
    { label: 'Knowledge', path: '/knowledge', permission: 'knowledge:read', api: '/v1/knowledge/items' },
  ];
  const denied = guarded.filter((g) => !permissions.includes(g.permission));
  expect(denied.length, 'the learner card should lack at least one of these permissions').toBeGreaterThan(0);
  for (const g of denied) {
    await page.goto('/');
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: g.label, exact: true })).toHaveCount(0);
    await page.goto(g.path);
    await expect(page.getByRole('heading', { name: 'This screen is not available' })).toBeVisible();
    // Hiding is not protection: the API itself must refuse.
    expect((await page.request.get(g.api)).status(), `GET ${g.api}`).toBe(403);
  }
  for (const g of guarded.filter((x) => permissions.includes(x.permission))) {
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: g.label, exact: true })).toHaveCount(1);
  }
  test.info().annotations.push({ type: 'denied-screens', description: denied.map((d) => d.label).join(', ') });
  await checkScreen(page, '12-not-available');
});
