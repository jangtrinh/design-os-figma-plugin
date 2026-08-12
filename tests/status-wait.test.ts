// `status --wait`'s integration: ensureBroker()+waitForPlugin()+the deep-link print
// wired together in cli/src/commands/status.ts. `ensureBroker()` (broker-discovery.ts)
// has no test-injectable path — unlike broker-peek.ts's `peek()`, it always targets the
// REAL /tmp/figma-agent-broker.json and the real 9410-9419 port range. This suite mocks
// `ensureBroker` to resolve to a REAL but SCRATCH broker (the same daemon-harness
// pattern as tests/broker-daemon-harness.test.ts / tests/status-peek.test.ts), so
// `status --wait` is exercised against a live broker without ever touching the shared
// machine's real one.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import type { CommandArgs } from '../cli/src/arg-parse.ts';

vi.mock('../cli/src/transport/broker-discovery.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../cli/src/transport/broker-discovery.ts')>();
  return { ...actual, ensureBroker: vi.fn() };
});

const { ensureBroker } = await import('../cli/src/transport/broker-discovery.ts');
const { run } = await import('../cli/src/commands/status.ts');

type BrokerDaemonModule = typeof import('../cli/src/transport/broker-daemon.ts');

let scratchDir: string;
let advertisePath: string;
let sockets: WebSocket[];

function fakeArgs(flags: Record<string, string | boolean> = {}): CommandArgs {
  return {
    positionals: [],
    str: (name) => (typeof flags[name] === 'string' ? (flags[name] as string) : undefined),
    req: (name) => {
      const v = flags[name];
      if (typeof v !== 'string') throw new Error(`missing --${name}`);
      return v;
    },
    num: (name) => (typeof flags[name] === 'string' ? Number(flags[name]) : undefined),
    bool: (name) => flags[name] === true || flags[name] === 'true',
  };
}

async function loadBrokerDaemon(): Promise<BrokerDaemonModule> {
  process.env.FIGMA_AGENT_CHANGES_DIR = scratchDir;
  process.env.FIGMA_AGENT_BINDS_FILE = join(scratchDir, 'binds.json');
  process.env.FIGMA_AGENT_UNBOUND_DIR = join(scratchDir, 'unbound-root');
  vi.resetModules();
  return import('../cli/src/transport/broker-daemon.ts');
}

function testExit(): (code: number) => never {
  return (code: number): never => {
    throw new Error(`__TEST_BROKER_EXIT__ code=${code}`);
  };
}

function connectSocket(port: number): Promise<WebSocket> {
  return new Promise((resolvePromise, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('open', () => resolvePromise(ws));
    ws.once('error', reject);
    sockets.push(ws);
  });
}

async function helloPlugin(ws: WebSocket, instanceId: string, fileName: string): Promise<void> {
  ws.send(JSON.stringify({ type: 'PLUGIN_HELLO', data: { instanceId, fileName, fileKey: null, caps: ['fileGuard'] } }));
  await new Promise<void>((resolvePromise) => {
    const handler = (raw: WebSocket.RawData): void => {
      const msg = JSON.parse(raw.toString()) as { type?: string };
      if (msg.type === 'SYNC_CONFIG') { ws.off('message', handler); resolvePromise(); }
    };
    ws.on('message', handler);
  });
  // status.ts's non-peek path enriches the ACTIVE plugin with a live STATUS round-trip
  // (runCommand('STATUS', {})) — answer any wire request frame with a plain OK so that
  // round-trip doesn't hang waiting for a reply this fake plugin never planned to send.
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString()) as { id?: unknown; cmd?: unknown };
    if (typeof msg.id === 'string' && typeof msg.cmd === 'string') {
      ws.send(JSON.stringify({ id: msg.id, ok: true, result: {} }));
    }
  });
}

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'fa-status-wait-'));
  advertisePath = join(scratchDir, 'broker.json');
  sockets = [];
});

afterEach(async () => {
  for (const ws of sockets) { try { ws.terminate(); } catch { /* already closed */ } }
  rmSync(scratchDir, { recursive: true, force: true });
  vi.mocked(ensureBroker).mockReset();
});

describe('status --wait', () => {
  it('a plugin that registers DURING the wait: exits normally with waitedMs, not a timeout', async () => {
    const mod = await loadBrokerDaemon();
    await mod.runBrokerDaemon({ advertisePath, ports: [0], exit: testExit() });
    const ad = JSON.parse(readFileSync(advertisePath, 'utf8')) as { port: number; pid: number };
    vi.mocked(ensureBroker).mockResolvedValue({ port: ad.port, pid: ad.pid, protocolV: 1, buildMtime: 0, startedAt: Date.now(), lastSeen: Date.now() });

    // Register the plugin ~200ms into the wait — proves this is a genuine POLL, not
    // a check-once-and-fail.
    setTimeout(() => { connectSocket(ad.port).then((ws) => helloPlugin(ws, 'p_1', 'My File')); }, 200);

    const result = await run(fakeArgs({ wait: true, timeout: '5' })) as { waitedMs: number; plugins: unknown[] };
    expect(result.waitedMs).toBeGreaterThan(0);
    expect(Array.isArray(result.plugins)).toBe(true);
  });

  it('nothing ever registers: throws E_NO_PLUGIN once the deadline passes, never hangs past --timeout', async () => {
    const mod = await loadBrokerDaemon();
    await mod.runBrokerDaemon({ advertisePath, ports: [0], exit: testExit() });
    const ad = JSON.parse(readFileSync(advertisePath, 'utf8')) as { port: number; pid: number };
    vi.mocked(ensureBroker).mockResolvedValue({ port: ad.port, pid: ad.pid, protocolV: 1, buildMtime: 0, startedAt: Date.now(), lastSeen: Date.now() });

    await expect(run(fakeArgs({ wait: true, timeout: '1' }))).rejects.toMatchObject({ code: 'E_NO_PLUGIN' });
  });

  it('prints a figma:// deep link to stderr BEFORE the wait when a matching binding exists', async () => {
    const mod = await loadBrokerDaemon();
    await mod.runBrokerDaemon({ advertisePath, ports: [0], exit: testExit() });
    const ad = JSON.parse(readFileSync(advertisePath, 'utf8')) as { port: number; pid: number };
    vi.mocked(ensureBroker).mockResolvedValue({ port: ad.port, pid: ad.pid, protocolV: 1, buildMtime: 0, startedAt: Date.now(), lastSeen: Date.now() });

    const projectDir = join(scratchDir, 'proj');
    mkdirSync(join(projectDir, 'design'), { recursive: true });
    writeFileSync(join(projectDir, 'design', 'figma-bind.json'), JSON.stringify({
      v: 1, bindings: [{ fileKey: 'ABC123', fileNameSlug: 'my-file', boundAt: Date.now() }],
    }));
    writeFileSync(join(scratchDir, 'binds.json'), JSON.stringify({ v: 1, projectDirs: [projectDir] }));

    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => { stderrChunks.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try {
      await expect(run(fakeArgs({ wait: true, timeout: '1', file: 'my-file' }))).rejects.toMatchObject({ code: 'E_NO_PLUGIN' });
    } finally {
      process.stderr.write = originalWrite;
    }
    expect(stderrChunks.join('')).toContain('figma://file/ABC123');
  });
});
