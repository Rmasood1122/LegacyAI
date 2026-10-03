#!/usr/bin/env node
// Prepares a database for LegacyAI: (optionally) creates it, creates the four roles,
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
    await c.query('SELECT set_config($1, $2, false)', ['legacyai.ai_password', passwordOf('DATABASE_URL_AI')]);
    await c.query(sql);
  });
  console.log('db-setup: roles ready (legacyai_migrator, legacyai_app, legacyai_backup, legacyai_ai) and the vector extension');
}

// ---------------------------------------------------------------------------
// Migrations. The files are in dbmate format ("-- migrate:up" / "-- migrate:down").
// dbmate itself is used when its binary can run (CI, Linux, Docker). On machines where
// the operating system refuses to execute the downloaded binary (seen on Windows with
// endpoint protection: EPERM), the small built-in runner below applies the SAME files
// with the SAME bookkeeping table, so nothing else changes.
// Set MIGRATION_ENGINE=dbmate or MIGRATION_ENGINE=builtin to force one.

const migrationsDir = path.join(repoRoot, 'db', 'migrations');

function dbmateBinary() {
  try {
    const { resolveBinary } = require('dbmate/dist/resolveBinary.js');
    return resolveBinary();
  } catch {
    return null;
  }
}

/** Returns true if dbmate ran (and exits the process if it ran and failed); false if it could not be started. */
function tryDbmate(args) {
  const bin = dbmateBinary();
  if (bin === null) return false;
  const url = new URL(need('DATABASE_URL_ADMIN'));
  if (!url.searchParams.has('sslmode') && ['localhost', '127.0.0.1'].includes(url.hostname)) {
    url.searchParams.set('sslmode', 'disable');
  }
  const res = spawnSync(bin, ['--url', url.toString(), '--migrations-dir', migrationsDir, '--no-dump-schema', ...args], { stdio: 'inherit' });
  if (res.signal) {
    console.error(`db-setup: dbmate was killed by ${res.signal}`);
    process.exit(1);
  }
  if (res.error || res.status === null) return false; // could not be executed at all
  if (res.status !== 0) {
    console.error(`db-setup: dbmate ${args.join(' ')} failed`);
    process.exit(res.status);
  }
  return true;
}

function readMigrations() {
  return readdirSync(migrationsDir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort().map((file) => {
    const text = readFileSync(path.join(migrationsDir, file), 'utf8');
    const up = text.indexOf('-- migrate:up');
    const down = text.indexOf('-- migrate:down');
    if (up === -1 || down === -1 || down < up) {
      console.error(`db-setup: ${file} must contain "-- migrate:up" followed by "-- migrate:down"`);
      process.exit(2);
    }
    return { file, version: file.split('_')[0], up: text.slice(up, down), down: text.slice(down) };
  });
}

async function builtin(direction) {
  await withClient(need('DATABASE_URL_ADMIN'), async (c) => {
    // One runner at a time (held until this connection closes).
    await c.query('SELECT pg_advisory_lock(721402)');
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (version varchar PRIMARY KEY)');
    const applied = new Set((await c.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
    const all = readMigrations();
    const run = async (m, sql, record) => {
      const started = Date.now();
      await c.query('BEGIN');
      try {
        await c.query(sql);
        await c.query(record, [m.version]);
        await c.query('COMMIT');
      } catch (err) {
        await c.query('ROLLBACK');
        console.error(`db-setup: ${m.file} failed: ${err.message}`);
        process.exit(1);
      }
      return Date.now() - started;
    };
    if (direction === 'up') {
      for (const m of all.filter((x) => !applied.has(x.version))) {
        console.log(`Applying: ${m.file}`);
        console.log(`Applied: ${m.file} in ${await run(m, m.up, 'INSERT INTO schema_migrations (version) VALUES ($1)')}ms`);
      }
    } else {
      const last = all.filter((x) => applied.has(x.version)).pop();
      if (!last) {
        console.log('db-setup: nothing to roll back');
        return;
      }
      console.log(`Rolling back: ${last.file}`);
      console.log(`Rolled back: ${last.file} in ${await run(last, last.down, 'DELETE FROM schema_migrations WHERE version = $1')}ms`);
    }
  });
}

let announced = false;
async function migrate(direction) {
  const engine = process.env.MIGRATION_ENGINE ?? 'auto';
  if (engine !== 'auto' && engine !== 'dbmate' && engine !== 'builtin') {
    console.error('db-setup: MIGRATION_ENGINE must be auto, dbmate or builtin');
    process.exit(2);
  }
  // dbmate "migrate" / "rollback" (not "up"): the database already exists and the migrator may not create one.
  if (engine !== 'builtin' && tryDbmate([direction === 'up' ? 'migrate' : 'rollback'])) return;
  if (engine === 'dbmate') {
    console.error('db-setup: MIGRATION_ENGINE=dbmate but the dbmate binary could not be executed');
    process.exit(1);
  }
  if (!announced && engine === 'auto') {
    console.log('db-setup: dbmate could not be executed on this machine; using the built-in runner (same files, same table)');
    announced = true;
  }
  await builtin(direction);
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
  await migrate('up');
}

const cmd = process.argv[2];
if (cmd === 'roles') await roles();
else if (cmd === 'up') await migrate('up');
else if (cmd === 'down') await migrate('down');
else if (cmd === 'down-all') {
  const count = readMigrations().length;
  for (let i = 0; i < count; i += 1) await migrate('down');
} else if (cmd === 'reset') await reset();
else if (cmd === 'engine') {
  // Prints which migration engine can run on this machine. Used by the CI migration check.
  const bin = dbmateBinary();
  const probe = bin === null ? null : spawnSync(bin, ['--version'], { encoding: 'utf8' });
  console.log(probe && !probe.error && probe.status === 0 ? 'dbmate' : 'builtin');
}
else {
  console.error('db-setup: expected one of: roles | up | down | down-all | reset | engine');
  process.exit(2);
}
