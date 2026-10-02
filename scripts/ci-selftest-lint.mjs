#!/usr/bin/env node
// "Seen it fire" for the lint and module-boundary rules: writes deliberately bad files,
// checks that each rule rejects them, then removes them. Run from services/api.
// A rule that never fires protects nothing.
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32' });
const failures = [];
const expect = (name, output, needle) => {
  if (!output.includes(needle)) failures.push(`${name}: expected the rule to report "${needle}"`);
  else console.log(`lint-selftest: fired - ${name}`);
};

mkdirSync('src/zz-selftest', { recursive: true });
try {
  writeFileSync('src/zz-selftest/bad.ts', [
    "import type { Tx } from '../modules/platform/index.ts';",
    'export async function bad(tx: Tx, name: string, app: { get: (p: string, h: () => number) => void }): Promise<void> {',
    "  await tx.query(`SELECT * FROM people WHERE display_name = '${name}'`);",
    "  await tx.query('SELECT * FROM people WHERE display_name = ' + name);",
    "  app.get('/rogue', () => Math.random());",
    '}',
    '',
  ].join('\n'));
  const eslint = run('npx', ['eslint', 'src/zz-selftest']);
  const out = eslint.stdout + eslint.stderr;
  if (eslint.status === 0) failures.push('eslint accepted the bad file');
  expect('SQL interpolation', out, 'do not interpolate values into a query');
  expect('SQL concatenation', out, 'do not build a query by concatenation');
  expect('route registered outside defineRoutes', out, 'Register routes with defineRoutes()');
  expect('Math.random', out, 'Math.random is not cryptographically secure');
} finally {
  rmSync('src/zz-selftest', { recursive: true, force: true });
}

const boundaryFile = 'src/modules/platform/internal/zz-selftest.ts';
const internalsFile = 'src/modules/billing/zz-selftest.ts';
try {
  writeFileSync(boundaryFile, "import { decide } from '../../identity-access/index.ts';\nexport const x = decide;\n");
  writeFileSync(internalsFile, "import { writeAudit } from '../platform/internal/audit.ts';\nexport const y = writeAudit;\n");
  const dc = run('npx', ['depcruise', 'src', '--config', '.dependency-cruiser.cjs']);
  const out = dc.stdout + dc.stderr;
  if (dc.status === 0) failures.push('dependency-cruiser accepted the boundary violations');
  expect('platform importing another module', out, 'platform-is-the-base-layer');
  expect("importing another module's internals", out, 'no-cross-module-internals');
} finally {
  rmSync(boundaryFile, { force: true });
  rmSync(internalsFile, { force: true });
}

if (failures.length > 0) {
  console.error(`lint-selftest: FAIL\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('lint-selftest: PASS (6 rules seen firing)');
