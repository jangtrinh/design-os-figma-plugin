// Pre-dispatch plugin admission (backlog group 6, item 1): a mutating command must wait for
// the plugin to register before it is sent, instead of collecting the broker's
// E_FILE_KEY_UNAVAILABLE ("a disconnected mutation requires an exact raw targetFileKey")
// the moment the first call after an idle flap lands. Two layers: the pure decision + the
// bounded wait (injected hello reader), and `runCommand` end to end against a REAL scratch
// broker (the status-wait.test.ts pattern — `ensureBroker` mocked to the scratch port) with
// a fake plugin that registers only AFTER the mutation was issued.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { mutationGatePathFor } from '../cli/src/transport/mutation-admission-gate.ts';
import { BROKER_SAFE_READ_COMMANDS, MUTATING_COMMANDS } from '../shared/mutating-commands.ts';
import { BROKER_TERMINAL_COMMANDS } from '../shared/protocol.ts';

vi.mock('../cli/src/transport/broker-discovery.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../cli/src/transport/broker-discovery.ts')>();
  return { ...actual, ensureBroker: vi.fn() };
});

const { ensureBroker } = await import('../cli/src/transport/broker-discovery.ts');
const { runCommand, setNoWait } = await import('../cli/src/transport/broker-client.ts');
const { awaitPluginAdmission, needsPluginAdmission, PLUGIN_ADMISSION_WAIT_SECONDS } =
  await import('../cli/src/transport/plugin-admission.ts');

type BrokerDaemonModule = typeof import('../cli/src/transport/broker-daemon.ts');

let scratchDir: string;
let advertisePath: string;
let sockets: WebSocket[];
let priorPluginWaitMs: string | undefined;
let brokerPort: number | null = null;

async function loadBrokerDaemon(env: Record<string, string> = {}): Promise<BrokerDaemonModule> {
  process.env.FIGMA_AGENT_CHANGES_DIR = scratchDir;
  process.env.FIGMA_AGENT_BINDS_FILE = join(scratchDir, 'binds.json');
  process.env.FIGMA_AGENT_UNBOUND_DIR = join(scratchDir, 'unbound-root');
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  vi.resetModules();
  return import('../cli/src/transport/broker-daemon.ts');
}

function testExit(): (code: number) => never {
  return (code: number): never => {
    throw new Error(`__TEST_BROKER_EXIT__ code=${code}`);
  };
}

async function startScratchBroker(): Promise<number> {
  const mod = await loadBrokerDaemon({ FIGMA_AGENT_PLUGIN_WAIT_MS: '40' });
  await mod.runBrokerDaemon({ advertisePath, ports: [0], exit: testExit(), logFile: join(scratchDir, 'broker.log') });
  const ad = JSON.parse(readFileSync(advertisePath, 'utf8')) as { port: number; pid: number };
  expect(ad.pid).toBe(process.pid);
  brokerPort = ad.port;
  vi.mocked(ensureBroker).mockResolvedValue({
    port: ad.port, pid: ad.pid, protocolV: 1, buildMtime: 0, startedAt: Date.now(), lastSeen: Date.now(),
  });
  return ad.port;
}

function connectSocket(port: number): Promise<WebSocket> {
  return new Promise((resolvePromise, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('open', () => resolvePromise(ws));
    ws.once('error', reject);
    sockets.push(ws);
  });
}

/** A fake plugin that registers under `fileName`/`fileKey` and answers every relayed
 *  request with `{ok:true, result:{answeredCmd}}` so the CLI side sees the round-trip. */
async function connectFakePlugin(port: number, fileName: string, fileKey: string): Promise<{ seen: string[] }> {
  const ws = await connectSocket(port);
  const seen: string[] = [];
  const registered = new Promise<void>((resolvePromise) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as { type?: string; id?: unknown; cmd?: unknown };
      if (msg.type === 'SYNC_CONFIG') resolvePromise();
      if (typeof msg.id === 'string' && typeof msg.cmd === 'string') {
        seen.push(msg.cmd);
        ws.send(JSON.stringify({ id: msg.id, ok: true, result: { answeredCmd: msg.cmd } }));
      }
    });
  });
  ws.send(JSON.stringify({ type: 'PLUGIN_HELLO', data: { instanceId: `p_${fileKey}`, fileName, fileKey, caps: ['fileGuard'] } }));
  await registered;
  return { seen };
}

beforeEach(() => {
  priorPluginWaitMs = process.env.FIGMA_AGENT_PLUGIN_WAIT_MS;
  scratchDir = mkdtempSync(join(tmpdir(), 'fa-plugin-admission-'));
  advertisePath = join(scratchDir, 'broker.json');
  sockets = [];
  setNoWait(false);
});

afterEach(async () => {
  if (brokerPort !== null) {
    // Ask the scratch broker to exit through its own shutdown path (a throwing `exit`
    // stub, caught inside the daemon) so no in-process listener outlives this test.
    const ws = await connectSocket(brokerPort).catch(() => null);
    if (ws) {
      try { ws.send(JSON.stringify({ type: 'BROKER_SHUTDOWN_REQUEST' })); } catch { /* closed */ }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
    brokerPort = null;
  }
  for (const ws of sockets) { try { ws.terminate(); } catch { /* closed */ } }
  rmSync(scratchDir, { recursive: true, force: true });
  vi.mocked(ensureBroker).mockReset();
  setNoWait(false);
  if (priorPluginWaitMs === undefined) delete process.env.FIGMA_AGENT_PLUGIN_WAIT_MS;
  else process.env.FIGMA_AGENT_PLUGIN_WAIT_MS = priorPluginWaitMs;
});

describe('needsPluginAdmission — which requests wait for a plugin before dispatch', () => {
  it('every mutating command waits; EXEC_JS, BATCH and AUDIT_DS (broker-classified mutations) wait too', () => {
    for (const cmd of MUTATING_COMMANDS) expect(needsPluginAdmission({ cmd, noWait: false })).toBe(true);
    for (const cmd of ['EXEC_JS', 'BATCH', 'AUDIT_DS']) expect(needsPluginAdmission({ cmd, noWait: false })).toBe(true);
  });

  it('broker safe-reads never wait (the broker parks them itself); STATUS/peek are unchanged', () => {
    for (const cmd of BROKER_SAFE_READ_COMMANDS) expect(needsPluginAdmission({ cmd, noWait: false })).toBe(false);
  });

  it('broker-terminal commands (JOB, COWORK, PROJECT_BIND, MUTATION_GATE) never reach a plugin, so never wait', () => {
    for (const cmd of BROKER_TERMINAL_COMMANDS) expect(needsPluginAdmission({ cmd, noWait: false })).toBe(false);
  });

  it('--no-wait opts out; --target-file-key hands the wait to the broker\'s durable parking instead', () => {
    expect(needsPluginAdmission({ cmd: 'SET_TEXT', noWait: true })).toBe(false);
    expect(needsPluginAdmission({ cmd: 'SET_TEXT', noWait: false, targetFileKey: 'rawKey' })).toBe(false);
  });
});

describe('awaitPluginAdmission — bounded wait with an injected hello reader', () => {
  it('returns immediately, without a stderr hint, when a plugin is already registered', async () => {
    const onWaiting = vi.fn();
    const result = await awaitPluginAdmission({
      port: 1, timeoutMs: 5_000, onWaiting,
      fetchHello: async () => ({ plugins: [{ instanceId: 'p1', fileName: 'F' }] }),
      sleep: async () => { throw new Error('must not sleep when already registered'); },
    });
    expect(result.registered).toBe(true);
    expect(onWaiting).not.toHaveBeenCalled();
  });

  it('polls until the plugin registers, announcing the wait exactly once', async () => {
    let polls = 0;
    const onWaiting = vi.fn();
    const sleeps: number[] = [];
    const result = await awaitPluginAdmission({
      port: 1, timeoutMs: 5_000, pollIntervalMs: 10, onWaiting,
      fetchHello: async () => ({ plugins: ++polls >= 3 ? [{ instanceId: 'p1', fileName: 'F' }] : [] }),
      sleep: async (ms) => { sleeps.push(ms); },
    });
    expect(result.registered).toBe(true);
    expect(polls).toBe(3);
    expect(sleeps).toEqual([10, 10]);
    expect(onWaiting).toHaveBeenCalledTimes(1);
  });

  it('a plugin that never comes → E_NO_PLUGIN naming the bound and the --no-wait opt-out', async () => {
    let now = 0;
    await expect(awaitPluginAdmission({
      port: 1, timeoutMs: 1_000, pollIntervalMs: 100, fileFilter: 'VSF - PCP',
      now: () => now, sleep: async (ms) => { now += ms; },
      fetchHello: async () => ({ plugins: [] }),
    })).rejects.toMatchObject({
      code: 'E_NO_PLUGIN',
      message: expect.stringMatching(/VSF - PCP.*1s.*--no-wait/s),
    });
  });

  it('a --file filter keeps waiting while only a DIFFERENT file\'s plugin is registered', async () => {
    let polls = 0;
    const result = await awaitPluginAdmission({
      port: 1, timeoutMs: 5_000, pollIntervalMs: 1, fileFilter: 'Wanted',
      sleep: async () => { /* no-op */ },
      fetchHello: async () => ({
        plugins: ++polls >= 2
          ? [{ instanceId: 'a', fileName: 'Other' }, { instanceId: 'b', fileName: 'Wanted' }]
          : [{ instanceId: 'a', fileName: 'Other' }],
      }),
    });
    expect(result.registered).toBe(true);
    expect(polls).toBe(2);
  });

  it('the default bound matches the project hook it replaces (status --wait --timeout 60)', () => {
    expect(PLUGIN_ADMISSION_WAIT_SECONDS).toBe(60);
  });
});

describe('runCommand — end to end against a scratch broker', () => {
  it('--no-wait: a mutation with no plugin is refused by the broker at once (the pre-fix behaviour, kept as the opt-out)', async () => {
    await startScratchBroker();
    setNoWait(true);
    await expect(runCommand('SET_TEXT', { nodeId: '1:1', text: 'x' })).rejects.toMatchObject({
      code: 'E_FILE_KEY_UNAVAILABLE',
    });
  });

  it('default: the mutation waits for the plugin, then dispatches to it', async () => {
    const port = await startScratchBroker();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const pending = runCommand('SET_TEXT', { nodeId: '1:1', text: 'x' }, { timeoutMs: 10_000 });
    let plugin: { seen: string[] } | null = null;
    // The plugin shows up only AFTER the CLI issued the mutation — the idle-flap shape.
    setTimeout(() => { void connectFakePlugin(port, 'Late File', 'late-key').then((p) => { plugin = p; }); }, 300);
    await expect(pending).resolves.toEqual({ answeredCmd: 'SET_TEXT' });
    expect(plugin!.seen).toEqual(['SET_TEXT']);
    expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toMatch(/waiting up to 60s for a plugin/);
    stderr.mockRestore();
  });

  it('a safe-read (EXPORT_PNG) still goes straight to the broker without any pre-dispatch wait', async () => {
    await startScratchBroker();
    // The broker itself parks a safe read for FIGMA_AGENT_PLUGIN_WAIT_MS (40ms here) and then
    // answers E_NO_PLUGIN — the CLI adds no wait of its own in front of it.
    const started = Date.now();
    await expect(runCommand('EXPORT_PNG', { nodeId: '1:1' })).rejects.toMatchObject({ code: 'E_NO_PLUGIN' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('the mutation gate store path is scratch-local (isolation guard for this file)', () => {
    expect(mutationGatePathFor(advertisePath)).toBe(join(scratchDir, 'mutation-gates.json'));
  });
});
