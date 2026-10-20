// Outgoing webhooks (feature 28, part B) in a real browser, against the real API. The test server sends nothing
// (WEBHOOK_DELIVERY is not set), so nothing outside the test machine is called; what is sent, and how it is signed,
// is tested in services/api (test/integration/webhooks.test.ts, test/unit/webhooks.test.ts). Synthetic company only.
import { expect, test, type Page } from '@playwright/test';
import { checkScreen, keepPageTextOnFailure, signIn } from './support.ts';

test.describe.configure({ mode: 'serial' });
test.afterEach(async ({ page }, info) => keepPageTextOnFailure(page, info));

const manage = (page: Page, name: string) => page.getByRole('navigation', { name: 'Manage' }).getByRole('link', { name, exact: true });

test('the owner registers an endpoint, sees its secret once, queues a test message and removes it', async ({ page }) => {
  await signIn(page, 'owner');
  await manage(page, 'Webhooks').click();
  await expect(page.getByRole('heading', { name: 'Webhooks', level: 1 })).toBeVisible();
  await expect(page.getByText('This server sends no webhooks yet')).toBeVisible();
  await expect(page.getByText('No endpoint has been registered yet.')).toBeVisible();
  await checkScreen(page, 'webhooks');

  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Browser test receiver');
  await page.getByRole('textbox', { name: 'Address', exact: true }).fill('https://hooks.example.com/legacyai');
  await page.getByRole('checkbox', { name: /became verified/ }).check();
  await page.getByRole('button', { name: 'Register the endpoint', exact: true }).click();
  const shown = page.getByTestId('shown-once');
  await expect(shown).toBeVisible();
  const secret = (await shown.textContent()) ?? '';
  expect(secret).toMatch(/^whsec_/);
  await page.getByRole('button', { name: 'I have copied the secret', exact: true }).click();
  await expect(shown).toHaveCount(0);
  await expect(page.getByRole('cell', { name: 'Browser test receiver', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('cell', { name: 'Browser test receiver', exact: true })).toBeVisible();
  expect(await page.content()).not.toContain(secret);

  // an address inside a private network is refused by the API, and the screen says why
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Inside');
  await page.getByRole('textbox', { name: 'Address', exact: true }).fill('https://metadata.google.internal/x');
  await page.getByRole('checkbox', { name: /became verified/ }).check();
  await page.getByRole('button', { name: 'Register the endpoint', exact: true }).click();
  await expect(page.getByText(/not an internal name/)).toBeVisible();

  await page.getByRole('button', { name: 'Send a test message to Browser test receiver', exact: true }).click();
  await expect(page.getByText(/The test message is queued/)).toBeVisible();
  await page.getByRole('button', { name: 'Messages of Browser test receiver', exact: true }).click();
  await expect(page.getByText('Waiting to be sent', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Remove Browser test receiver…', exact: true }).click();
  await page.getByRole('button', { name: 'Yes, remove it for good', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'Browser test receiver', exact: true })).toHaveCount(0);
});

test('an admin has no webhooks screen', async ({ page }) => {
  await signIn(page, 'admin');
  await expect(manage(page, 'Webhooks')).toHaveCount(0);
  expect((await page.request.get('/v1/webhooks')).status()).toBe(403);
});
