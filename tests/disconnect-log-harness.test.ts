// Plugin-disconnect record, end to end against the REAL in-process broker: every plugin
// socket close — peer, superseded orphan, broker shutdown — appends exactly one JSON line
// next to the broker advertisement, and BROKER_HELLO carries the newest few back out.
// The advertisement path is a scratch tmpdir and the port is OS-assigned, so the record
// file lands in the scratch dir by construction and no test ever touches a live broker.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { makeRequestFrame, type EventMsg, type WireMsg } from '../shared/protocol.ts';

vi.setConfig({ testTimeout: 30_000 });

const SECRET_SCRIPT = 'figma.root.name = "disconnect-record-secret-marker"';
const env = {
  FIGMA_AGENT_PLUGIN_WAIT_MS: '160', FIGMA_AGENT_APP_READINESS_MS: '500',
  FIGMA_AGENT_HEARTBEAT_MS: '1000', FIGMA_AGENT_IDLE_SHUTDOWN_MS: '600000',
  FIGMA_AGENT_LAST_PLUGINS_DEBOUNCE_MS: '50',
};

let scratch: string;
let advertisePath: string;
let recordPath: string;
let sockets: WebSocket[];
const priorEnv = new Map<string, string | undefined>();

interface Client { ws: WebSocket; received: WireMsg[] }

interface DisconnectLine {
  at: string;
  instanceId: string;
  fileName: string | null;
  fileKey: string | null;
  closeCode: number | null;
  closeReason: string;
  closedBy: string;
  superseded: boolean;
  msSinceLastSeen: number | null;
  msSinceLastAppFrame: number | null;
  socketOpenForMs: number;
  inFlightJobs: Array<{ jobId: string; cmd: string; activity: string | null; elapsedMs: number }>;
  queueDepthByFile: Record<string, number>;
}

interface DisconnectsHello { path: string; last: DisconnectLine[]; appendFailures: number }

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'fa-disconnect-log-'));
  advertisePath = join(scratch, 'broker.json');
  recordPath = join(scratch, 'figma-disconnects.jsonl');
  sockets = [];
  const paths = {
    FIGMA_AGENT_CHANGES_DIR: join(scratch, 'changes'), FIGMA_AGENT_BINDS_FILE: join(scratch, 'binds.json'),
    FIGMA_AGENT_UNBOUND_DIR: join(scratch, 'unbound'), ...env,
  };
  for (const [key, value] of Object.entries(paths)) {
    priorEnv.set(key, process.env[key]);
    process.env[key] = value;
  }
});

afterEach(async () => {
  for (const ws of sockets) if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'BROKER_SHUTDOWN_REQUEST' }));
  await new Promise((resolve) => setTimeout(resolve, 60));
  for (const ws of sockets) try { ws.terminate(); } catch { /* already closed */ }
  rmSync(scratch, { recursive: true, force: true });
  for (const [key, value] of priorEnv) value === undefined ? delete process.env[key] : process.env[key] = value;
  priorEnv.clear();
});

async function startBroker(): Promise<number> {
  vi.resetModules();
  const { runBrokerDaemon } = await import('../cli/src/transport/broker-daemon.ts');
  await runBrokerDaemon({
    advertisePath, mutationGatePath: join(scratch, 'gates.json'), ports: [0],
    logFile: join(scratch, 'broker.log'), exit: (code): never => { throw new Error(`test exit ${code}`); },
  });
  const ad = JSON.parse(readFileSync(advertisePath, 'utf8')) as { port: number; pid: number };
  expect(ad.pid).toBe(process.pid);
  expect(ad.port < 9410 || ad.port > 9419).toBe(true);
  return ad.port;
}

/** Collects every frame from the moment the socket exists, so the BROKER_HELLO sent on
 *  connect can never race the listener. */
function connect(port: number, options?: WebSocket.ClientOptions): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, options);
    const received: WireMsg[] = [];
    sockets.push(ws);
    ws.on('message', (raw) => received.push(JSON.parse(raw.toString()) as WireMsg));
    ws.once('open', () => resolve({ ws, received }));
    ws.once('error', reject);
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function eventOf(client: Client, type: string): EventMsg | undefined {
  return client.received.find((frame) => (frame as EventMsg).type === type) as EventMsg | undefined;
}

async function registerPlugin(
  port: number, instanceId: string, fileKey = `${instanceId}-key`, options?: WebSocket.ClientOptions,
): Promise<Client> {
  const client = await connect(port, options);
  client.ws.send(JSON.stringify({
    type: 'PLUGIN_HELLO', data: { instanceId, fileName: `File ${instanceId}`, fileKey, caps: ['fileGuard'] },
  } satisfies EventMsg));
  await waitFor(() => eventOf(client, 'SYNC_CONFIG') !== undefined);
  return client;
}

function closeAndWait(ws: WebSocket, code?: number, reason?: string): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) { resolve(); return; }
    ws.once('close', () => resolve());
    ws.close(code, reason);
  });
}

function recordText(): string {
  return existsSync(recordPath) ? readFileSync(recordPath, 'utf8') : '';
}

function recordLines(): DisconnectLine[] {
  return recordText().split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as DisconnectLine);
}

async function helloDisconnects(port: number): Promise<DisconnectsHello | undefined> {
  const cli = await connect(port);
  await waitFor(() => eventOf(cli, 'BROKER_HELLO') !== undefined);
  return (eventOf(cli, 'BROKER_HELLO')!.data as { disconnects?: DisconnectsHello }).disconnects;
}

describe('plugin disconnect record — actual daemon', () => {
  it('records one peer close with the in-flight job, never the script text, in a 0600 file', async () => {
    const port = await startBroker();
    const plugin = await registerPlugin(port, 'mid-job', 'mid-job-key');
    const cli = await connect(port);
    const request = makeRequestFrame(
      'mid-job-request', 'EXEC_JS', { code: SECRET_SCRIPT }, 'Run script',
      undefined, undefined, undefined, undefined, undefined, 'mid-job-key',
    );
    cli.ws.send(JSON.stringify(request));
    await waitFor(() => plugin.received.some((frame) => 'id' in frame && frame.id === request.id));
    const jobId = (cli.received.find((frame) => (frame as EventMsg).type === 'JOB_STATE') as EventMsg).data.jobId;

    await closeAndWait(plugin.ws, 4001, 'panel closed');
    await waitFor(() => recordLines().length === 1);

    const [line] = recordLines();
    expect(line).toMatchObject({
      instanceId: 'mid-job', fileName: 'File mid-job', fileKey: 'mid-job-key',
      closeCode: 4001, closeReason: 'panel closed', closedBy: 'peer', superseded: false,
    });
    expect(Number.isNaN(Date.parse(line!.at))).toBe(false);
    expect(line!.inFlightJobs).toHaveLength(1);
    expect(line!.inFlightJobs[0]).toMatchObject({ jobId, cmd: 'EXEC_JS', activity: 'Run script' });
    expect(line!.inFlightJobs[0]!.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(line!.msSinceLastSeen).toBeGreaterThanOrEqual(0);
    expect(line!.msSinceLastAppFrame).toBeGreaterThanOrEqual(0);
    expect(line!.socketOpenForMs).toBeGreaterThanOrEqual(0);
    expect(line!.queueDepthByFile).toEqual(expect.any(Object));
    // Privacy: the record carries identifiers and timings, never the script source.
    expect(recordText()).not.toContain('disconnect-record-secret-marker');
    expect(statSync(recordPath).mode & 0o777).toBe(0o600);
  });

  it('records an idle close with no in-flight jobs', async () => {
    const port = await startBroker();
    const plugin = await registerPlugin(port, 'idle');
    await closeAndWait(plugin.ws);
    await waitFor(() => recordLines().length === 1);
    expect(recordLines()[0]).toMatchObject({ instanceId: 'idle', closedBy: 'peer', superseded: false, inFlightJobs: [] });
  });

  it('never records a CLI socket close', async () => {
    const port = await startBroker();
    const cli = await connect(port);
    await closeAndWait(cli.ws);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const plugin = await registerPlugin(port, 'after-cli');
    await closeAndWait(plugin.ws);
    await waitFor(() => recordLines().length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(recordLines().map((line) => line.instanceId)).toEqual(['after-cli']);
  });

  it('records the superseded socket of a same-instance re-HELLO as broker-superseded', async () => {
    const port = await startBroker();
    const first = await registerPlugin(port, 'dup');
    await registerPlugin(port, 'dup');
    await waitFor(() => first.ws.readyState === WebSocket.CLOSED);
    await waitFor(() => recordLines().length === 1);
    expect(recordLines()[0]).toMatchObject({ instanceId: 'dup', closedBy: 'broker-superseded', superseded: true });
  });

  it('records a socket the heartbeat culls for a missed pong as broker-heartbeat-cull', async () => {
    const port = await startBroker();
    await registerPlugin(port, 'silent', undefined, { autoPong: false });
    await waitFor(() => recordLines().length === 1, 8_000);
    expect(recordLines()[0]).toMatchObject({ instanceId: 'silent', closedBy: 'broker-heartbeat-cull', superseded: false });
  });

  it('appends one broker-shutdown record per connected plugin before exit, and none twice', async () => {
    const port = await startBroker();
    const a = await registerPlugin(port, 'shut-a');
    const b = await registerPlugin(port, 'shut-b');
    const cli = await connect(port);
    cli.ws.send(JSON.stringify({ type: 'BROKER_SHUTDOWN_REQUEST' }));
    await waitFor(() => recordLines().length === 2);
    expect(recordLines().map((line) => [line.instanceId, line.closedBy]).sort()).toEqual([
      ['shut-a', 'broker-shutdown'], ['shut-b', 'broker-shutdown'],
    ]);
    // The sockets themselves closing afterwards must not add a second record each.
    await closeAndWait(a.ws);
    await closeAndWait(b.ws);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(recordLines()).toHaveLength(2);
  });

  it('carries path, the newest five records first, and the failure count on BROKER_HELLO', async () => {
    const port = await startBroker();
    for (const id of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']) {
      const plugin = await registerPlugin(port, id);
      const before = recordLines().length;
      await closeAndWait(plugin.ws);
      await waitFor(() => recordLines().length === before + 1);
    }
    const disconnects = await helloDisconnects(port);
    expect(disconnects).toBeDefined();
    expect(disconnects!.path).toBe(recordPath);
    expect(disconnects!.appendFailures).toBe(0);
    expect(disconnects!.last.map((line) => line.instanceId)).toEqual(['p6', 'p5', 'p4', 'p3', 'p2']);
  });

  it('counts an unwritable record path without throwing, and still reports the record', async () => {
    mkdirSync(recordPath);
    const port = await startBroker();
    const plugin = await registerPlugin(port, 'unwritable');
    await closeAndWait(plugin.ws);
    await waitFor(() => readFileSync(join(scratch, 'broker.log'), 'utf8').includes('DISCONNECT_LOG append failed'));
    const disconnects = await helloDisconnects(port);
    expect(disconnects!.appendFailures).toBe(1);
    expect(disconnects!.last.map((line) => line.instanceId)).toEqual(['unwritable']);
  });
});
