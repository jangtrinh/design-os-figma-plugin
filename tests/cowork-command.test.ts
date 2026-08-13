// `figma-agent cowork`'s CLI boundary — `run()`'s own passthrough of the broker's
// COWORK reply into the CLI's JSON output. `runCommand` (the broker round trip) is
// mocked so this never needs a live broker/plugin; the harness-level proof that the
// broker itself computes `timeoutCappedMs` correctly lives in cowork-harness.test.ts.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../cli/src/transport/broker-client.ts', () => ({ runCommand: vi.fn() }));

import { run } from '../cli/src/commands/cowork.ts';
import { runCommand } from '../cli/src/transport/broker-client.ts';
import { parseArgs } from '../cli/src/arg-parse.ts';

function mockCoworkWire(coworkResult: Record<string, unknown>): void {
  const mocked = vi.mocked(runCommand);
  mocked.mockClear();
  mocked.mockImplementation(async (cmd: string) => {
    if (cmd === 'COWORK') {
      return { cycles: 1, quietMs: 100, waitedMs: 100, file: 'F', edits: [], ...coworkResult };
    }
    if (cmd === 'GET_CORRECTION_MEMORY') return { events: [] };
    throw new Error(`unexpected cmd ${cmd}`);
  });
}

describe('cowork run() — timeoutCappedMs passthrough from the broker reply', () => {
  it('the broker reply carrying timeoutCappedMs → the CLI output carries it too', async () => {
    mockCoworkWire({ timeoutCappedMs: 1_800_000 });
    const out = await run(parseArgs([])) as { timeoutCappedMs?: number };
    expect(out.timeoutCappedMs).toBe(1_800_000);
  });

  it('the broker reply omitting timeoutCappedMs → the CLI output omits it entirely, never a stray key', async () => {
    mockCoworkWire({});
    const out = await run(parseArgs([]));
    expect('timeoutCappedMs' in (out as object)).toBe(false);
  });
});
