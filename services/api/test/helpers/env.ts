// Test configuration. Every value here is FAKE and exists only for the throwaway local /
// CI database started by docker-compose.yml. None of it is used anywhere real.
const fakeKey = (seed: string): string => Buffer.from(seed.repeat(8).slice(0, 32)).toString('base64');

const host = process.env.TEST_PG_HOST ?? '127.0.0.1';
const port = process.env.TEST_PG_PORT ?? '55432';
const superPassword = process.env.TEST_PG_SUPERUSER_PASSWORD ?? 'local-dev-only-not-a-secret';

export const TEST_DB = 'legacyai_test';
export const TEST_ORIGIN = 'https://app.legacyai.test';
export const TEST_RP_ID = 'app.legacyai.test';

export const DB_URLS = {
  superuser: `postgres://postgres:${superPassword}@${host}:${port}/${TEST_DB}`,
  superuserMaintenance: `postgres://postgres:${superPassword}@${host}:${port}/postgres`,
  admin: `postgres://legacyai_migrator:local-test-migrator-password@${host}:${port}/${TEST_DB}`,
  app: `postgres://legacyai_app:local-test-app-password@${host}:${port}/${TEST_DB}`,
  backup: `postgres://legacyai_backup:local-test-backup-password@${host}:${port}/${TEST_DB}`,
  ai: `postgres://legacyai_ai:local-test-ai-svc-password@${host}:${port}/${TEST_DB}`,
};

export const PEPPER_V1 = fakeKey('pepper-one-');
export const PEPPER_V2 = fakeKey('pepper-two-');

export function testEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'info',
    DATABASE_URL: DB_URLS.app,
    SC_PEPPER_KEYRING: JSON.stringify({ current: 'v1', keys: { v1: PEPPER_V1 } }),
    CREDENTIAL_ENC_KEYRING: JSON.stringify({ current: 'k1', keys: { k1: fakeKey('totp-enc-') } }),
    HMAC_INDEX_KEY: fakeKey('hmac-index-'),
    SERVICE_TOKEN_KEY: 'test-service-token-key-0123456789abcdef',
    // Nothing listens here; tests that need the AI service start a stand-in and override this.
    AI_SERVICE_URL: 'http://127.0.0.1:9',
    WEBAUTHN_RP_ID: TEST_RP_ID,
    WEBAUTHN_RP_NAME: 'LegacyAI Test',
    ALLOWED_ORIGINS: TEST_ORIGIN,
    VALIDATE_RESPONSES: 'true',
    EXPORT_DIR: process.env.TEST_EXPORT_DIR ?? './.test-exports',
    ...overrides,
  };
}
