// Unit tests only: no database, no Docker. `npm run test:unit`
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    testTimeout: 60_000,
  },
});
