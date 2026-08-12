// `figma-agent cowork`'s broker-terminal wire behavior — a real in-process broker (same
// daemon-harness isolation as tests/broker-daemon-harness.test.ts: scratch tmpdir
// advertisement, ports:[0], a throwing `exit` stub — this file never touches the real
// /tmp/figma-agent-broker.json, the real 9410-9419 port range, or a real live broker)
// plus a fake plugin WS sending raw EDIT_FEED frames. Sub-second `--wait`/`--timeout`
// values throughout — no case here sleeps a real multi-second window.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { makeRequestFrame } from '../shared/protocol.ts';
import type { EventMsg, ReplyErr, ReplyOk, WireMsg } from '../shared/protocol.ts';

type BrokerDaemonModule = typeof import('../cli/src/transport/broker-daemon.ts');

const CHANGES_DIR_KEY = 'FIGMA_AGENT_CHANGES_DIR';
const BINDS_FILE_KEY = 'FIGMA_AGENT_BINDS_FILE';
const UNBOUND_DIR_KEY = 'FIGMA_AGENT_UNBOUND_DIR';

let scratchDir: string;
let advertisePath: string;
let scratchLogFile: string;
let sockets: WebSocket[];

async function loadBrokerDaemon(): Promise<BrokerDaemonModule> {
  process.env[CHANGES_DIR_KEY] = scratchDir;
  process.env[BINDS_FILE_KEY] = join(scratchDir, 'binds.json');
  process.env[UNBOUND_DIR_KEY] = join(scratchDir, 'unbound-root');
  vi.resetModules();
  return import('../cli/src/transport/broker-daemon.ts');
}

function testExit(): (code: number) => never {
  return (code: number): never => {
    throw new Error(`__TEST_BROKER_EXIT__ code=${code}`);
  };
}

async function startTestBroker(): Promise<number> {
  const mod = await loadBrokerDaemon();
  await mod.runBrokerDaemon({ advertisePath, ports: [0], exit: testExit(), logFile: scratchLogFile });
  const { readFileSync } = await import('node:fs');
  const ad = JSON.parse(readFileSync(advertisePath, 'utf8')) as { port: number };
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

async function helloPlugin(ws: WebSocket, instanceId: string, fileName: string, fileKey: string | null = null): Promise<void> {
  ws.send(JSON.stringify({ type: 'PLUGIN_HELLO', data: { instanceId, fileName, fileKey, caps: ['fileGuard'] } }));
  await new Promise<void>((resolvePromise) => {
    const handler = (raw: WebSocket.RawData): void => {
      const msg = JSON.parse(raw.toString()) as { type?: string };
      if (msg.type === 'SYNC_CONFIG') { ws.off('message', handler); resolvePromise(); }
    };
    ws.on('message', handler);
  });
}

function nextFrame<T extends WireMsg | EventMsg>(ws: WebSocket, predicate?: (m: WireMsg) => boolean): Promise<T> {
  return new Promise((resolvePromise) => {
    const handler = (raw: WebSocket.RawData): void => {
      const msg = JSON.parse(raw.toString()) as WireMsg;
      if (!predicate || predicate(msg)) { ws.off('message', handler); resolvePromise(msg as T); }
    };
    ws.on('message', handler);
  });
}

interface EditInputLike {
  op: 'created' | 'updated' | 'deleted';
  nodeId: string;
  nodeName: string | null;
  nodeType: string;
  parentName: string | null;
  changedProps: string[];
  origin: 'LOCAL' | 'REMOTE';
  page: string;
  actor: 'owner' | 'agent' | 'ambiguous';
}

function ownerEdit(nodeId: string): EditInputLike {
  return {
    op: 'updated', nodeId, nodeName: `Node ${nodeId}`, nodeType: 'FRAME', parentName: null,
    changedProps: ['fills'], origin: 'LOCAL', page: 'Page 1', actor: 'owner',
  };
}
function agentEdit(nodeId: string): EditInputLike {
  return { ...ownerEdit(nodeId), actor: 'agent' };
}

function sendEditFeed(
  ws: WebSocket, edits: readonly EditInputLike[], meta: { fileKey: string | null; fileName: string; source?: 'live' | 'gapfill' },
): void {
  ws.send(JSON.stringify({
    type: 'EDIT_FEED',
    data: { edits, fileKey: meta.fileKey, fileName: meta.fileName, source: meta.source ?? 'live' },
  } satisfies EventMsg));
}

function sendCowork(ws: WebSocket, reqId: string, opts: { waitMs: number; timeoutMs: number; expectedFile?: string }): void {
  ws.send(JSON.stringify(
    makeRequestFrame(reqId, 'COWORK', { waitMs: opts.waitMs, timeoutMs: opts.timeoutMs }, undefined, opts.expectedFile),
  ));
}

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'fa-cowork-harness-'));
  advertisePath = join(scratchDir, 'broker.json');
  scratchLogFile = join(scratchDir, 'broker.log');
  sockets = [];
});

afterEach(async () => {
  for (const ws of sockets) { try { ws.terminate(); } catch { /* already closed */ } }
  rmSync(scratchDir, { recursive: true, force: true });
});

describe('cowork — fires on a genuine owner cycle', () => {
  it('one owner edit, then quiet for waitMs → cycles:1 with the edited node, exit-equivalent ok:true', async () => {
    const port = await startTestBroker();
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'inst-cw-1', 'Cowork File A');
    const cli = await connectSocket(port);

    const replyPromise = nextFrame<ReplyOk | ReplyErr>(cli, (m) => (m as ReplyOk).id === 'req-cw-1');
    sendCowork(cli, 'req-cw-1', { waitMs: 200, timeoutMs: 5_000 });
    sendEditFeed(plugin, [ownerEdit('1:1')], { fileKey: null, fileName: 'Cowork File A' });

    const reply = await replyPromise;
    expect(reply.ok).toBe(true);
    const result = (reply as ReplyOk).result as { cycles: number; edits: EditInputLike[]; file: string | null; waitedMs: number };
    expect(result.cycles).toBe(1);
    expect(result.edits).toHaveLength(1);
    expect(result.edits[0].nodeId).toBe('1:1');
    expect(result.file).toBe('Cowork File A');
    expect(result.waitedMs).toBeGreaterThanOrEqual(190);
  });

  it('multiple owner batches before quiescence coalesce into ONE cycle carrying every edit', async () => {
    const port = await startTestBroker();
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'inst-cw-2', 'Cowork File B');
    const cli = await connectSocket(port);

    const replyPromise = nextFrame<ReplyOk | ReplyErr>(cli, (m) => (m as ReplyOk).id === 'req-cw-2');
    sendCowork(cli, 'req-cw-2', { waitMs: 200, timeoutMs: 5_000 });
    sendEditFeed(plugin, [ownerEdit('1:1')], { fileKey: null, fileName: 'Cowork File B' });
    await new Promise((r) => setTimeout(r, 80));
    sendEditFeed(plugin, [ownerEdit('1:2')], { fileKey: null, fileName: 'Cowork File B' }); // re-arms

    const reply = await replyPromise;
    const result = (reply as ReplyOk).result as { cycles: number; edits: EditInputLike[] };
    expect(result.cycles).toBe(1);
    expect(result.edits.map((e) => e.nodeId).sort()).toEqual(['1:1', '1:2']);
  });
});

describe('cowork — the zero-edit timeout is a normal answer, never an error', () => {
  it('nothing happens for the whole budget → cycles:0, ok:true (exit 0)', async () => {
    const port = await startTestBroker();
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'inst-cw-3', 'Cowork File C');
    const cli = await connectSocket(port);

    const replyPromise = nextFrame<ReplyOk | ReplyErr>(cli, (m) => (m as ReplyOk).id === 'req-cw-3');
    sendCowork(cli, 'req-cw-3', { waitMs: 100, timeoutMs: 300 });

    const reply = await replyPromise;
    expect(reply.ok).toBe(true);
    const result = (reply as ReplyOk).result as { cycles: number; edits: unknown[] };
    expect(result.cycles).toBe(0);
    expect(result.edits).toEqual([]);
  });
});

describe('cowork — agent-only traffic never fires a cycle (an agent must never trigger its own quiet-window)', () => {
  it('agent-actor edits alone never arm the wait — it runs out the full timeout as cycles:0', async () => {
    const port = await startTestBroker();
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'inst-cw-4', 'Cowork File D');
    const cli = await connectSocket(port);

    const replyPromise = nextFrame<ReplyOk | ReplyErr>(cli, (m) => (m as ReplyOk).id === 'req-cw-4');
    sendCowork(cli, 'req-cw-4', { waitMs: 100, timeoutMs: 300 });
    sendEditFeed(plugin, [agentEdit('1:1')], { fileKey: null, fileName: 'Cowork File D' });

    const reply = await replyPromise;
    const result = (reply as ReplyOk).result as { cycles: number; edits: unknown[] };
    expect(result.cycles).toBe(0);
    expect(result.edits).toEqual([]);
  });

  it('a gapfill batch of owner edits never arms either — a replay is not live typing', async () => {
    const port = await startTestBroker();
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'inst-cw-5', 'Cowork File E');
    const cli = await connectSocket(port);

    const replyPromise = nextFrame<ReplyOk | ReplyErr>(cli, (m) => (m as ReplyOk).id === 'req-cw-5');
    sendCowork(cli, 'req-cw-5', { waitMs: 100, timeoutMs: 300 });
    sendEditFeed(plugin, [ownerEdit('1:1')], { fileKey: null, fileName: 'Cowork File E', source: 'gapfill' });

    const reply = await replyPromise;
    const result = (reply as ReplyOk).result as { cycles: number; edits: unknown[] };
    expect(result.cycles).toBe(0);
    expect(result.edits).toEqual([]);
  });
});

describe('cowork — the plugin disconnecting mid-wait refuses with a reconnect hint', () => {
  it('the watched plugin closing → E_NO_PLUGIN naming the file, never a hang to the full timeout', async () => {
    const port = await startTestBroker();
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'inst-cw-6', 'Cowork File F');
    const cli = await connectSocket(port);

    const replyPromise = nextFrame<ReplyOk | ReplyErr>(cli, (m) => (m as ReplyOk | ReplyErr).id === 'req-cw-6');
    sendCowork(cli, 'req-cw-6', { waitMs: 5_000, timeoutMs: 30_000 }); // generous — the disconnect must fire well before either
    const started = Date.now();
    plugin.terminate();

    const reply = await replyPromise;
    const elapsed = Date.now() - started;
    expect(reply.ok).toBe(false);
    expect((reply as ReplyErr).error.code).toBe('E_NO_PLUGIN');
    expect((reply as ReplyErr).error.message).toMatch(/reopen|reconnect/i);
    expect(elapsed).toBeLessThan(2_000); // reacted to the disconnect, did not wait out the deadline
  });
});

describe('cowork — no plugin at all refuses immediately, never silently waits out the budget', () => {
  it('no matching plugin connected → E_NO_PLUGIN right away', async () => {
    const port = await startTestBroker();
    const cli = await connectSocket(port);

    const replyPromise = nextFrame<ReplyOk | ReplyErr>(cli, (m) => (m as ReplyOk | ReplyErr).id === 'req-cw-7');
    const started = Date.now();
    sendCowork(cli, 'req-cw-7', { waitMs: 1_000, timeoutMs: 30_000 });

    const reply = await replyPromise;
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(reply.ok).toBe(false);
    expect((reply as ReplyErr).error.code).toBe('E_NO_PLUGIN');
  });
});
