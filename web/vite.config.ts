import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The build is plain files served by the API service from the same address (docs/phase3).
// No source maps are shipped: the API refuses to serve file types it does not know.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: false, assetsInlineLimit: 0, target: 'es2023' },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    restoreMocks: true,
  },
});
