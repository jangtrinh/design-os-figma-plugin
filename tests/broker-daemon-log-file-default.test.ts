// The log path is injectable so a test broker never appends to the shared /tmp log a
// live dev session reads — this is the one remaining shared real resource
// `BrokerDaemonOptions` did not already inject (advertisePath/ports/exit were).
//
// `node:fs`'s ESM namespace exports are not configurable (vi.spyOn can't touch them
// directly), so the wrap is wired through vi.mock + vi.hoisted, same convention as
// broker-advertisement-atomic.test.ts. Unlike that file, this wrapper does NOT call
// through to the real `appendFileSync` when the target path is the real shared
// default (`/tmp/figma-agent-broker.log`) — this file must never actually write to
// that path, on THIS machine, even to prove a regression. Every other path (this
// test's own scratch log) calls through to the real filesystem normally.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_LOG_FILE = '/tmp/figma-agent-broker.log';

const fsSpies = vi.hoisted(() => ({
  appendFileSync: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    appendFileSync: (...args: Parameters<typeof actual.appendFileSync>) => {
      fsSpies.appendFileSync(...args);
      const [path] = args;
      if (path === DEFAULT_LOG_FILE) return; // never actually write the shared default
      return actual.appendFileSync(...args);
    },
  };
});

function testExit(): (code: number) => never {
  return (code: number): never => {
    throw new Error(`__TEST_BROKER_EXIT__ code=${code}`);
  };
}

let scratchDir: string;

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'fa-broker-log-default-'));
  fsSpies.appendFileSync.mockClear();
});

afterEach(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

describe('runBrokerDaemon — log file default resolution', () => {
  it('omitting `logFile` still resolves to the real shared default path', async () => {
    vi.resetModules();
    const { runBrokerDaemon } = await import('../cli/src/transport/broker-daemon.ts');
    await runBrokerDaemon({
      advertisePath: join(scratchDir, 'broker.json'),
      ports: [0],
      exit: testExit(),
      // logFile intentionally omitted — production behavior must be byte-unchanged.
    });
    const paths = fsSpies.appendFileSync.mock.calls.map((call) => call[0]);
    expect(paths).toContain(DEFAULT_LOG_FILE);
  });

  it('an injected `logFile` receives every write; the default path is never appended to', async () => {
    vi.resetModules();
    const { runBrokerDaemon } = await import('../cli/src/transport/broker-daemon.ts');
    const scratchLogFile = join(scratchDir, 'broker.log');
    await runBrokerDaemon({
      advertisePath: join(scratchDir, 'broker.json'),
      ports: [0],
      exit: testExit(),
      logFile: scratchLogFile,
    });
    const paths = fsSpies.appendFileSync.mock.calls.map((call) => call[0]);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every((p) => p === scratchLogFile)).toBe(true);
    expect(paths).not.toContain(DEFAULT_LOG_FILE);
  });
});
