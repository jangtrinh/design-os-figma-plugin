import { defineConfig } from 'vitest/config';

// Pure-logic unit tests for this CLI + plugin (converter + payload builders).
// Run with: npx vitest run --config vitest.config.ts (== npm test).
export default defineConfig({
  root: import.meta.dirname,
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
