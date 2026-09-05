import { afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import type { EventMsg, WireMsg } from '../shared/protocol.ts';
import type { BrokerResourceSnapshotGetter } from '../cli/src/transport/broker-resource-snapshot.ts';
vi.setConfig({ testTimeout: 20_000 });
let scratch: string;
let advertisePath: string;
export let logPath: string;
let sockets: WebSocket[];
export let snapshot: BrokerResourceSnapshotGetter;
const priorEnv = new Map<string, string | undefined>();
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'fa-strict-request-chunks-'));
  advertisePath = join(scratch, 'broker.json');
  logPath = join(scratch, 'broker.log');
  sockets = [];
  const env = {
    FIGMA_AGENT_PLUGIN_WAIT_MS: '160',
    FIGMA_AGENT_HEARTBEAT_MS: '1000',
    FIGMA_AGENT_IDLE_SHUTDOWN_MS: '600000',
    FIGMA_AGENT_CHANGES_DIR: join(scratch, 'changes'),
    FIGMA_AGENT_BINDS_FILE: join(scratch, 'binds.json'),
    FIGMA_AGENT_UNBOUND_DIR: join(scratch, 'unbound'),
  };
  for (const [key, value] of Object.entries(env)) {
    priorEnv.set(key, process.env[key]);
    process.env[key] = value;
  }
});
afterEach(async () => {
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'BROKER_SHUTDOWN_REQUEST' }));
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const ws of sockets) try { ws.terminate(); } catch { /* already closed */ }
  rmSync(scratch, { recursive: true, force: true });
  for (const [key, value] of priorEnv) value === undefined ? delete process.env[key] : process.env[key] = value;
  priorEnv.clear();
});
export async function startBroker(): Promise<number> {
  vi.resetModules();
  const { runBrokerDaemon } = await import('../cli/src/transport/broker-daemon.ts');
  await runBrokerDaemon({
    advertisePath,
    mutationGatePath: join(scratch, 'gates.json'),
    ports: [0],
    logFile: logPath,
    exit: (code): never => { throw new Error(`test exit ${code}`); },
    resourceObserver: (getSnapshot) => { snapshot = getSnapshot; },
  });
  return (JSON.parse(readFileSync(advertisePath, 'utf8')) as { port: number }).port;
}
export function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    sockets.push(ws);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}
export function nextFrame<T extends WireMsg>(ws: WebSocket, predicate: (frame: WireMsg) => boolean): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('frame timed out')), 2_000);
    const onMessage = (raw: WebSocket.RawData): void => {
      const frame = JSON.parse(raw.toString()) as WireMsg;
      if (predicate(frame)) finish(undefined, frame as T);
    };
    const finish = (error?: Error, frame?: T): void => {
      clearTimeout(timer);
      ws.off('message', onMessage);
      if (error) reject(error); else resolve(frame!);
    };
    ws.on('message', onMessage);
  });
}
export async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
export async function registerPlugin(port: number, existingSocket?: WebSocket): Promise<{ ws: WebSocket; frames: WireMsg[] }> {
  const ws = existingSocket ?? await connect(port);
  const frames: WireMsg[] = [];
  ws.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as WireMsg));
  const ready = nextFrame<EventMsg>(ws, (frame) => (frame as EventMsg).type === 'SYNC_CONFIG');
  ws.send(JSON.stringify({
    type: 'PLUGIN_HELLO',
    data: { instanceId: 'strict-chunk-plugin', fileName: 'Strict Chunks', fileKey: 'strict-chunks-key', caps: ['fileGuard'] },
  } satisfies EventMsg));
  await ready;
  return { ws, frames };
}
