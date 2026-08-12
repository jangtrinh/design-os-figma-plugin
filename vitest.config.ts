import { defineConfig } from 'vitest/config';

// Pure-logic unit tests for this CLI + plugin (converter + payload builders).
// Run with: npx vitest run --config vitest.config.ts (== npm test).
export default defineConfig({
  root: import.meta.dirname,
  test: {
    include: ['tests/**/*.test.ts'],
    // Default stays vitest's own 5_000ms — a hung test anywhere in the suite fails fast.
    // tests/broker-daemon-harness.test.ts raises its OWN ceiling via `vi.setConfig`,
    // scoped to that one file, since its real-socket waits legitimately need more room.
  },
});
