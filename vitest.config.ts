import { defineConfig } from 'vitest/config';

// Pure-logic unit tests for this CLI + plugin (converter + payload builders).
// Run with: npx vitest run --config vitest.config.ts (== npm test).
export default defineConfig({
  root: import.meta.dirname,
  test: {
    include: ['tests/**/*.test.ts'],
    // Issue #59 — vitest's own 5_000ms default per-test timeout was shorter than
    // tests/broker-daemon-harness.test.ts's real-socket waitFor deadline needs under
    // machine load (a real in-process broker + real `ws` sockets, not a simulation);
    // vitest killed the test with a generic "Test timed out" before the harness's own
    // waitFor could report its own honest error. 12s gives that a real chance to fire
    // cleanly without slowing the many pure-function tests that finish in milliseconds.
    testTimeout: 30_000,
  },
});
