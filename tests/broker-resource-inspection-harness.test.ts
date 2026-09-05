import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { makeRequestFrame, type EventMsg, type JobInfo, type ReplyMsg, type WireMsg } from '../shared/protocol.ts';
import { sendWireMsg } from '../cli/src/transport/protocol-helpers.ts';
import type { BrokerResourceSnapshot, BrokerResourceSnapshotGetter } from '../cli/src/transport/broker-resource-snapshot.ts';

vi.setConfig({ testTimeout: 30_000 });

let scratch: string;
let advertisePath: string;
let sockets: WebSocket[];
let getSnapshot: BrokerResourceSnapshotGetter | undefined;
let observerTornDown: boolean;
const priorEnv = new Map<string, string | undefined>();
const rawFileKey = 'retained-resource-test-key';
const env = {
  FIGMA_AGENT_PLUGIN_WAIT_MS: '160', FIGMA_AGENT_APP_READINESS_MS: '500',
  FIGMA_AGENT_HEARTBEAT_MS: '1000', FIGMA_AGENT_IDLE_SHUTDOWN_MS: '600000',
  FIGMA_AGENT_LAST_PLUGINS_DEBOUNCE_MS: '50',
};

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'fa-resource-inspection-'));
  advertisePath = join(scratch, 'broker.json');
  sockets = [];
  getSnapshot = undefined;
  observerTornDown = false;
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

async function startBroker(observe: boolean): Promise<number> {
  vi.resetModules();
  const { runBrokerDaemon } = await import('../cli/src/transport/broker-daemon.ts');
  await runBrokerDaemon({
    advertisePath, mutationGatePath: join(scratch, 'gates.json'), ports: [0],
    logFile: join(scratch, 'broker.log'), exit: (code): never => { throw new Error(`test exit ${code}`); },
    ...(observe && { resourceObserver: (getter: BrokerResourceSnapshotGetter) => {
      getSnapshot = getter;
      return () => { getSnapshot = undefined; observerTornDown = true; };
    } }),
  });
  const ad = JSON.parse(readFileSync(advertisePath, 'utf8')) as { port: number; pid: number };
  expect(ad.pid).toBe(process.pid);
  expect(ad.port < 9410 || ad.port > 9419).toBe(true);
  return ad.port;
}

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    sockets.push(ws);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextFrame<T extends WireMsg>(ws: WebSocket, predicate: (frame: WireMsg) => boolean): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('frame timed out')), 10_000);
    const onMessage = (raw: WebSocket.RawData): void => {
      const frame = JSON.parse(raw.toString()) as WireMsg;
      if (predicate(frame)) finish(undefined, frame as T);
    };
    const finish = (error?: Error, frame?: T): void => {
      clearTimeout(timer); ws.off('message', onMessage);
      if (error) reject(error); else resolve(frame!);
    };
    ws.on('message', onMessage);
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function registerPlugin(port: number): Promise<{ ws: WebSocket; received: WireMsg[] }> {
  const ws = await connect(port);
  const received: WireMsg[] = [];
  ws.on('message', (raw) => received.push(JSON.parse(raw.toString()) as WireMsg));
  const ack = nextFrame<EventMsg>(ws, (frame) => (frame as EventMsg).type === 'SYNC_CONFIG');
  ws.send(JSON.stringify({ type: 'PLUGIN_HELLO', data: { instanceId: 'resource-plugin', fileName: 'Resource', fileKey: rawFileKey, caps: ['fileGuard'] } } satisfies EventMsg));
  await ack;
  return { ws, received };
}

async function sendJob(ws: WebSocket, id: string): Promise<string> {
  const state = nextFrame<EventMsg>(ws, (frame) => (frame as EventMsg).type === 'JOB_STATE' && (frame as EventMsg).data.jobId !== undefined);
  ws.send(JSON.stringify(makeRequestFrame(id, 'SET_TEXT', { text: id }, undefined, undefined, undefined, undefined, undefined, undefined, rawFileKey)));
  return ((await state).data as unknown as JobInfo).jobId;
}

describe('broker retained-resource observer — actual daemon', () => {
  it('leaves default startup and relay behavior unchanged without an observer', async () => {
    const port = await startBroker(false);
    expect(getSnapshot).toBeUndefined();
    const plugin = await registerPlugin(port);
    const cli = await connect(port);
    const request = makeRequestFrame('default-read', 'GET_SELECTION', { value: 'unchanged' });
    const reachedPlugin = nextFrame<typeof request>(plugin.ws, (frame) => 'id' in frame && frame.id === request.id);
    cli.send(JSON.stringify(request));
    await reachedPlugin;
    const reply = nextFrame<ReplyMsg>(cli, (frame) => 'id' in frame && frame.id === request.id && 'ok' in frame);
    plugin.ws.send(JSON.stringify({ id: request.id, ok: true, result: { value: 'unchanged' } }));
    expect((await reply).ok).toBe(true);
  });

  it('observes chunk, parked, queue, reply, cancellation, and recovery transitions', async () => {
    const port = await startBroker(true);
    expect(getSnapshot).toBeTypeOf('function');
    const partial = await connect(port);
    const large = makeRequestFrame('partial-unicode', 'GET_SELECTION', { text: '🧪'.repeat(300_000) });
    const chunkFrames: string[] = [];
    sendWireMsg({ send: (frame) => chunkFrames.push(frame) }, large);
    partial.send(chunkFrames[0]!);
    await waitFor(() => getSnapshot!().pendingChunks.incompleteIdCount === 1);
    expect(getSnapshot!().pendingChunks.utf8Bytes).toBe(Buffer.byteLength(chunkFrames[0]!));
    partial.terminate();
    await waitFor(() => getSnapshot!().pendingChunks.incompleteIdCount === 0);

    const parkedClient = await connect(port);
    const parked = JSON.stringify(makeRequestFrame('parked-unicode', 'GET_SELECTION', { text: '你好' }));
    parkedClient.send(parked);
    await waitFor(() => getSnapshot!().parkedRequests.requestCount === 1);
    expect(getSnapshot!().parkedRequests.utf8Bytes).toBe(Buffer.byteLength(parked));
    const plugin = await registerPlugin(port);
    await waitFor(() => plugin.received.some((frame) => 'id' in frame && frame.id === 'parked-unicode'));
    expect(getSnapshot!().jobTable.runningJobCount).toBe(1);
    plugin.ws.send(JSON.stringify({ id: 'parked-unicode', ok: true, result: {} }));
    await waitFor(() => getSnapshot!().jobTable.finishedJobCount === 1);

    const cli = await connect(port);
    const headJob = await sendJob(cli, 'head');
    await waitFor(() => plugin.received.some((frame) => 'id' in frame && frame.id === 'head'));
    const queuedJob = await sendJob(cli, 'queued');
    const cancelledJob = await sendJob(cli, 'cancelled');
    let snapshot = getSnapshot!();
    expect(snapshot.jobTable.runningJobCount).toBe(1);
    expect(snapshot.jobTable.queuedJobCount).toBe(2);
    expect(snapshot.fileQueues.waitingJobReferenceCount).toBe(2);

    const cancelReply = nextFrame<ReplyMsg>(cli, (frame) => 'id' in frame && frame.id === 'cancel-command' && 'ok' in frame);
    cli.send(JSON.stringify(makeRequestFrame('cancel-command', 'JOB', { mode: 'cancel', jobId: cancelledJob })));
    expect((await cancelReply).ok).toBe(true);
    snapshot = getSnapshot!();
    expect(snapshot.fileQueues.waitingJobReferenceCount).toBe(1);
    expect(snapshot.jobTable.finishedJobCount).toBe(2);

    const replyFrames: string[] = [];
    sendWireMsg({ send: (frame) => replyFrames.push(frame) }, { id: 'head', ok: true, result: { text: '🧪'.repeat(300_000) } });
    expect(replyFrames.length).toBeGreaterThan(1);
    plugin.ws.send(replyFrames[0]!);
    await waitFor(() => getSnapshot!().jobTable.replyFrames.frameReferences === 1);
    expect(getSnapshot!().jobTable.runningJobCount).toBe(1);
    for (const frame of replyFrames.slice(1)) plugin.ws.send(frame);
    await waitFor(() => plugin.received.some((frame) => 'id' in frame && frame.id === 'queued'));
    snapshot = getSnapshot!();
    expect(snapshot.jobTable.finishedJobCount).toBe(3);
    expect(snapshot.jobTable.runningJobCount).toBe(1);
    expect(snapshot.duplicateOwnershipReferences.jobReferencesFromOccupiedQueueSlots).toBe(1);

    const closed = new Promise<void>((resolve) => cli.once('close', () => resolve()));
    cli.terminate();
    await closed;
    plugin.ws.send(JSON.stringify({ id: 'queued', ok: true, result: { recovered: true } }));
    await waitFor(() => getSnapshot!().correlations.dispatchedRequestReferenceCount === 0);
    const recovery = await connect(port);
    const poll = nextFrame<ReplyMsg>(recovery, (frame) => 'id' in frame && frame.id === 'poll-recovery' && 'ok' in frame);
    recovery.send(JSON.stringify(makeRequestFrame('poll-recovery', 'JOB', { mode: 'poll', jobId: queuedJob })));
    const recovered = await poll;
    expect(recovered.ok && (recovered.result as { resultFrames: string[] }).resultFrames.length).toBe(1);
    expect(headJob).not.toBe(queuedJob);

    plugin.ws.send(JSON.stringify({ type: 'BROKER_SHUTDOWN_REQUEST' }));
    await waitFor(() => observerTornDown && !existsSync(advertisePath));
    expect(getSnapshot).toBeUndefined();
  });
});
