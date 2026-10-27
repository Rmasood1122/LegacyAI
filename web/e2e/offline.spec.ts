// Offline reading (feature 9, decision D42) in a real browser: a copy of a job role's verified knowledge is taken while
// connected, then read and searched with the network switched off; it is kept locked in the browser's storage, it is
// refused while the device's clock is behind its last opening, and from its expiry on it is refused and removed.
// Against the real API and the AI service with the FAKE provider. Synthetic company and people only.
import { expect, test, type Page } from '@playwright/test';
import { checkScreen, keepPageTextOnFailure, SEED_TOPIC, seedReadiness, serverNow, signIn } from './support.ts';

test.afterEach(async ({ page }, info) => keepPageTextOnFailure(page, info));

const DAY = 86_400_000;
const SEEDED_TEXT = /Lift each relief valve lever monthly/;

/** The seeded item is linked to the seeded topic, as a reviewer does on the item's page (only linked items are in a copy). */
async function linkSeededItem(page: Page, itemId: string): Promise<void> {
  const session = await (await page.request.get('/v1/auth/session')).json() as { csrf_token: string };
  const topics = await (await page.request.get('/v1/topics?limit=50')).json() as { items: Array<{ id: string; name: string }> };
  const topic = topics.items.find((t) => t.name === SEED_TOPIC);
  expect(topic, 'the seeded topic').toBeDefined();
  const res = await page.request.put(`/v1/knowledge/items/${itemId}/topics`, {
    data: { topic_ids: [topic?.id] },
    headers: { 'x-csrf-token': session.csrf_token, 'idempotency-key': crypto.randomUUID(), origin: new URL(page.url()).origin },
  });
  expect(res.status(), await res.text()).toBe(200);
}

/** What the browser keeps for the copy, as any script on the page could read it. */
const storedCopy = (page: Page) => page.evaluate(async () => {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open('legacyai-offline');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const record = await new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
    const req = db.transaction('pack').objectStore('pack').get('current');
    req.onsuccess = () => resolve(req.result as Record<string, unknown> | undefined);
    req.onerror = () => reject(req.error);
  });
  db.close();
  if (record === undefined) return null;
  const key = record.key as CryptoKey;
  let exported = 'refused';
  try {
    await crypto.subtle.exportKey('raw', key);
    exported = 'exported';
  } catch {
    // a key that cannot be taken out
  }
  return { sealed: new TextDecoder().decode(record.sealed as ArrayBuffer), extractable: key.extractable, exported, expires_at: record.expires_at as string };
});

test('a copy taken while connected is read and searched without a connection, locked on the device, and refused after 7 days', async ({ page, context }) => {
  const { job_role: jobRole, item_id: itemId } = await seedReadiness();
  await signIn(page, 'owner');
  await linkSeededItem(page, itemId);
  const now = await serverNow();
  await page.clock.setFixedTime(now);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Offline', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Offline reading' })).toBeVisible();
  await expect(page.getByRole('option', { name: jobRole })).toBeAttached();
  await page.getByLabel('Job role').selectOption(jobRole);
  await page.getByRole('button', { name: 'Take a copy' }).click();
  await expect(page.getByRole('heading', { name: 'On this device' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Relief valve check' })).toBeVisible();
  await expect(page.getByText(/^As of /)).toBeVisible();
  await checkScreen(page, '60-offline');

  // locked: nothing of the content in what the browser keeps, and the key cannot be taken out
  const stored = await storedCopy(page);
  expect(stored).not.toBeNull();
  expect(stored?.sealed).not.toMatch(/relief valve/i);
  expect(stored?.extractable).toBe(false);
  expect(stored?.exported).toBe('refused');
  const expiresAt = Date.parse(stored?.expires_at ?? '');
  expect(expiresAt - now).toBeGreaterThan(7 * DAY - 10 * 60_000);
  expect(expiresAt - now).toBeLessThanOrEqual(7 * DAY + 60_000);

  // installed files ready: the page is served by the service worker from now on
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, { timeout: 15_000 });

  // no connection: the application still opens, says why, and shows the copy with its date
  await context.setOffline(true);
  await page.clock.setFixedTime(now + 3 * DAY);
  await page.reload();
  await expect(page.getByText('LegacyAI could not be reached')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Offline reading' })).toBeVisible();
  await expect(page.getByText(/^As of /)).toBeVisible();
  await page.getByLabel('Search this copy').fill('lever monthly');
  await page.getByRole('button', { name: 'Relief valve check' }).click();
  await expect(page.getByText(SEEDED_TEXT)).toBeVisible();
  await expect(page.getByText(/^As of /)).toBeVisible();
  await checkScreen(page, '61-offline-reading');

  // the clock set back behind the last opening: refused, and kept
  await page.clock.setFixedTime(now + 1 * DAY);
  await page.reload();
  await expect(page.getByText('This device\'s clock is behind')).toBeVisible();
  await expect(page.getByText(SEEDED_TEXT)).toHaveCount(0);
  expect(await storedCopy(page)).not.toBeNull();

  // from the expiry on: refused, and removed
  await page.clock.setFixedTime(expiresAt + 60_000);
  await page.reload();
  await expect(page.getByText('The copy on this device has expired')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Relief valve check' })).toHaveCount(0);
  expect(await storedCopy(page)).toBeNull();
  await context.setOffline(false);
});

test('signing out removes the copy from the device', async ({ page }) => {
  await signIn(page, 'owner');
  await page.clock.setFixedTime(await serverNow());
  const { job_role: jobRole } = await seedReadiness();
  await page.goto('/offline');
  await expect(page.getByRole('option', { name: jobRole })).toBeAttached();
  await page.getByLabel('Job role').selectOption(jobRole);
  await page.getByRole('button', { name: 'Take a copy' }).click();
  await expect(page.getByRole('heading', { name: 'On this device' })).toBeVisible();
  expect(await storedCopy(page)).not.toBeNull();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to LegacyAI' })).toBeVisible();
  await expect.poll(() => storedCopy(page)).toBeNull();
});
