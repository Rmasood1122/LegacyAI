// Billing and renewal (features 31-35) in a real browser, against the real API. The payment provider is the stand-in:
// no money moves and nothing outside the test machine is called. The test server plays the provider (it sends the
// signed message a provider would send) and moves the company's renewal date; everything else happens on the screen.
// Synthetic company only. Runs after the other files (one worker, files in name order), because it moves the
// company's term and sets a seat limit.
import { expect, test, type Page } from '@playwright/test';
import { checkScreen, keepPageTextOnFailure, providerSays, setTermEnd, signIn } from './support.ts';

test.describe.configure({ mode: 'serial' });
test.afterEach(async ({ page }, info) => keepPageTextOnFailure(page, info));

const manage = (page: Page, name: string) => page.getByRole('navigation', { name: 'Manage' }).getByRole('link', { name, exact: true });
const DAY = 86_400_000;

interface Sub {
  phase: string; expires_at: string; seats_requested: number | null; seat_limit: number | null; seats_used: number; seat_state: string;
  open_invoice: { id: string } | null; can_renew_now: boolean;
}
async function subscription(page: Page): Promise<Sub> {
  const res = await page.request.get('/v1/billing/subscription');
  expect(res.status()).toBe(200);
  return await res.json() as Sub;
}
async function renew(page: Page, invoiceNumber: number): Promise<void> {
  await page.getByRole('button', { name: 'Renew now…' }).click();
  await page.getByRole('button', { name: /^Yes, renew for 90 days/ }).click();
  await expect(page.getByText(`Invoice ${invoiceNumber} is waiting for payment`)).toBeVisible();
}

test('the owner sees the renewal center; it is too early to renew; prices are marked as placeholders', async ({ page }) => {
  await signIn(page, 'owner');
  await manage(page, 'Billing and renewal').click();
  await expect(page.getByRole('heading', { name: 'Billing and renewal', level: 1 })).toBeVisible();
  await expect(page.getByText('The subscription is running')).toBeVisible();
  await expect(page.getByText('These prices are placeholders')).toBeVisible();
  await expect(page.getByText('No invoice has been issued yet.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Renew now…' })).toHaveCount(0);
  expect(await subscription(page)).toMatchObject({ phase: 'normal', can_renew_now: false, seat_limit: null, seat_state: 'not_limited' });
  await checkScreen(page, 'billing');
});

test('renewal: a declined payment renews nothing; a paid one starts a new term', async ({ page }) => {
  await setTermEnd(5);
  await signIn(page, 'owner');
  await manage(page, 'Billing and renewal').click();
  await expect(page.getByText('Renewal is open')).toBeVisible();
  const before = await subscription(page);

  await renew(page, 1);
  expect((await subscription(page)).expires_at).toBe(before.expires_at);            // an invoice alone renews nothing
  expect(await providerSays('declined')).toEqual({ http_status: 200, status: 'applied' });
  await page.reload();
  await expect(page.getByText('Payment failed')).toBeVisible();
  expect((await subscription(page)).expires_at).toBe(before.expires_at);

  await renew(page, 2);
  expect(await providerSays('paid')).toEqual({ http_status: 200, status: 'applied' });
  await page.reload();
  await expect(page.getByText('The subscription is running')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Paid', exact: true })).toBeVisible();
  const after = await subscription(page);
  // the seats paid with the term are now the limit: exactly the cards in use
  expect(after).toMatchObject({ phase: 'normal', open_invoice: null, seat_limit: after.seats_used, seat_state: 'reached' });
  expect(new Date(after.expires_at).getTime() - new Date(before.expires_at).getTime()).toBeGreaterThan(80 * DAY);
  await checkScreen(page, 'billing-renewed');
});

test('seats: when they are used up the screen says so; asking for more is not enough - paying for them takes the notice away', async ({ page }) => {
  await signIn(page, 'owner');
  await manage(page, 'Billing and renewal').click();
  const used = (await subscription(page)).seats_used;
  await expect(page.getByText(`All ${used} seats are in use`)).toBeVisible();
  await checkScreen(page, 'billing-seats-used-up');

  await page.getByLabel('Seats', { exact: true }).fill(String(used + 50));
  await page.getByRole('button', { name: 'Change the seats…' }).click();
  await page.getByRole('button', { name: `Yes, ask for ${used + 50} seats` }).click();
  await expect(page.getByRole('button', { name: 'Pay for 50 more seats…' })).toBeVisible();
  await expect(page.getByText(`All ${used} seats are in use`)).toBeVisible();          // asked for, not paid
  expect(await subscription(page)).toMatchObject({ seats_requested: used + 50, seat_limit: used, seat_state: 'reached' });

  await page.getByRole('button', { name: 'Pay for 50 more seats…' }).click();
  await page.getByRole('button', { name: /^Yes, add 50 seats for / }).click();
  await expect(page.getByText('Invoice 3 is waiting for payment')).toBeVisible();
  expect(await providerSays('paid')).toEqual({ http_status: 200, status: 'applied' });
  await page.reload();
  await expect(page.getByText('The subscription is running')).toBeVisible();
  await expect(page.getByText(`All ${used} seats are in use`)).toHaveCount(0);
  expect(await subscription(page)).toMatchObject({ seats_requested: null, seat_limit: used + 50, seat_state: 'ok' });
});

test('billing is for the owner: a learner is offered no such screen and the API refuses', async ({ page }) => {
  await signIn(page, 'learner');
  await page.goto('/billing');
  await expect(page.getByRole('heading', { name: 'This screen is not available' })).toBeVisible();
  expect((await page.request.get('/v1/billing/subscription')).status()).toBe(403);
  expect((await page.request.get('/v1/billing/invoices')).status()).toBe(403);
});
