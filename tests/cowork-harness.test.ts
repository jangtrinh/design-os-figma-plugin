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
import { COWORK_MAX_TIMEOUT_MS, makeRequestFrame } from '../shared/protocol.ts';
import type { EventMsg, ReplyErr, ReplyOk, WireMsg } from '../shared/protocol.ts';

type BrokerDaemonModule = typeof import('../cli/src/transport/broker-daemon.ts');

const CHANGES_DIR_KEY = 'FIGMA_AGENT_CHANGES_DIR';
const BINDS_FILE_KEY = 'FIGMA_AGENT_BINDS_FILE';
const UNBOUND_DIR_KEY = 'FIGMA_AGENT_UNBOUND_DIR';
const APP_READINESS_MS_KEY = 'FIGMA_AGENT_APP_READINESS_MS';
const PLUGIN_WAIT_MS_KEY = 'FIGMA_AGENT_PLUGIN_WAIT_MS';

let scratchDir: string;
let advertisePath: string;
let scratchLogFile: string;
let sockets: WebSocket[];
let priorAppReadinessMs: string | undefined;
let priorPluginWaitMs: string | undefined;

async function loadBrokerDaemon(env: Record<string, string> = {}): Promise<BrokerDaemonModule> {
  process.env[CHANGES_DIR_KEY] = scratchDir;
  process.env[BINDS_FILE_KEY] = join(scratchDir, 'binds.json');
  process.env[UNBOUND_DIR_KEY] = join(scratchDir, 'unbound-root');
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  vi.resetModules();
  return import('../cli/src/transport/broker-daemon.ts');
}

function testExit(): (code: number) => never {
  return (code: number): never => {
    throw new Error(`__TEST_BROKER_EXIT__ code=${code}`);
  };
}

async function startTestBroker(env: Record<string, string> = {}): Promise<number> {
  const mod = await loadBrokerDaemon(env);
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

async function helloPlugin(
  ws: WebSocket, instanceId: string, fileName: string, fileKey: string | null = null,
  caps: string[] = ['fileGuard'],
): Promise<void> {
  ws.send(JSON.stringify({ type: 'PLUGIN_HELLO', data: { instanceId, fileName, fileKey, caps } }));
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

function nextFrameByDeadline<T extends WireMsg | EventMsg>(
  ws: WebSocket, predicate: (m: WireMsg) => boolean, deadlineMs: number,
): Promise<T | undefined> {
  return new Promise((resolvePromise) => {
    const handler = (raw: WebSocket.RawData): void => {
      const msg = JSON.parse(raw.toString()) as WireMsg;
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolvePromise(msg as T);
      }
    };
    const timer = setTimeout(() => {
      ws.off('message', handler);
      resolvePromise(undefined);
    }, deadlineMs);
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

function sendCowork(
  ws: WebSocket,
  reqId: string,
  opts: { waitMs: number; timeoutMs: number; expectedFile?: string; targetFileKey?: string },
): void {
  ws.send(JSON.stringify(
    makeRequestFrame(
      reqId, 'COWORK', { waitMs: opts.waitMs, timeoutMs: opts.timeoutMs },
      undefined, opts.expectedFile, undefined, undefined, undefined, undefined, opts.targetFileKey,
    ),
  ));
}

beforeEach(() => {
  priorAppReadinessMs = process.env[APP_READINESS_MS_KEY];
  priorPluginWaitMs = process.env[PLUGIN_WAIT_MS_KEY];
  scratchDir = mkdtempSync(join(tmpdir(), 'fa-cowork-harness-'));
  advertisePath = join(scratchDir, 'broker.json');
  scratchLogFile = join(scratchDir, 'broker.log');
  sockets = [];
});

afterEach(async () => {
  const shutdownSocket = sockets.find((ws) => ws.readyState === WebSocket.OPEN);
  if (shutdownSocket) {
    try { shutdownSocket.send(JSON.stringify({ type: 'BROKER_SHUTDOWN_REQUEST' })); } catch { /* already closed */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  for (const ws of sockets) { try { ws.terminate(); } catch { /* already closed */ } }
  rmSync(scratchDir, { recursive: true, force: true });
  if (priorAppReadinessMs === undefined) delete process.env[APP_READINESS_MS_KEY];
  else process.env[APP_READINESS_MS_KEY] = priorAppReadinessMs;
  if (priorPluginWaitMs === undefined) delete process.env[PLUGIN_WAIT_MS_KEY];
  else process.env[PLUGIN_WAIT_MS_KEY] = priorPluginWaitMs;
});

describe('cowork — application readiness is checked before waiter creation', () => {
  it('an exact raw-key cowork watches only B even when A is newer and ready', async () => {
    const port = await startTestBroker();
    const pluginB = await connectSocket(port);
    await helloPlugin(pluginB, 'inst-cw-raw-b', 'Cowork Raw B', 'raw-cowork-b');
    const pluginA = await connectSocket(port);
    await helloPlugin(pluginA, 'inst-cw-newer-a', 'Cowork Newer A', 'raw-cowork-a');
    const cli = await connectSocket(port);
    const replyPromise = nextFrame<ReplyOk | ReplyErr>(cli, (frame) =>
      (frame as ReplyOk | ReplyErr).id === 'req-cw-raw-b');

    sendCowork(cli, 'req-cw-raw-b', { waitMs: 30, timeoutMs: 500, targetFileKey: 'raw-cowork-b' });
    sendEditFeed(pluginA, [ownerEdit('newer-a:1')], { fileKey: 'raw-cowork-a', fileName: 'Cowork Newer A' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    sendEditFeed(pluginB, [ownerEdit('raw-b:1')], { fileKey: 'raw-cowork-b', fileName: 'Cowork Raw B' });

    expect(await replyPromise).toMatchObject({
      ok: true,
      result: { cycles: 1, file: 'Cowork Raw B', edits: [{ nodeId: 'raw-b:1' }] },
    });
  });

  it('unfiltered cowork watches the older ready plugin instead of failing on a newer stale plugin', async () => {
    const port = await startTestBroker({ [APP_READINESS_MS_KEY]: '200' });
    const pluginA = await connectSocket(port);
    await helloPlugin(pluginA, 'inst-cw-ready-a', 'Cowork Ready A', 'raw-cowork-a', ['fileGuard', 'correlatedHeartbeatV1', 'appProbeV1']);
    const pluginB = await connectSocket(port);
    await helloPlugin(pluginB, 'inst-cw-stale-b', 'Cowork Stale B', 'raw-cowork-b', ['fileGuard', 'correlatedHeartbeatV1', 'appProbeV1']);
    await new Promise((resolve) => setTimeout(resolve, 250));
    pluginA.send(JSON.stringify({ type: 'APP_PROBE_ACK', data: { probeId: 'cowork-ready-a' } } satisfies EventMsg));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const cli = await connectSocket(port);
    const reply = nextFrame<ReplyOk | ReplyErr>(cli, (frame) => (frame as ReplyOk | ReplyErr).id === 'req-cw-ready-first');
    sendCowork(cli, 'req-cw-ready-first', { waitMs: 30, timeoutMs: 500 });
    sendEditFeed(pluginA, [ownerEdit('ready-a:1')], { fileKey: 'raw-cowork-a', fileName: 'Cowork Ready A' });

    expect(await reply).toMatchObject({ ok: true, result: { cycles: 1, file: 'Cowork Ready A' } });
  });

  it('fails an exact unready target immediately and a later gap-fill cannot arm a hidden waiter', async () => {
    const port = await startTestBroker({ [APP_READINESS_MS_KEY]: '30' });
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'inst-cw-unready', 'Cowork Unready', 'raw-cowork', ['fileGuard', 'correlatedHeartbeatV1', 'appProbeV1']);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const cli = await connectSocket(port);
    const collected = { replies: [] as Array<ReplyOk | ReplyErr> };
    cli.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as ReplyOk | ReplyErr;
      if (frame.id === 'req-cw-unready') collected.replies.push(frame);
    });

    sendCowork(cli, 'req-cw-unready', { waitMs: 30, timeoutMs: 100, expectedFile: 'Cowork Unready' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(collected.replies).toHaveLength(1);
    expect(collected.replies[0]).toMatchObject({ ok: false, error: { code: 'E_APP_UNREADY' } });

    sendEditFeed(plugin, [ownerEdit('unready:1')], { fileKey: 'raw-cowork', fileName: 'Cowork Unready', source: 'gapfill' });
    await new Promise((resolve) => setTimeout(resolve, 130));
    expect(collected.replies).toHaveLength(1);
  });

  it('fails an exact raw-key unready target before waiter creation even while another file is ready', async () => {
    const port = await startTestBroker({ [APP_READINESS_MS_KEY]: '30' });
    const pluginA = await connectSocket(port);
    await helloPlugin(pluginA, 'inst-cw-ready-other', 'Cowork Ready Other', 'raw-cowork-ready', ['fileGuard', 'correlatedHeartbeatV1', 'appProbeV1']);
    const pluginC = await connectSocket(port);
    await helloPlugin(pluginC, 'inst-cw-unready-raw-c', 'Cowork Unready Raw C', 'raw-cowork-c', ['fileGuard', 'correlatedHeartbeatV1', 'appProbeV1']);
    await new Promise((resolve) => setTimeout(resolve, 50));
    pluginA.send(JSON.stringify({ type: 'APP_PROBE_ACK', data: { probeId: 'cowork-ready-other' } } satisfies EventMsg));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const cli = await connectSocket(port);
    const collected = { replies: [] as Array<ReplyOk | ReplyErr> };
    cli.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as ReplyOk | ReplyErr;
      if (frame.id === 'req-cw-unready-raw-c') collected.replies.push(frame);
    });

    sendCowork(cli, 'req-cw-unready-raw-c', {
      waitMs: 30, timeoutMs: 100, targetFileKey: 'raw-cowork-c',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(collected.replies).toHaveLength(1);
    expect(collected.replies[0]).toMatchObject({ ok: false, error: { code: 'E_APP_UNREADY' } });

    sendEditFeed(pluginC, [ownerEdit('unready-raw-c:1')], {
      fileKey: 'raw-cowork-c', fileName: 'Cowork Unready Raw C', source: 'gapfill',
    });
    await new Promise((resolve) => setTimeout(resolve, 130));
    expect(collected.replies).toHaveLength(1);
  });
});

describe('cowork — raw target validation and missing-target refusal', () => {
  it('rejects blank, padded, non-string, and selector-conflicting targetFileKey values', async () => {
    // The broker's park sweep is min(500ms, pluginWait/8); 800ms gives a 100ms
    // sweep, so the no-second-reply observation covers at least two intervals.
    const port = await startTestBroker({ [PLUGIN_WAIT_MS_KEY]: '800' });
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'inst-cw-validation', 'Cowork Validation', 'raw-cowork-validation');
    const cli = await connectSocket(port);
    const invalidFrames = [
      { id: 'req-cw-raw-blank', targetFileKey: '' },
      { id: 'req-cw-raw-padded', targetFileKey: ' raw-cowork-validation ' },
      { id: 'req-cw-raw-number', targetFileKey: 42 },
      { id: 'req-cw-raw-file-conflict', targetFileKey: 'raw-cowork-validation', expectedFile: 'Cowork Validation' },
      { id: 'req-cw-raw-instance-conflict', targetFileKey: 'raw-cowork-validation', expectedInstance: 'inst-cw-validation' },
    ];

    for (const frame of invalidFrames) {
      const replyPromise = nextFrame<ReplyErr>(cli, (reply) => (reply as ReplyErr).id === frame.id);
      cli.send(JSON.stringify({
        id: frame.id,
        cmd: 'COWORK',
        params: { waitMs: 30, timeoutMs: 100 },
        v: 1,
        ...frame,
      }));
      expect((await replyPromise).error.code).toBe('E_INVALID_ARGS');

      const noSecondReply = nextFrameByDeadline<ReplyErr>(
        cli, (reply) => (reply as ReplyErr).id === frame.id, 250,
      );
      sendEditFeed(plugin, [ownerEdit(`${frame.id}:live`)], {
        fileKey: 'raw-cowork-validation', fileName: 'Cowork Validation', source: 'live',
      });
      sendEditFeed(plugin, [ownerEdit(`${frame.id}:gapfill`)], {
        fileKey: 'raw-cowork-validation', fileName: 'Cowork Validation', source: 'gapfill',
      });
      expect(await noSecondReply).toBeUndefined();
    }
  });

  it('returns E_NO_PLUGIN for a missing exact raw key and creates no fallback waiter', async () => {
    const port = await startTestBroker();
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'inst-cw-present-a', 'Cowork Present A', 'raw-cowork-present-a');
    const cli = await connectSocket(port);
    const collected = { replies: [] as Array<ReplyOk | ReplyErr> };
    cli.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as ReplyOk | ReplyErr;
      if (frame.id === 'req-cw-missing-raw') collected.replies.push(frame);
    });

    sendCowork(cli, 'req-cw-missing-raw', {
      waitMs: 30, timeoutMs: 100, targetFileKey: 'raw-cowork-missing',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(collected.replies).toHaveLength(1);
    expect(collected.replies[0]).toMatchObject({ ok: false, error: { code: 'E_NO_PLUGIN' } });

    sendEditFeed(plugin, [ownerEdit('present-a:1')], {
      fileKey: 'raw-cowork-present-a', fileName: 'Cowork Present A',
    });
    await new Promise((resolve) => setTimeout(resolve, 130));
    expect(collected.replies).toHaveLength(1);
  });
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

describe('cowork — a requested --timeout past COWORK_MAX_TIMEOUT_MS discloses the cap, never silently', () => {
  it('requested timeoutMs > cap → the fired reply carries timeoutCappedMs: COWORK_MAX_TIMEOUT_MS', async () => {
    const port = await startTestBroker();
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'inst-cw-8', 'Cowork File G');
    const cli = await connectSocket(port);

    const replyPromise = nextFrame<ReplyOk | ReplyErr>(cli, (m) => (m as ReplyOk).id === 'req-cw-8');
    sendCowork(cli, 'req-cw-8', { waitMs: 100, timeoutMs: COWORK_MAX_TIMEOUT_MS + 3_600_000 });
    sendEditFeed(plugin, [ownerEdit('1:1')], { fileKey: null, fileName: 'Cowork File G' });

    const reply = await replyPromise;
    expect(reply.ok).toBe(true);
    const result = (reply as ReplyOk).result as { cycles: number; timeoutCappedMs?: number };
    expect(result.cycles).toBe(1);
    expect(result.timeoutCappedMs).toBe(COWORK_MAX_TIMEOUT_MS);
  });

  it('requested timeoutMs at or below the cap → timeoutCappedMs is absent entirely', async () => {
    const port = await startTestBroker();
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'inst-cw-9', 'Cowork File H');
    const cli = await connectSocket(port);

    const replyPromise = nextFrame<ReplyOk | ReplyErr>(cli, (m) => (m as ReplyOk).id === 'req-cw-9');
    sendCowork(cli, 'req-cw-9', { waitMs: 100, timeoutMs: 5_000 });
    sendEditFeed(plugin, [ownerEdit('1:1')], { fileKey: null, fileName: 'Cowork File H' });

    const reply = await replyPromise;
    expect(reply.ok).toBe(true);
    const result = (reply as ReplyOk).result as { cycles: number; timeoutCappedMs?: number };
    expect(result.cycles).toBe(1);
    expect('timeoutCappedMs' in result).toBe(false);
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

// A batch the relay held through an outage and replayed on reconnect is history, not
// activity. Feeding it to a live waiter would tell a cowork session that STARTED AFTER
// the outage that pre-session edits are its own — the frames still carry
// `source: 'live'`, because they were live when they were captured.
describe('cowork — a replayed batch is history, and never resolves a live waiter', () => {
  it('ignores the replayed gap, then fires on the first genuinely live edit', async () => {
    // 800ms plugin-wait shrinks the broker's waiter tick to 100ms, so the "nothing fired"
    // window below spans four real ticks rather than sitting inside a single 500ms one.
    const port = await startTestBroker({ [PLUGIN_WAIT_MS_KEY]: '800' });
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'inst-cw-replay', 'Cowork Replay', 'raw-cowork-replay');
    const cli = await connectSocket(port);
    const replyPromise = nextFrame<ReplyOk | ReplyErr>(cli, (m) => (m as ReplyOk | ReplyErr).id === 'req-cw-replay');

    sendCowork(cli, 'req-cw-replay', { waitMs: 100, timeoutMs: 20_000 });
    plugin.send(JSON.stringify({
      type: 'EDIT_FEED',
      data: {
        edits: [ownerEdit('gap:1'), ownerEdit('gap:2')], fileKey: 'raw-cowork-replay',
        fileName: 'Cowork Replay', source: 'live',
        capturedAt: Date.now() - 30 * 60_000, replayed: true,
      },
    } satisfies EventMsg));

    // Well past the 100ms quiet window: a waiter armed by the replay would have fired.
    const early = await nextFrameByDeadline<ReplyOk>(cli, (m) => (m as ReplyOk).id === 'req-cw-replay', 400);
    expect(early, 'a replayed gap must not arm a waiter that started after it').toBeUndefined();

    sendEditFeed(plugin, [ownerEdit('live:1')], { fileKey: 'raw-cowork-replay', fileName: 'Cowork Replay' });
    const reply = await replyPromise;
    expect(reply).toMatchObject({ ok: true, result: { cycles: 1, edits: [{ nodeId: 'live:1' }] } });
    expect((reply as ReplyOk).result as { edits: unknown[] }).toMatchObject({ edits: [{ nodeId: 'live:1' }] });
  });
});
