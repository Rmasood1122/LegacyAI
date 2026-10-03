#!/usr/bin/env node
// Fails if a dependency in services/api/package.json or services/ai/requirements*.txt is
// not recorded (name AND exact version) in docs/DEPENDENCIES.md. Keeps the "verify before
// choosing" record honest: nothing gets added or bumped without being written down.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const doc = readFileSync(path.join(root, 'docs', 'DEPENDENCIES.md'), 'utf8');
const pkg = JSON.parse(readFileSync(path.join(root, 'services', 'api', 'package.json'), 'utf8'));
const lines = doc.split('\n');
// Name and exact version must appear on the SAME line (table row) of the record.
const recorded = (name, version) => lines.some((l) => (l.includes(`| ${name} |`) || l.includes(`\`${name}\``) || l.toLowerCase().includes(`| ${name.toLowerCase()} `)) && l.includes(version));
const missing = [];
let checked = 0;

for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
  checked += 1;
  if (!/^\d+\.\d+\.\d+$/.test(version)) missing.push(`${name}: version "${version}" is not pinned exactly`);
  else if (!recorded(name, version)) missing.push(`${name}@${version}`);
}
for (const file of ['requirements.txt', 'requirements-dev.txt']) {
  for (const line of readFileSync(path.join(root, 'services', 'ai', file), 'utf8').split('\n')) {
    const t = line.trim();
    if (t === '' || t.startsWith('#') || t.startsWith('-r ')) continue;
    // A direct wheel link counts as pinned when the URL names one exact version of that package.
    const m = /^([A-Za-z0-9_.-]+)==([0-9][^\s#]*)/.exec(t)
      ?? /^([A-Za-z0-9_.-]+) @ https:\/\/\S+\/\1-([0-9][0-9.]*)-py3-none-any\.whl$/.exec(t);
    if (!m) {
      missing.push(`${file}: "${t}" is not pinned with ==`);
      continue;
    }
    checked += 1;
    if (!recorded(m[1], m[2])) missing.push(`${m[1]}==${m[2]}`);
  }
}

if (checked < 20) {
  console.error(`dependencies-doc: only ${checked} dependencies found - the check itself looks broken`);
  process.exit(1);
}
if (missing.length > 0) {
  console.error(`dependencies-doc: FAIL - not recorded in docs/DEPENDENCIES.md:\n- ${missing.join('\n- ')}`);
  process.exit(1);
}
console.log(`dependencies-doc: PASS (${checked} dependencies, all recorded with their exact version)`);
