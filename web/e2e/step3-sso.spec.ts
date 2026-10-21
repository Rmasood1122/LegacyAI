// The company's own sign-in (SSO, feature 16) in a real browser, against the real API: the Owner's connection screen.
// A whole sign-in through a provider needs the browser to reach that provider; it is tested against a stand-in
// provider in services/api/test/integration/sso.test.ts (and the screens of it in web/src/features/sso.test.tsx).
// Synthetic company only; the client secret below is a made-up word.
import { expect, test, type Page } from '@playwright/test';
import { checkScreen, keepPageTextOnFailure, signIn } from './support.ts';

test.describe.configure({ mode: 'serial' });
test.afterEach(async ({ page }, info) => keepPageTextOnFailure(page, info));

const manage = (page: Page, name: string) => page.getByRole('navigation', { name: 'Manage' }).getByRole('link', { name, exact: true });
const SECRET = ['browser', 'test', 'client', 'secret'].join('-');

test('the owner connects a provider, the secret is never shown again, and removes the connection', async ({ page }) => {
  await signIn(page, 'owner');
  await manage(page, 'Company sign-in').click();
  await expect(page.getByRole('heading', { name: 'Company sign-in', level: 1 })).toBeVisible();
  await expect(page.getByTestId('redirect-uri')).toContainText('/sso/return');
  await checkScreen(page, 'company-sign-in');

  await page.getByLabel('Provider (issuer)').fill('https://idp.example.com');
  await page.getByLabel('Client id', { exact: true }).fill('legacyai-browser-test');
  await page.getByLabel('Client secret', { exact: true }).fill(SECRET);
  await page.getByLabel(/Switched on/).check();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Stored (never shown)')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Stored (never shown)')).toBeVisible();
  expect(await page.content()).not.toContain(SECRET);

  await page.getByRole('button', { name: 'Remove the company sign-in…', exact: true }).click();
  await page.getByRole('button', { name: 'Yes, remove it for good', exact: true }).click();
  await expect(page.getByText(/no longer sign anyone in/)).toBeVisible();
});

test('an admin has no company sign-in screen', async ({ page }) => {
  await signIn(page, 'admin');
  await expect(manage(page, 'Company sign-in')).toHaveCount(0);
  expect((await page.request.get('/v1/sso/connection')).status()).toBe(403);
});
