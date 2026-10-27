#!/usr/bin/env node
// After `npm run build`: the built page must fit the strict browser policy the API sends with it
// (no inline script, no inline style, nothing loaded from another site) and contain only file types
// the API serves. Fails the build otherwise.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const served = new Set(['.html', '.js', '.css', '.svg', '.png', '.ico', '.woff2', '.json', '.webmanifest', '.txt']);
const problems = [];
const files = readdirSync(dist, { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
for (const f of files) if (!served.has(path.extname(f.name).toLowerCase())) problems.push(`file type the API does not serve: ${f.name}`);

const html = readFileSync(path.join(dist, 'index.html'), 'utf8');
for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  if (!/\bsrc=/.test(m[1]) || m[2].trim() !== '') problems.push('index.html has an inline script');
}
if (/<style\b/i.test(html) || /\sstyle=/i.test(html)) problems.push('index.html has an inline style');
if (/\son[a-z]+=/i.test(html)) problems.push('index.html has an inline event handler');
for (const m of html.matchAll(/\b(?:src|href)="([^"]+)"/gi)) if (!m[1].startsWith('/') || m[1].startsWith('//')) problems.push(`index.html loads something that is not from this site: ${m[1]}`);
for (const f of files.filter((e) => e.name.endsWith('.js'))) {
  const text = readFileSync(path.join(f.parentPath, f.name), 'utf8');
  if (/\b(localStorage|sessionStorage)\b/.test(text)) problems.push(`${f.name} mentions browser storage`);
}

// The service worker (feature 9, D42) keeps only the application's own files, never anything under /v1.
const sw = readFileSync(path.join(dist, 'sw.js'), 'utf8');
const kept = JSON.parse(/const FILES = (\[[^\]]*\]);/.exec(sw)?.[1] ?? 'null');
if (!Array.isArray(kept) || kept.length === 0) problems.push('sw.js has no list of files to keep');
else for (const f of kept) if (typeof f !== 'string' || !f.startsWith('/') || f.startsWith('/v1')) problems.push(`sw.js would keep something that is not the application's own file: ${f}`);
if (!sw.includes("url.pathname.startsWith('/v1/')")) problems.push('sw.js does not leave /v1 to the network');

if (problems.length > 0) {
  console.error(`web-build: FAIL\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`web-build: PASS (${files.length} files; no inline script or style, nothing from another site, no browser storage in the scripts; the service worker keeps ${kept.length} of the application's own files and nothing under /v1)`);
