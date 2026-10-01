#!/usr/bin/env node
// Prepares a database for LegacyAI: (optionally) creates it, creates the three roles,
// then applies or rolls back migrations with dbmate.
//
// Usage (from services/api, so that `pg` and `dbmate` resolve):
//   node ../../scripts/db-setup.mjs roles          create/refresh roles (needs DATABASE_URL_SUPERUSER)
//   node ../../scripts/db-setup.mjs up             apply all migrations (needs DATABASE_URL_ADMIN)
//   node ../../scripts/db-setup.mjs down           roll back the newest migration
//   node ../../scripts/db-setup.mjs down-all       roll back every migration
//   node ../../scripts/db-setup.mjs reset          drop + create the database, roles, migrations (local/CI only)
//
// Every variable is required; nothing has a default. Missing input stops the script.

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const require = createRequire(path.join(repoRoot, 'services', 'api', 'package.json'));
const pg = require('pg');

function need(name) {
  const v = process.env[name];
  if (typeof v !== 'string' || v.trim() === '') {
    console.error(`db-setup: required environment variable ${name} is missing or empty`);
    process.exit(2);
  }
  return v;
}

function passwordOf(urlVar) {
  const pw = decodeURIComponent(new URL(need(urlVar)).password);
  if (pw.length < 16) {
    console.error(`db-setup: the password inside ${urlVar} must be at least 16 characters`);
    process.exit(2);
  }
  return pw;
}

async function withClient(url, fn) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function roles() {
  const sql = readFileSync(path.join(repoRoot, 'db', 'roles', 'create-roles.sql'), 'utf8');
  // Schema grants are per database, so connect to the TARGET database (the one in
  // DATABASE_URL_ADMIN) using the superuser's credentials.
  const target = new URL(need('DATABASE_URL_SUPERUSER'));
  target.pathname = new URL(need('DATABASE_URL_ADMIN')).pathname;
  await withClient(target.toString(), async (c) => {
    await c.query('SELECT set_config($1, $2, false)', ['legacyai.migrator_password', passwordOf('DATABASE_URL_ADMIN')]);
    await c.query('SELECT set_config($1, $2, false)', ['legacyai.app_password', passwordOf('DATABASE_URL')]);
    await c.query('SELECT set_config($1, $2, false)', ['legacyai.backup_password', passwordOf('DATABASE_URL_BACKUP')]);
    await c.query(sql);
  });
  console.log('db-setup: roles ready (legacyai_migrator, legacyai_app, legacyai_backup)');
}

function dbmate(args) {
  const bin = require.resolve('dbmate/dist/cli.js');
  const url = new URL(need('DATABASE_URL_ADMIN'));
  if (!url.searchParams.has('sslmode') && ['localhost', '127.0.0.1'].includes(url.hostname)) {
    url.searchParams.set('sslmode', 'disable');
  }
  const res = spawnSync(
    process.execPath,
    [bin, '--url', url.toString(), '--migrations-dir', path.join(repoRoot, 'db', 'migrations'), '--no-dump-schema', ...args],
    { stdio: 'inherit' },
  );
  if (res.status !== 0) {
    console.error(`db-setup: dbmate ${args.join(' ')} failed`);
    process.exit(res.status ?? 1);
  }
}

async function reset() {
  const superUrl = new URL(need('DATABASE_URL_SUPERUSER'));
  const dbName = new URL(need('DATABASE_URL_ADMIN')).pathname.slice(1);
  if (!/^[a-z0-9_]+$/.test(dbName)) {
    console.error('db-setup: refusing to reset a database with an unusual name');
    process.exit(2);
  }
  if (!['localhost', '127.0.0.1', 'postgres'].includes(superUrl.hostname)) {
    console.error('db-setup: reset is only allowed against a local database');
    process.exit(2);
  }
  const maintenance = new URL(superUrl);
  maintenance.pathname = '/postgres';
  await withClient(maintenance.toString(), async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await c.query(`CREATE DATABASE ${dbName}`);
  });
  await roles();
  dbmate(['up']);
}

const cmd = process.argv[2];
if (cmd === 'roles') await roles();
else if (cmd === 'up') dbmate(['up']);
else if (cmd === 'down') dbmate(['down']);
else if (cmd === 'down-all') {
  const count = readdirSync(path.join(repoRoot, 'db', 'migrations')).filter((f) => f.endsWith('.sql')).length;
  for (let i = 0; i < count; i += 1) dbmate(['down']);
} else if (cmd === 'reset') await reset();
else {
  console.error('db-setup: expected one of: roles | up | down | down-all | reset');
  process.exit(2);
}
