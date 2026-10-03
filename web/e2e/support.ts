// Helpers for the browser tests: signing in through the real sign-in screen, and the two checks
// every screen gets (an automated accessibility scan and a saved screenshot).
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

const CONTROL = process.env.E2E_CONTROL_URL ?? 'http://127.0.0.1:8788';
export type Persona = 'owner' | 'author' | 'reviewer' | 'learner';

async function control<T>(path: string): Promise<T> {
  const res = await fetch(`${CONTROL}${path}`);
  if (!res.ok) throw new Error(`control ${path}: ${res.status} ${await res.text()}`);
  return await res.json() as T;
}

export const credentials = (persona: Persona) => control<{ card_number: string; sc: string; code: string }>(`/credentials?persona=${persona}`);
export const newCard = () => control<{ card_number: string; sc: string; enrollment_token: string }>('/new-card');
export const codeFor = async (secret: string): Promise<string> => (await control<{ code: string }>(`/code?secret=${encodeURIComponent(secret)}`)).code;

/** Signs in the way a person does: card number, 3-digit code, authenticator-app code. */
export async function signIn(page: Page, persona: Persona): Promise<void> {
  const c = await credentials(persona);
  await page.goto('/');
  await page.getByLabel('Card number').fill(c.card_number);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('3-digit code').fill(c.sc);
  await page.getByLabel('Code from your authenticator app').fill(c.code);
  await page.getByRole('button', { name: 'Sign in with the app code' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}

/**
 * Automated accessibility scan (axe-core, WCAG 2.1 A and AA rules) plus a screenshot.
 * An automated scan finds only part of the possible problems; it is not a test with real users.
 */
export async function checkScreen(page: Page, name: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const problems = results.violations.map((v) => `${v.id} (${v.impact ?? 'n/a'}): ${v.nodes.length} element(s) - ${v.help}`);
  expect(problems, `accessibility problems on "${name}"`).toEqual([]);
  await page.screenshot({ path: `e2e-artifacts/screens/${name}.png`, fullPage: true });
}

/** The session as the API reports it for the signed-in page. */
export async function sessionPermissions(page: Page): Promise<string[]> {
  const res = await page.request.get('/v1/auth/session');
  expect(res.status()).toBe(200);
  return ((await res.json()) as { permissions: string[] }).permissions;
}
