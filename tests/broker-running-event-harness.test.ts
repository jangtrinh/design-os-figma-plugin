// The broker announces dispatch: every JOB_STATE it sends carries `announcesRunning: true`,
// and a `running` JOB_STATE reaches the requester the moment its frames reach the plugin.
// A queued job behind a watchdog-held (wedged) head is told who blocks it via `blockedBy`.
// A real `exchange()` with a queue limit cancels a still-queued job, and the plugin never
// receives it. Real in-process broker on an OS-assigned port with a scratch advertisement
// path (the same isolation as tests/broker-daemon-harness.test.ts), never the live one.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

vi.mock('../cli/src/transport/broker-discovery.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../cli/src/transport/broker-discovery.ts')>()),
  ensureBroker: vi.fn(async () => { throw new Error('refusing to reach a real broker from a test'); }),
}));
vi.mock('../cli/src/transport/broker-client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../cli/src/transport/broker-client.ts')>()),
  runCommand: vi.fn(async () => { throw new Error('refusing to reach a real broker from a test'); }),
}));

import { makeRequestFrame } from '../shared/protocol.ts';
import type { EventMsg, JobInfo, ReplyOk, WireMsg } from '../shared/protocol.ts';
import { exchange } from '../cli/src/transport/broker-client.ts';
import { CliError } from '../cli/src/transport/protocol-helpers.ts';

vi.setConfig({ testTimeout: 30_000 });

type Announced = JobInfo & { announcesRunning?: boolean; blockedBy?: string };

const WATCHDOG_MS_KEY = 'FIGMA_AGENT_WATCHDOG_MS';
const ENV_KEYS = [WATCHDOG_MS_KEY, 'FIGMA_AGENT_CHANGES_DIR', 'FIGMA_AGENT_BINDS_FILE', 'FIGMA_AGENT_UNBOUND_DIR'];

let scratchDir: string;
let advertisePath: string;
let sockets: WebSocket[];
let priorEnv: Record<string, string | undefined>;

beforeEach(() => {
  priorEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  scratchDir = mkdtempSync(join(tmpdir(), 'fa-running-event-'));
  advertisePath = join(scratchDir, 'broker.json');
  sockets = [];
});

afterEach(async () => {
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'BROKER_SHUTDOWN_REQUEST' })); } catch { /* already gone */ }
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const ws of sockets) { try { ws.terminate(); } catch { /* already closed */ } }
  rmSync(scratchDir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(priorEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function startTestBroker(env: Record<string, string> = {}): Promise<number> {
  process.env['FIGMA_AGENT_CHANGES_DIR'] = scratchDir;
  process.env['FIGMA_AGENT_BINDS_FILE'] = join(scratchDir, 'binds.json');
  process.env['FIGMA_AGENT_UNBOUND_DIR'] = join(scratchDir, 'unbound-root');
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  // Module-load-time env constants (the watchdog budget) need a fresh module.
  vi.resetModules();
  const mod = await import('../cli/src/transport/broker-daemon.ts');
  const exit = (code: number): never => { throw new Error(`__TEST_BROKER_EXIT__ code=${code}`); };
  await mod.runBrokerDaemon({ advertisePath, ports: [0], exit, logFile: join(scratchDir, 'broker.log') });
  const ad = JSON.parse(readFileSync(advertisePath, 'utf8')) as { port: number; pid: number };
  if (ad.pid !== process.pid) throw new Error(`advertisement at ${advertisePath} is not this worker's broker (pid ${ad.pid})`);
  return ad.port;
}

function connectSocket(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    sockets.push(ws);
  });
}

function nextFrame<T extends WireMsg | EventMsg>(ws: WebSocket, predicate: (m: WireMsg) => boolean): Promise<T> {
  return new Promise((resolve) => {
    const handler = (raw: WebSocket.RawData): void => {
      const msg = JSON.parse(raw.toString()) as WireMsg;
      if (predicate(msg)) {
        ws.off('message', handler);
        resolve(msg as T);
      }
    };
    ws.on('message', handler);
  });
}

function collectFrames(ws: WebSocket): { frames: WireMsg[] } {
  const state = { frames: [] as WireMsg[] };
  ws.on('message', (raw) => state.frames.push(JSON.parse(raw.toString()) as WireMsg));
  return state;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000, stepMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error('waitFor: condition never became true within the deadline');
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

async function helloPlugin(ws: WebSocket, instanceId: string, fileName: string, fileKey: string): Promise<void> {
  ws.send(JSON.stringify({ type: 'PLUGIN_HELLO', data: { instanceId, fileName, fileKey, caps: ['fileGuard'] } } satisfies EventMsg));
  await nextFrame(ws, (m) => (m as EventMsg).type === 'SYNC_CONFIG');
}

function jobStates(state: { frames: WireMsg[] }): Announced[] {
  return state.frames
    .filter((f) => (f as EventMsg).type === 'JOB_STATE')
    .map((f) => (f as EventMsg).data as unknown as Announced);
}

function requestIds(state: { frames: WireMsg[] }): string[] {
  return state.frames.filter((f) => 'cmd' in (f as Record<string, unknown>)).map((f) => (f as { id: string }).id);
}

/** A mutating EXEC_JS from its own socket; resolves with that socket's frame log. */
async function sendExec(port: number, id: string): Promise<{ ws: WebSocket; log: { frames: WireMsg[] } }> {
  const ws = await connectSocket(port);
  const log = collectFrames(ws);
  ws.send(JSON.stringify(makeRequestFrame(id, 'EXEC_JS', { code: `return '${id}'`, timeoutMs: 1_000 })));
  await waitFor(() => jobStates(log).length > 0);
  return { ws, log };
}

describe('broker running event', () => {
  it('announces queued, then running only once the head frees the file, and running for a safe read', async () => {
    const port = await startTestBroker();
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'plugin-run', 'Run File', 'RawRun');
    const pluginLog = collectFrames(plugin);

    const a = await sendExec(port, 'run-a');
    await waitFor(() => requestIds(pluginLog).includes('run-a'));
    await waitFor(() => jobStates(a.log).some((j) => j.state === 'running'));
    expect(jobStates(a.log).every((j) => j.announcesRunning === true)).toBe(true);

    const b = await sendExec(port, 'run-b');
    await waitFor(() => jobStates(b.log).some((j) => j.queuePosition !== undefined));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(jobStates(b.log).map((j) => j.state)).toEqual(['queued', 'queued']);
    expect(jobStates(b.log).every((j) => j.announcesRunning === true)).toBe(true);
    expect(requestIds(pluginLog)).toEqual(['run-a']);

    plugin.send(JSON.stringify({ id: 'run-a', ok: true, result: 'a' } satisfies ReplyOk));
    await waitFor(() => jobStates(b.log).some((j) => j.state === 'running'));
    await waitFor(() => requestIds(pluginLog).includes('run-b'));
    const running = jobStates(b.log).find((j) => j.state === 'running')!;
    expect(running.announcesRunning).toBe(true);
    expect(running.jobId).toBe(jobStates(b.log)[0]!.jobId);

    // A job poll is not a JOB_STATE event and keeps its wire shape.
    const poll = nextFrame<ReplyOk>(b.ws, (m) => (m as ReplyOk).id === 'run-poll');
    b.ws.send(JSON.stringify(makeRequestFrame('run-poll', 'JOB', { mode: 'poll', jobId: running.jobId })));
    expect((await poll).result as { job: Record<string, unknown> }).not.toHaveProperty('job.announcesRunning');

    const reader = await connectSocket(port);
    const readerLog = collectFrames(reader);
    reader.send(JSON.stringify(makeRequestFrame('run-read', 'GET_SELECTION', {})));
    await waitFor(() => jobStates(readerLog).some((j) => j.state === 'running'));
    expect(jobStates(readerLog).every((j) => j.announcesRunning === true)).toBe(true);
  });

  it('a queue limit cancels the waiting job through the real exchange, and the plugin never receives it', async () => {
    const port = await startTestBroker();
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'plugin-cancel', 'Cancel File', 'RawCancel');
    const pluginLog = collectFrames(plugin);

    await sendExec(port, 'cancel-a');
    await waitFor(() => requestIds(pluginLog).includes('cancel-a'));

    const cliB = await connectSocket(port);
    const outcome = await exchange(cliB, 'EXEC_JS', { code: 'return 1', timeoutMs: 1_000 }, 5_000, undefined, undefined, {
      queueTimeoutMs: 300,
    }).then(() => undefined, (e: unknown) => e);
    expect(outcome).toBeInstanceOf(CliError);
    expect((outcome as CliError).code).toBe('E_TIMEOUT');
    expect((outcome as CliError).message).toContain('never ran');
    expect((outcome as CliError).jobId).toBeDefined();

    plugin.send(JSON.stringify({ id: 'cancel-a', ok: true, result: 'a' } satisfies ReplyOk));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(requestIds(pluginLog)).toEqual(['cancel-a']);
  });

  it('tells queued jobs which wedged head blocks the file, from the watchdog and at admission', async () => {
    const port = await startTestBroker({ [WATCHDOG_MS_KEY]: '150' });
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'plugin-wedge', 'Wedge File', 'RawWedge');
    const pluginLog = collectFrames(plugin);

    const a = await sendExec(port, 'wedge-a');
    await waitFor(() => requestIds(pluginLog).includes('wedge-a'));
    const jobA = jobStates(a.log)[0]!.jobId;

    const b = await sendExec(port, 'wedge-b');
    // The plugin never answers A; the watchdog (1s cadence) marks it failed and holds the slot.
    await waitFor(() => jobStates(b.log).some((j) => j.blockedBy === jobA));
    const blockedB = jobStates(b.log).find((j) => j.blockedBy === jobA)!;
    expect(blockedB.state).toBe('queued');
    expect(blockedB.announcesRunning).toBe(true);

    const c = await sendExec(port, 'wedge-c');
    await waitFor(() => jobStates(c.log).some((j) => j.blockedBy === jobA));
    expect(jobStates(c.log).find((j) => j.blockedBy === jobA)!.state).toBe('queued');
    expect(requestIds(pluginLog)).toEqual(['wedge-a']);
  });
});
