// API keys for machines (feature 28) in a real browser, against the real API. The Owner makes a key on the screen;
// the "machine" is a second, cookie-less connection of the test itself to the same test server - nothing outside the
// test machine is called. Synthetic company only. Runs before the billing file (files run in name order), which
// moves the company's term.
import { expect, test, type Page } from '@playwright/test';
import { checkScreen, keepPageTextOnFailure, signIn } from './support.ts';

test.describe.configure({ mode: 'serial' });
test.afterEach(async ({ page }, info) => keepPageTextOnFailure(page, info));

const manage = (page: Page, name: string) => page.getByRole('navigation', { name: 'Manage' }).getByRole('link', { name, exact: true });

test('the owner makes a key, the key works for a machine and only for what it was given, and stops when revoked', async ({ page, request }) => {
  await signIn(page, 'owner');
  await manage(page, 'API keys').click();
  await expect(page.getByRole('heading', { name: 'API keys', level: 1 })).toBeVisible();
  await expect(page.getByText('No key has been made yet.')).toBeVisible();
  await checkScreen(page, 'api-keys');

  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Browser test machine');
  await page.getByRole('checkbox', { name: 'Read topics and job roles', exact: true }).check();
  await page.getByRole('button', { name: 'Make the key', exact: true }).click();
  const shown = page.getByTestId('shown-once');
  await expect(shown).toBeVisible();
  const key = (await shown.textContent()) ?? '';
  expect(key).toMatch(/^lak1\./);

  // the machine: no cookie, no CSRF token, only the key
  const asMachine = { headers: { authorization: `Bearer ${key}` } };
  expect((await request.get('/v1/topics', asMachine)).status()).toBe(200);
  const outside = await request.get('/v1/sources', asMachine);                     // not written into this key
  expect(outside.status()).toBe(403);
  expect(((await outside.json()) as { type: string }).type).toContain('api-key-scope');
  // keys never manage keys: the operation takes no key at all, and says so (it is no secret which operations do)
  const refused = await request.get('/v1/api-keys', asMachine);
  expect(refused.status()).toBe(403);
  expect(((await refused.json()) as { type: string }).type).toContain('api-key-not-accepted');
  expect((await request.get('/v1/topics')).status()).toBe(401);                    // and without the key: nothing

  await page.getByRole('button', { name: 'I have copied the key', exact: true }).click();
  await expect(shown).toHaveCount(0);
  await expect(page.getByRole('cell', { name: 'Browser test machine', exact: true })).toBeVisible();
  await expect(page.getByText('Working', { exact: true })).toBeVisible();
  // the key is gone from the page for good: a reload does not bring it back
  await page.reload();
  await expect(page.getByRole('cell', { name: 'Browser test machine', exact: true })).toBeVisible();
  expect(await page.content()).not.toContain(key);

  await page.getByRole('button', { name: 'Revoke Browser test machine…', exact: true }).click();
  await page.getByRole('button', { name: 'Yes, revoke it for good', exact: true }).click();
  await expect(page.getByText('Revoked', { exact: true })).toBeVisible();
  expect((await request.get('/v1/topics', asMachine)).status()).toBe(401);
});

test('an admin has no API keys screen', async ({ page }) => {
  await signIn(page, 'admin');
  await expect(page.getByRole('navigation', { name: 'Manage' }).getByRole('link', { name: 'API keys', exact: true })).toHaveCount(0);
  expect((await page.request.get('/v1/api-keys')).status()).toBe(403);
});
