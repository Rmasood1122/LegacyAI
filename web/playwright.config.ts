// Browser tests against the REAL API serving the built application (CI job "Web - browser tests").
// The server is started by the CI job (services/api/test/e2e/server.ts); nothing is started here.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  // One company, shared by the tests, which build on each other (write -> submit -> verify).
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8787',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // Every file in Chromium. Offline reading (D42) also in Firefox and WebKit (Safari's engine, as Playwright builds it for
  // Linux), after Chromium, so the files that build on each other keep their order - there only the test that needs no
  // sign-in (founder's choice, 2026-10-27): Playwright's Firefox sometimes lost the first page load or click of a new
  // window (measured: 1 sign-in in 60 in an unrelated test; a retry did not help), and WebKit cannot sign in to the
  // plain-http test server at all. Signing in, taking a copy and the installed application offline are tested in Chromium.
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] }, testMatch: /offline\.spec\.ts$/, grep: /a copy already on the device/, dependencies: ['chromium'] },
    { name: 'webkit', use: { ...devices['Desktop Safari'] }, testMatch: /offline\.spec\.ts$/, grep: /a copy already on the device/, dependencies: ['chromium'] },
  ],
});
