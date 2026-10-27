import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Writes dist/sw.js from sw/service-worker.js with the list of the build's own files (feature 9, D42), so the
 * installed application opens without a connection. The version changes whenever any file changes, so a new build
 * replaces the kept files.
 */
function serviceWorker(): Plugin {
  return {
    name: 'legacyai-service-worker',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const publicDir = path.join(here, 'public');
      const publicFiles = readdirSync(publicDir).map((name) => ({ name, body: readFileSync(path.join(publicDir, name)) }));
      const built = Object.values(bundle).map((f) => ({ name: f.fileName, body: f.type === 'chunk' ? f.code : f.source }));
      const all = [...built, ...publicFiles].filter((f) => f.name !== 'sw.js');
      const files = [...new Set(['/index.html', ...all.map((f) => `/${f.name}`)])].sort();
      const hash = createHash('sha256');
      for (const f of [...all].sort((a, b) => a.name.localeCompare(b.name))) hash.update(f.name).update(f.body);
      const source = readFileSync(path.join(here, 'sw', 'service-worker.js'), 'utf8')
        .replace("'__LEGACYAI_VERSION__'", JSON.stringify(hash.digest('hex').slice(0, 16)))
        .replace('__LEGACYAI_FILES__', JSON.stringify(files));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

// The build is plain files served by the API service from the same address (docs/phase3).
// No source maps are shipped: the API refuses to serve file types it does not know.
export default defineConfig({
  plugins: [react(), serviceWorker()],
  build: { outDir: 'dist', sourcemap: false, assetsInlineLimit: 0, target: 'es2023' },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    restoreMocks: true,
  },
});
