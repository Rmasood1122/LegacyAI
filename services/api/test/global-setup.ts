// Runs once before the test suite: rebuilds the test database from nothing
// (roles script + every migration), exactly as a fresh install would.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DB_URLS } from './helpers/env.ts';

export default function setup(): void {
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'db-setup.mjs');
  const res = spawnSync(process.execPath, [script, 'reset'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      DATABASE_URL_SUPERUSER: DB_URLS.superuser,
      DATABASE_URL_ADMIN: DB_URLS.admin,
      DATABASE_URL: DB_URLS.app,
      DATABASE_URL_BACKUP: DB_URLS.backup,
      DATABASE_URL_AI: DB_URLS.ai,
    },
  });
  if (res.status !== 0) throw new Error('could not prepare the test database (is `docker compose up -d` running?)');
}
