import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';

let scratch: string;
const listeners: { server: WebSocketServer; address: AddressInfo }[] = [];
const previousEnv = new Map<string, string | undefined>();

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'fa-observer-startup-'));
  for (const [key, leaf] of Object.entries({
    FIGMA_AGENT_BINDS_FILE: 'binds.json', FIGMA_AGENT_UNBOUND_DIR: 'unbound', FIGMA_AGENT_CHANGES_DIR: 'changes',
  })) {
    previousEnv.set(key, process.env[key]);
    process.env[key] = join(scratch, leaf);
  }
  const emit = WebSocketServer.prototype.emit;
  vi.spyOn(WebSocketServer.prototype, 'emit').mockImplementation(function (this: WebSocketServer, event, ...args) {
    if (event === 'listening') listeners.push({ server: this, address: this.address() as AddressInfo });
    return emit.call(this, event, ...args);
  });
});

afterEach(async () => {
  // The failing pre-fix case owns its leaked listeners too.
  for (const { server } of listeners) {
    for (const client of server.clients) client.terminate();
    if (server.address()) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  listeners.length = 0;
  vi.restoreAllMocks();
  for (const [key, value] of previousEnv) value === undefined ? delete process.env[key] : process.env[key] = value;
  previousEnv.clear();
  rmSync(scratch, { recursive: true, force: true });
});

it('releases every acquired listener before rejecting observer registration with the original error', async () => {
  vi.resetModules();
  const { runBrokerDaemon } = await import('../cli/src/transport/broker-daemon.ts');
  const original = new Error('owned diagnostics registration refusal');
  const signals = ['SIGTERM', 'SIGINT', 'uncaughtException'] as const;
  const signalCounts = signals.map((signal) => process.listenerCount(signal));
  const intervals = vi.spyOn(globalThis, 'setInterval');
  const advertisePath = join(scratch, 'broker.json');
  await expect(runBrokerDaemon({
    advertisePath, mutationGatePath: join(scratch, 'gates.json'), ports: [0], logFile: join(scratch, 'broker.log'),
    exit: (code): never => { throw new Error(`unexpected exit ${code}`); },
    resourceObserver: (getSnapshot) => {
      expect(getSnapshot().jobTable.jobCount).toBe(0);
      throw original;
    },
  })).rejects.toBe(original);
  expect(listeners.length).toBeGreaterThanOrEqual(1);
  expect(listeners.every(({ server }) => server.address() === null)).toBe(true);
  expect(existsSync(advertisePath)).toBe(false);
  expect(intervals).not.toHaveBeenCalled();
  expect(signals.map((signal) => process.listenerCount(signal))).toEqual(signalCounts);
  for (const { address } of listeners) {
    const probe = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        probe.once('error', reject);
        probe.listen(address.port, address.address, () => resolve());
      });
    } finally {
      if (probe.listening) await new Promise<void>((resolve) => probe.close(() => resolve()));
    }
  }
});
