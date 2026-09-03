// Closing round (daemon harness ruling) — the ONE test file exercising broker-daemon.ts's
// REAL dispatch closures (admitRequest/routeFromPlugin/advanceQueue/handleClose/
// handleJobCommand/the watchdog interval) end to end, via a real in-process broker + real
// `ws` sockets speaking the actual wire protocol. Everything else in this wave was proven
// via pure-function extraction (file-queue.ts/job-table.ts/protocol-helpers.ts) — these
// closures had ZERO coverage until now, and stage-4's BLOCKER 1/2 both lived exactly here.
//
// Isolation (team-lead ruling, option B — dependency injection, NOT core extraction):
// `runBrokerDaemon`'s optional `options` param — an OS-assigned ephemeral port
// (`ports: [0]`), a tmpdir advertisement path, a scratch `logFile`, and an `exit` stub
// that THROWS instead of killing the vitest worker — so this file NEVER touches this
// machine's real /tmp/figma-agent-broker.json, the real 9410-9419 port range, the real
// /tmp/figma-agent-broker.log, or a real live broker. Also redirects the change-log dir
// (`FIGMA_AGENT_CHANGES_DIR`, existing test convention — see change-log.ts's own header)
// and the bind-cache file (`FIGMA_AGENT_BINDS_FILE`, existing override — see
// project-bind.ts) to the same scratch tmpdir.
//
// `WATCHDOG_TIMEOUT_MS`/`HEARTBEAT_MS`/etc. are `envMs(...)`-derived MODULE-LOAD-TIME
// constants in broker-daemon.ts (not read per-call) — a `beforeEach` env assignment is too
// late for those. Scenario 3 needs a shrunk watchdog, so every test here loads the module
// fresh via `vi.resetModules()` + dynamic `import()` AFTER setting env vars, guaranteeing
// the constants observe this test's own values regardless of import order across the suite.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { makeRequestFrame } from '../shared/protocol.ts';
import type { EventMsg, JobInfo, ReplyErr, ReplyOk, WireMsg } from '../shared/protocol.ts';
import type { ContentionStore } from '../cli/src/transport/contention-log.ts';
import { JOB_TTL_MS } from '../cli/src/transport/job-table.ts';
import { envMs } from '../cli/src/transport/protocol-helpers.ts';

// Scoped to THIS file only (vitest's own default 5_000ms stays the ceiling everywhere
// else, so a hung test in another file still fails fast) — the real-socket waits below
// legitimately need more room than the suite's fast pure-function tests do.
vi.setConfig({ testTimeout: 30_000 });

type BrokerDaemonModule = typeof import('../cli/src/transport/broker-daemon.ts');

const WATCHDOG_MS_KEY = 'FIGMA_AGENT_WATCHDOG_MS';
const PLUGIN_WAIT_MS_KEY = 'FIGMA_AGENT_PLUGIN_WAIT_MS';
const APP_READINESS_MS_KEY = 'FIGMA_AGENT_APP_READINESS_MS';
const CHANGES_DIR_KEY = 'FIGMA_AGENT_CHANGES_DIR';
const BINDS_FILE_KEY = 'FIGMA_AGENT_BINDS_FILE';
const UNBOUND_DIR_KEY = 'FIGMA_AGENT_UNBOUND_DIR';

// `waitFor`'s deadline/step were a hardcoded 3_000/50, honest only when this worker's
// event loop runs uncontended. Under real machine load (sibling vitest workers
// competing for CPU — this harness makes a real broker, real sockets, real wire frames;
// nothing here is simulated), the SAME callbacks that normally land in low tens of ms
// can land past a fixed 3s deadline for reasons that have nothing to do with the broker
// logic under test. One shared env-driven reader (the SAME `envMs` doctrine every
// daemon timing knob already uses) scales BOTH numbers together instead of two
// independently-hardcoded copies that could drift.
// Default measured, not guessed: this machine (shared with several other concurrent
// agent sessions + headless Chrome renderers, observed load average ~9) reproducibly
// pushed a full run of this file's tests to 17-25s wall-clock, against ~9s uncontended —
// a single frame this harness waits on can plausibly be delayed several seconds by a
// real event-loop stall, not a broker bug. 20s is the shrink-to-fit ceiling that
// survived that measured worst case with headroom, not an arbitrary pad.
const HARNESS_WAIT_TIMEOUT_MS = envMs('FIGMA_AGENT_HARNESS_WAIT_MS', 20_000);
const HARNESS_WAIT_STEP_MS = envMs('FIGMA_AGENT_HARNESS_STEP_MS', 50);
// The handful of fixed "let the broker settle" delays sprinkled through this file (no
// frame to `waitFor` on — e.g. a refused SET_TARGET sends no ack) share the SAME
// env-driven reader rather than their own separate hardcoded literal.
const HARNESS_SETTLE_MS = envMs('FIGMA_AGENT_HARNESS_SETTLE_MS', 250);

let scratchDir: string;
let advertisePath: string;
let scratchLogFile: string;
let sockets: WebSocket[];
let priorPluginWaitMs: string | undefined;
let priorAppReadinessMs: string | undefined;

/** Load `broker-daemon.ts` fresh, AFTER the given env vars are set — required for the
 *  module-load-time `envMs(...)` constants (see file header). */
async function loadBrokerDaemon(env: Record<string, string> = {}): Promise<BrokerDaemonModule> {
  process.env[CHANGES_DIR_KEY] = scratchDir;
  process.env[BINDS_FILE_KEY] = join(scratchDir, 'binds.json');
  // Issue #7 (backlog 5.6): unbound staging now roots at its OWN cwd-independent
  // location, never `scratchDir`/`FIGMA_AGENT_CHANGES_DIR` — a distinct scratch subdir
  // proves that separation, the same way this harness already isolates the real
  // /tmp/figma-agent-broker.json and 9410-9419 port range.
  process.env[UNBOUND_DIR_KEY] = join(scratchDir, 'unbound-root');
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  vi.resetModules();
  return import('../cli/src/transport/broker-daemon.ts');
}

/** The harness's own exit stub — asserts a startup/shutdown path is ever reachable
 *  WITHOUT killing the vitest worker. `shutdown()`'s caller wraps this in a try/catch
 *  (the daemon's own per-message error handling), so the throw never escapes to the test. */
function testExit(): (code: number) => never {
  return (code: number): never => {
    throw new Error(`__TEST_BROKER_EXIT__ code=${code}`);
  };
}

async function startTestBroker(env: Record<string, string> = {}): Promise<number> {
  const mod = await loadBrokerDaemon(env);
  // `logFile` keeps this in-process broker's own log traffic in the scratch dir —
  // the default `/tmp/figma-agent-broker.log` is shared with a live dev session.
  await mod.runBrokerDaemon({ advertisePath, ports: [0], exit: testExit(), logFile: scratchLogFile });
  const ad = JSON.parse(readFileSync(advertisePath, 'utf8')) as { port: number; pid: number };
  // Hard isolation assertion, applied to EVERY test in this file (not just target-pin):
  // the broker this test just spawned runs IN-PROCESS, so its advertised `pid` must be
  // this vitest worker's own `process.pid`. If it ever isn't, the advertisement being
  // read back belongs to a DIFFERENT process — a real machine-wide broker (this host
  // runs one on port 9410) or a stale leftover — and every assertion downstream would be
  // silently checking the wrong broker's state instead of failing loudly right here.
  if (ad.pid !== process.pid) {
    throw new Error(
      `startTestBroker: advertisement at ${advertisePath} reports pid ${ad.pid}, but this worker is pid ${process.pid} — ` +
      `reading a broker this test did not spawn (port ${ad.port}).`,
    );
  }
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

/** Connect AND resolve with the greeting BROKER_HELLO frame — race-free by construction:
 *  the broker sends BROKER_HELLO the instant its 'connection' handler fires (broker-
 *  daemon.ts's `onConnection`), which can beat this client's own 'open' event under load
 *  (both are separate events derived from the same handshake completing). Attaching the
 *  `message` listener HERE, synchronously at socket construction — instead of the usual
 *  `connectSocket` → `await 'open'` → THEN attach a listener sequence every other helper
 *  uses — means the listener exists before any I/O can possibly happen, so no frame the
 *  broker sends immediately on connect can ever be dropped waiting for a listener that
 *  attaches only after a network round trip. */
function connectAndAwaitBrokerHello(port: number): Promise<{ ws: WebSocket; hello: EventMsg }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    sockets.push(ws);
    ws.once('error', reject);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as WireMsg;
      if ((msg as EventMsg).type === 'BROKER_HELLO') resolve({ ws, hello: msg as EventMsg });
    });
  });
}

/** Resolve on the next parsed frame matching `predicate` (default: any frame). */
function nextFrame<T extends WireMsg | EventMsg>(ws: WebSocket, predicate?: (m: WireMsg) => boolean): Promise<T> {
  return new Promise((resolve) => {
    const handler = (raw: WebSocket.RawData): void => {
      const msg = JSON.parse(raw.toString()) as WireMsg;
      if (!predicate || predicate(msg)) {
        ws.off('message', handler);
        resolve(msg as T);
      }
    };
    ws.on('message', handler);
  });
}

/** Every frame `ws` receives from the moment this is called, for a plain count/order check. */
function collectFrames(ws: WebSocket): { frames: WireMsg[] } {
  const state = { frames: [] as WireMsg[] };
  ws.on('message', (raw) => state.frames.push(JSON.parse(raw.toString()) as WireMsg));
  return state;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = HARNESS_WAIT_TIMEOUT_MS,
  stepMs = HARNESS_WAIT_STEP_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error('waitFor: condition never became true within the deadline');
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

async function helloPlugin(
  ws: WebSocket, instanceId: string, fileName: string, fileKey: string | null = null,
  caps: string[] = ['fileGuard'],
): Promise<void> {
  ws.send(JSON.stringify({
    type: 'PLUGIN_HELLO',
    data: { instanceId, fileName, fileKey, caps },
  } satisfies EventMsg));
  // BROKER_HELLO arrives on connect, before HELLO is even processed — SYNC_CONFIG is the
  // registration ack this test waits on, so it never races the plugin being registered.
  await nextFrame(ws, (m) => (m as EventMsg).type === 'SYNC_CONFIG');
}

/** Sends FILE_INFO as the plugin — triggers `promotePendingBind` on the broker side when
 *  a real fileKey shows up for the first time on an already-bound name-slug. */
function sendFileInfo(ws: WebSocket, fileName: string, fileKey: string): void {
  ws.send(JSON.stringify({
    type: 'FILE_INFO',
    data: { fileName, fileKey, page: 'Page 1', selectionName: null, selectionCount: 0 },
  } satisfies EventMsg));
}

/** Send a mutating request and wait for its JOB_STATE — returns the minted jobId, whether
 *  it started running immediately or was queued behind another job on the same file. */
async function sendMutatingJob(ws: WebSocket, reqId: string): Promise<string> {
  const jobStatePromise = nextFrame<EventMsg>(ws, (m) => (m as EventMsg).type === 'JOB_STATE');
  ws.send(JSON.stringify(makeRequestFrame(reqId, 'SET_TEXT', { nodeId: '1:1', text: 'x' })));
  const jobState = await jobStatePromise;
  return (jobState.data as unknown as JobInfo).jobId;
}

async function pollJob(ws: WebSocket, jobId: string, reqId: string): Promise<{ job: JobInfo; resultFrames?: string[]; resultDropped?: boolean; lateReplyCount?: number }> {
  const replyPromise = nextFrame<ReplyOk | ReplyErr>(ws, (m) => (m as ReplyOk | ReplyErr).id === reqId);
  ws.send(JSON.stringify(makeRequestFrame(reqId, 'JOB', { mode: 'poll', jobId })));
  const reply = await replyPromise;
  if (!reply.ok) throw new Error(`poll failed: ${JSON.stringify(reply.error)}`);
  return reply.result as { job: JobInfo; resultFrames?: string[]; resultDropped?: boolean; lateReplyCount?: number };
}

async function createReservedHead(prefix: string): Promise<{
  port: number;
  plugin: WebSocket;
  pluginFrames: { frames: WireMsg[] };
  cliB: WebSocket;
  cliC: WebSocket;
  jobB: string;
  jobC: string;
  probeId: string;
}> {
  const port = await startTestBroker({ [APP_READINESS_MS_KEY]: '200', [PLUGIN_WAIT_MS_KEY]: '500' });
  const plugin = await connectSocket(port);
  await helloPlugin(plugin, `${prefix}-plugin`, `${prefix} File`, `${prefix}-raw`, ['fileGuard', 'correlatedHeartbeatV1', 'appProbeV1']);
  const pluginFrames = collectFrames(plugin);
  const cliA = await connectSocket(port);
  const jobA = await sendMutatingJob(cliA, `${prefix}-a`);
  await waitFor(() => pluginFrames.frames.some((frame) => (frame as { id?: string }).id === `${prefix}-a`));
  const cliB = await connectSocket(port);
  const jobB = await sendMutatingJob(cliB, `${prefix}-b`);
  const cliC = await connectSocket(port);
  const jobC = await sendMutatingJob(cliC, `${prefix}-c`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const release = nextFrame<ReplyOk>(cliA, (frame) => (frame as ReplyOk).id === `${prefix}-release-a`);
  cliA.send(JSON.stringify(makeRequestFrame(`${prefix}-release-a`, 'JOB', {
    mode: 'force-release', jobId: jobA, override: true,
  })));
  await release;
  await waitFor(() => pluginFrames.frames.some((frame) => (frame as EventMsg).type === 'APP_PROBE'));
  const probe = pluginFrames.frames.find((frame) => (frame as EventMsg).type === 'APP_PROBE') as EventMsg;
  return {
    port, plugin, pluginFrames, cliB, cliC, jobB, jobC,
    probeId: (probe.data as { probeId: string }).probeId,
  };
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

/** Sends a raw ReplyErr frame as the plugin — a fabricated `id` never matching a real
 *  pending/dispatched job is safe: `isReplyFromDispatchedInstance` returns true for an
 *  unknown job (job-table.ts:60), and `routeFromPlugin`'s pending/job lookups are simple
 *  no-ops on a miss. Only the error-log append (issue #7's own routing) is under test. */
function sendReplyErr(
  ws: WebSocket, id: string, error: { code: string; message: string }, fileContext?: { fileName: string; fileKey?: string | null },
): void {
  ws.send(JSON.stringify({ id, ok: false, error, ...(fileContext ? { fileContext } : {}) }));
}

/** Sends an EDIT_FEED batch as the plugin — no reply is expected (best-effort append). */
function sendEditFeed(
  ws: WebSocket, edits: readonly EditInputLike[], meta: { fileKey: string | null; fileName: string; source?: 'live' | 'gapfill' },
): void {
  ws.send(JSON.stringify({
    type: 'EDIT_FEED',
    data: { edits, fileKey: meta.fileKey, fileName: meta.fileName, source: meta.source ?? 'live' },
  } satisfies EventMsg));
}

/** Closing round (N4) — simulates a stale plugin build that doesn't yet send `fileName`
 *  in this payload AT ALL (not even `undefined` — the key is simply absent), the way a
 *  build predating this field would. */
function sendEditFeedWithoutFileName(ws: WebSocket, edits: readonly EditInputLike[], fileKey: string | null): void {
  ws.send(JSON.stringify({ type: 'EDIT_FEED', data: { edits, fileKey, source: 'live' } } satisfies EventMsg));
}

async function bindProject(
  ws: WebSocket, fileName: string, projectDir: string, reqId: string,
): Promise<{ migratedCount: number; migratedEditCount: number; migratedErrorCount: number; fileKey: string | null }> {
  ws.send(JSON.stringify(makeRequestFrame(reqId, 'PROJECT_BIND', { fileName, projectDir })));
  const reply = await nextFrame<ReplyOk | ReplyErr>(ws, (m) => (m as ReplyOk | ReplyErr).id === reqId);
  if (!reply.ok) throw new Error(`bind failed: ${JSON.stringify((reply as ReplyErr).error)}`);
  return reply.result as { migratedCount: number; migratedEditCount: number; migratedErrorCount: number; fileKey: string | null };
}

beforeEach(() => {
  priorPluginWaitMs = process.env[PLUGIN_WAIT_MS_KEY];
  priorAppReadinessMs = process.env[APP_READINESS_MS_KEY];
  scratchDir = mkdtempSync(join(tmpdir(), 'fa-broker-harness-'));
  advertisePath = join(scratchDir, 'broker.json');
  scratchLogFile = join(scratchDir, 'broker.log');
  sockets = [];
});

afterEach(async () => {
  // The daemon's OWN designed shutdown path: closes wss/wss6 for real. The `exit` stub's
  // throw is caught by `handleMessage`'s own per-connection try/catch (broker-daemon.ts's
  // `ws.on('message', ...)` wrapper) — it never escapes to this test.
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'BROKER_SHUTDOWN_REQUEST' })); } catch { /* already gone */ }
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const ws of sockets) { try { ws.terminate(); } catch { /* already closed */ } }
  rmSync(scratchDir, { recursive: true, force: true });
  if (priorPluginWaitMs === undefined) delete process.env[PLUGIN_WAIT_MS_KEY];
  else process.env[PLUGIN_WAIT_MS_KEY] = priorPluginWaitMs;
  if (priorAppReadinessMs === undefined) delete process.env[APP_READINESS_MS_KEY];
  else process.env[APP_READINESS_MS_KEY] = priorAppReadinessMs;
});

describe('daemon harness — mutation admission', () => {
  it('routes a targetFileKey only to an exact raw scene key and preserves it through chunk reassembly', async () => {
    const port = await startTestBroker();
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'p-target-exact', 'Target Exact', 'Raw/Target-Key');
    const pluginFrames = collectFrames(plugin);
    const cli = await connectSocket(port);
    const request = makeRequestFrame(
      'c_target_chunked', 'SET_TEXT', { nodeId: '1:1', text: 'x'.repeat(1_024) },
      undefined, undefined, undefined, undefined, undefined, undefined, 'Raw/Target-Key',
    );
    const serialized = JSON.stringify(request);
    const cut = Math.floor(serialized.length / 2);
    const jobState = nextFrame<EventMsg>(cli, (frame) => (frame as EventMsg).type === 'JOB_STATE');
    cli.send(JSON.stringify({ id: request.id, seq: 0, last: false, chunk: serialized.slice(0, cut) }));
    cli.send(JSON.stringify({ id: request.id, seq: 1, last: true, chunk: serialized.slice(cut) }));

    await jobState;
    await waitFor(() => pluginFrames.frames.some((frame) => (frame as { id?: string }).id === request.id));
    expect(pluginFrames.frames.find((frame) => (frame as { id?: string }).id === request.id)).toMatchObject({
      targetFileKey: 'Raw/Target-Key',
    });
  });

  it('keeps an exact-key request parked when a different raw-key plugin reconnects, then dispatches only to the exact key', async () => {
    const port = await startTestBroker();
    const cli = await connectSocket(port);
    const cliFrames = collectFrames(cli);
    const requestId = 'c_target_reconnect_exact';
    const jobState = nextFrame<EventMsg>(cli, (frame) => (frame as EventMsg).type === 'JOB_STATE');
    cli.send(JSON.stringify(makeRequestFrame(
      requestId, 'SET_TEXT', { nodeId: '1:1', text: 'x' },
      undefined, undefined, undefined, undefined, undefined, undefined, 'Raw/Reconnect-A',
    )));

    const pluginB = await connectSocket(port);
    await helloPlugin(pluginB, 'p-target-reconnect-b', 'Target Reconnect B', 'Raw/Reconnect-B');
    const pluginBFrames = collectFrames(pluginB);
    await new Promise((resolve) => setTimeout(resolve, HARNESS_SETTLE_MS));

    expect(cliFrames.frames.some((frame) =>
      (frame as EventMsg).type === 'JOB_STATE' || (frame as { id?: string }).id === requestId,
    )).toBe(false);
    expect(pluginBFrames.frames.some((frame) => (frame as { id?: string }).id === requestId)).toBe(false);

    const pluginA = await connectSocket(port);
    const pluginAFrames = collectFrames(pluginA);
    await helloPlugin(pluginA, 'p-target-reconnect-a', 'Target Reconnect A', 'Raw/Reconnect-A');
    await jobState;
    await waitFor(() => pluginAFrames.frames.some((frame) => (frame as { id?: string }).id === requestId));

    expect(pluginBFrames.frames.some((frame) => (frame as { id?: string }).id === requestId)).toBe(false);
  });

  it('parks an initial exact-key request while a different raw-key plugin is already connected', async () => {
    const port = await startTestBroker();
    const pluginB = await connectSocket(port);
    await helloPlugin(pluginB, 'p-target-initial-b', 'Target Initial B', 'Raw/Initial-B');
    const pluginBFrames = collectFrames(pluginB);
    const cli = await connectSocket(port);
    const cliFrames = collectFrames(cli);
    const requestId = 'c_target_initial_exact';
    const jobState = nextFrame<EventMsg>(cli, (frame) => (frame as EventMsg).type === 'JOB_STATE');
    cli.send(JSON.stringify(makeRequestFrame(
      requestId, 'SET_TEXT', { nodeId: '1:1', text: 'x' },
      undefined, undefined, undefined, undefined, undefined, undefined, 'Raw/Initial-A',
    )));
    await new Promise((resolve) => setTimeout(resolve, HARNESS_SETTLE_MS));

    expect(cliFrames.frames.some((frame) =>
      (frame as EventMsg).type === 'JOB_STATE' || (frame as { id?: string }).id === requestId,
    )).toBe(false);
    expect(pluginBFrames.frames.some((frame) => (frame as { id?: string }).id === requestId)).toBe(false);

    const pluginA = await connectSocket(port);
    const pluginAFrames = collectFrames(pluginA);
    await helloPlugin(pluginA, 'p-target-initial-a', 'Target Initial A', 'Raw/Initial-A');
    await jobState;
    await waitFor(() => pluginAFrames.frames.some((frame) => (frame as { id?: string }).id === requestId));

    expect(pluginBFrames.frames.some((frame) => (frame as { id?: string }).id === requestId)).toBe(false);
  });

  it('flushes an exact-key parked request only after FILE_INFO supplies its raw key', async () => {
    const port = await startTestBroker();
    const pluginB = await connectSocket(port);
    await helloPlugin(pluginB, 'p-target-file-info-b', 'Target File Info B', 'Raw/File-Info-B');
    const pluginBFrames = collectFrames(pluginB);
    const cli = await connectSocket(port);
    const cliFrames = collectFrames(cli);
    const requestId = 'c_target_file_info_exact';
    cli.send(JSON.stringify(makeRequestFrame(
      requestId, 'SET_TEXT', { nodeId: '1:1', text: 'x' },
      undefined, undefined, undefined, undefined, undefined, undefined, 'Raw/File-Info-A',
    )));

    const pluginA = await connectSocket(port);
    await helloPlugin(pluginA, 'p-target-file-info-a', 'Target File Info A', null);
    const pluginAFrames = collectFrames(pluginA);
    await new Promise((resolve) => setTimeout(resolve, HARNESS_SETTLE_MS));

    expect(cliFrames.frames.some((frame) =>
      (frame as EventMsg).type === 'JOB_STATE' || (frame as { id?: string }).id === requestId,
    )).toBe(false);
    expect(pluginAFrames.frames.some((frame) => (frame as { id?: string }).id === requestId)).toBe(false);
    expect(pluginBFrames.frames.some((frame) => (frame as { id?: string }).id === requestId)).toBe(false);

    const jobState = nextFrame<EventMsg>(cli, (frame) => (frame as EventMsg).type === 'JOB_STATE');
    sendFileInfo(pluginA, 'Target File Info A', 'Raw/File-Info-A');
    const admission = await Promise.race<EventMsg | null>([
      jobState,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), Math.max(1_000, HARNESS_SETTLE_MS * 4))),
    ]);
    expect(admission).not.toBeNull();
    await waitFor(() => pluginAFrames.frames.some((frame) => (frame as { id?: string }).id === requestId));

    expect(pluginAFrames.frames.find((frame) => (frame as { id?: string }).id === requestId)).toMatchObject({
      targetFileKey: 'Raw/File-Info-A',
    });
    expect(pluginBFrames.frames.some((frame) => (frame as { id?: string }).id === requestId)).toBe(false);
  });

  it('rejects blank, padded, and conflicting target assertions before ownership', async () => {
    const port = await startTestBroker();
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'p-target-other', 'Target Other', 'Raw/Other-Key');
    const pluginFrames = collectFrames(plugin);
    const cli = await connectSocket(port);

    const blank = nextFrame<ReplyErr>(cli, (frame) => (frame as ReplyErr).id === 'c_target_blank');
    cli.send(JSON.stringify({
      id: 'c_target_blank', cmd: 'SET_TEXT', params: { nodeId: '1:1', text: 'x' }, v: 1,
      targetFileKey: '',
    }));
    expect((await blank).error.code).toBe('E_INVALID_ARGS');

    const padded = nextFrame<ReplyErr>(cli, (frame) => (frame as ReplyErr).id === 'c_target_padded');
    cli.send(JSON.stringify({
      id: 'c_target_padded', cmd: 'SET_TEXT', params: { nodeId: '1:1', text: 'x' }, v: 1,
      targetFileKey: ' Raw/Expected-Key ',
    }));
    expect((await padded).error.code).toBe('E_INVALID_ARGS');

    const conflict = nextFrame<ReplyErr>(cli, (frame) => (frame as ReplyErr).id === 'c_target_conflict');
    cli.send(JSON.stringify(makeRequestFrame(
      'c_target_conflict', 'SET_TEXT', { nodeId: '1:1', text: 'x' },
      undefined, 'Target Other', undefined, undefined, undefined, undefined, 'Raw/Expected-Key',
    )));
    expect((await conflict).error.code).toBe('E_INVALID_ARGS');
    expect(pluginFrames.frames.some((frame) => ['c_target_blank', 'c_target_padded', 'c_target_conflict']
      .includes((frame as { id?: string }).id ?? ''))).toBe(false);
  });

  it('keeps an exact-key request parked across a keyless reconnect, then expires as E_NO_PLUGIN naming that key', async () => {
    let controlledNow = 1_000_000;
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => controlledNow);
    try {
      const port = await startTestBroker({ [PLUGIN_WAIT_MS_KEY]: '300' });
      const cli = await connectSocket(port);
      const cliFrames = collectFrames(cli);
      const requestId = 'c_target_keyless';
      const expiry = nextFrame<ReplyErr>(cli, (frame) => (frame as ReplyErr).id === requestId);
      cli.send(JSON.stringify(makeRequestFrame(
        requestId, 'SET_TEXT', { nodeId: '1:1', text: 'x' },
        undefined, undefined, undefined, undefined, undefined, undefined, 'Raw/Expected-Key',
      )));
      await new Promise((resolve) => setTimeout(resolve, Math.min(HARNESS_SETTLE_MS, 100)));

      // Move the broker clock partway through the parked window before a keyless HELLO.
      // Advancing it to the original deadline below proves that this HELLO did not reset
      // `ParkedRequest.deadline`; only the real 100 ms sweep timer remains asynchronous.
      controlledNow += 200;
      const plugin = await connectSocket(port);
      await helloPlugin(plugin, 'p-target-missing', 'Target Missing', null);
      const pluginFrames = collectFrames(plugin);
      await new Promise((resolve) => setTimeout(resolve, Math.min(HARNESS_SETTLE_MS, 100)));

      expect(cliFrames.frames.some((frame) =>
        (frame as EventMsg).type === 'JOB_STATE' || (frame as { id?: string }).id === requestId,
      )).toBe(false);
      expect(pluginFrames.frames.some((frame) => (frame as { id?: string }).id === requestId)).toBe(false);

      controlledNow += 100;
      const reply = await Promise.race<ReplyErr | null>([
        expiry,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), Math.max(1_000, HARNESS_SETTLE_MS * 4))),
      ]);
      expect(reply).not.toBeNull();
      expect((reply as ReplyErr).error.code).toBe('E_NO_PLUGIN');
      expect((reply as ReplyErr).error.message).toContain('Raw/Expected-Key');
      expect(pluginFrames.frames.some((frame) => (frame as { id?: string }).id === requestId)).toBe(false);
    } finally {
      dateNow.mockRestore();
    }
  });

  it('returns E_MUTATION_GATE_UNAVAILABLE before missing live identity or job ownership when the gate store is corrupt', async () => {
    writeFileSync(join(scratchDir, 'mutation-gates.json'), '{ malformed');
    const port = await startTestBroker();
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'p-target-gate-corrupt', 'Target Gate Corrupt', null);
    const pluginFrames = collectFrames(plugin);
    const cli = await connectSocket(port);
    const cliFrames = collectFrames(cli);
    const reply = nextFrame<ReplyErr>(cli, (frame) => (frame as ReplyErr).id === 'c_target_gate_corrupt');

    cli.send(JSON.stringify(makeRequestFrame('c_target_gate_corrupt', 'SET_TEXT', { nodeId: '1:1', text: 'x' })));

    expect((await reply).error.code).toBe('E_MUTATION_GATE_UNAVAILABLE');
    expect(cliFrames.frames.some((frame) => (frame as EventMsg).type === 'JOB_STATE')).toBe(false);
    expect(pluginFrames.frames.some((frame) => (frame as { id?: string }).id === 'c_target_gate_corrupt')).toBe(false);
  });

  it('returns E_MUTATION_GATE_UNAVAILABLE before a mismatched target assertion or job ownership when the gate store is unreadable', async () => {
    mkdirSync(join(scratchDir, 'mutation-gates.json'));
    const port = await startTestBroker();
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'p-target-gate-unreadable', 'Target Gate Unreadable', 'Raw/Actual-Key');
    const pluginFrames = collectFrames(plugin);
    const cli = await connectSocket(port);
    const cliFrames = collectFrames(cli);
    const reply = nextFrame<ReplyErr>(cli, (frame) => (frame as ReplyErr).id === 'c_target_gate_unreadable');

    cli.send(JSON.stringify(makeRequestFrame(
      'c_target_gate_unreadable', 'SET_TEXT', { nodeId: '1:1', text: 'x' },
      undefined, undefined, undefined, undefined, undefined, undefined, 'Raw/Expected-Key',
    )));

    expect((await reply).error.code).toBe('E_MUTATION_GATE_UNAVAILABLE');
    expect(cliFrames.frames.some((frame) => (frame as EventMsg).type === 'JOB_STATE')).toBe(false);
    expect(pluginFrames.frames.some((frame) => (frame as { id?: string }).id === 'c_target_gate_unreadable')).toBe(false);
  });

  it('fails keyless offline mutations immediately, while a keyed mutation and a keyless safe read park for a matching plugin', async () => {
    const port = await startTestBroker();
    const keylessCli = await connectSocket(port);
    const keyless = nextFrame<ReplyErr>(keylessCli, (frame) => (frame as ReplyErr).id === 'c_target_keyless');
    keylessCli.send(JSON.stringify(makeRequestFrame('c_target_keyless', 'SET_TEXT', { nodeId: '1:1', text: 'x' })));
    expect((await keyless).error.code).toBe('E_FILE_KEY_UNAVAILABLE');

    const keyedCli = await connectSocket(port);
    const keyedJob = nextFrame<EventMsg>(keyedCli, (frame) => (frame as EventMsg).type === 'JOB_STATE');
    keyedCli.send(JSON.stringify(makeRequestFrame(
      'c_target_parked', 'SET_TEXT', { nodeId: '1:1', text: 'x' },
      undefined, undefined, undefined, undefined, undefined, undefined, 'Raw/Parked-Key',
    )));
    const safeCli = await connectSocket(port);
    const safeJob = nextFrame<EventMsg>(safeCli, (frame) => (frame as EventMsg).type === 'JOB_STATE');
    safeCli.send(JSON.stringify(makeRequestFrame('c_target_safe_parked', 'GET_SELECTION', {})));

    const plugin = await connectSocket(port);
    const pluginFrames = collectFrames(plugin);
    await helloPlugin(plugin, 'p-target-parked', 'Target Parked', 'Raw/Parked-Key');
    await Promise.all([keyedJob, safeJob]);
    await waitFor(() => ['c_target_parked', 'c_target_safe_parked'].every((id) =>
      pluginFrames.frames.some((frame) => (frame as { id?: string }).id === id),
    ));
  });

  it('stales parked work after a pause and resume of that same target', async () => {
    const port = await startTestBroker();
    const staleCli = await connectSocket(port);
    const control = await connectSocket(port);
    const staleReply = nextFrame<ReplyErr>(staleCli, (frame) => (frame as ReplyErr).id === 'c_target_stale');
    staleCli.send(JSON.stringify(makeRequestFrame(
      'c_target_stale', 'SET_TEXT', { nodeId: '1:1', text: 'x' },
      undefined, undefined, undefined, undefined, undefined, undefined, 'Raw/Stale-A',
    )));

    for (const [id, fileKey, mode] of [
      ['c_target_pause_a', 'Raw/Stale-A', 'pause'],
      ['c_target_resume_a', 'Raw/Stale-A', 'resume'],
    ] as const) {
      const reply = nextFrame<ReplyOk>(control, (frame) => (frame as ReplyOk).id === id);
      control.send(JSON.stringify(makeRequestFrame(id, 'MUTATION_GATE', { mode, fileKey })));
      await reply;
    }

    const stalePlugin = await connectSocket(port);
    const stalePluginFrames = collectFrames(stalePlugin);
    await helloPlugin(stalePlugin, 'p-target-stale', 'Target Stale', 'Raw/Stale-A');
    expect((await staleReply).error.code).toBe('E_STALE_ADMISSION');
    expect(stalePluginFrames.frames.some((frame) => (frame as { id?: string }).id === 'c_target_stale')).toBe(false);
  });

  it('keeps a parked target fresh when only an unrelated target transitions', async () => {
    const port = await startTestBroker();
    const cli = await connectSocket(port);
    const control = await connectSocket(port);
    const freshJob = nextFrame<EventMsg>(cli, (frame) => (frame as EventMsg).type === 'JOB_STATE');
    cli.send(JSON.stringify(makeRequestFrame(
      'c_target_fresh', 'SET_TEXT', { nodeId: '1:1', text: 'x' },
      undefined, undefined, undefined, undefined, undefined, undefined, 'Raw/Fresh-B',
    )));
    for (const [id, mode] of [['c_target_pause_c', 'pause'], ['c_target_resume_c', 'resume']] as const) {
      const reply = nextFrame<ReplyOk>(control, (frame) => (frame as ReplyOk).id === id);
      control.send(JSON.stringify(makeRequestFrame(id, 'MUTATION_GATE', { mode, fileKey: 'Raw/Unrelated-C' })));
      await reply;
    }

    const plugin = await connectSocket(port);
    const pluginFrames = collectFrames(plugin);
    await helloPlugin(plugin, 'p-target-fresh', 'Target Fresh', 'Raw/Fresh-B');
    await freshJob;
    await waitFor(() => pluginFrames.frames.some((frame) => (frame as { id?: string }).id === 'c_target_fresh'));
  });

  it('keeps a persisted pause across a replacement broker and admits only a fresh post-resume mutation', async () => {
    const firstPort = await startTestBroker();
    const firstCli = await connectSocket(firstPort);
    const paused = nextFrame<ReplyOk>(firstCli, (frame) => (frame as ReplyOk).id === 'c_target_restart_pause');
    firstCli.send(JSON.stringify(makeRequestFrame('c_target_restart_pause', 'MUTATION_GATE', { mode: 'pause', fileKey: 'Raw/Restart-Key' })));
    await paused;
    rmSync(advertisePath, { force: true });

    const replacementPort = await startTestBroker();
    const plugin = await connectSocket(replacementPort);
    await helloPlugin(plugin, 'p-target-restart', 'Target Restart', 'Raw/Restart-Key');
    const pluginFrames = collectFrames(plugin);
    const cli = await connectSocket(replacementPort);
    const blocked = nextFrame<ReplyErr>(cli, (frame) => (frame as ReplyErr).id === 'c_target_restart_blocked');
    cli.send(JSON.stringify(makeRequestFrame('c_target_restart_blocked', 'SET_TEXT', { nodeId: '1:1', text: 'x' })));
    expect((await blocked).error.code).toBe('E_MUTATIONS_PAUSED');
    expect(pluginFrames.frames.some((frame) => (frame as { id?: string }).id === 'c_target_restart_blocked')).toBe(false);

    const resumed = nextFrame<ReplyOk>(cli, (frame) => (frame as ReplyOk).id === 'c_target_restart_resume');
    cli.send(JSON.stringify(makeRequestFrame('c_target_restart_resume', 'MUTATION_GATE', { mode: 'resume', fileKey: 'Raw/Restart-Key' })));
    await resumed;
    const freshJob = nextFrame<EventMsg>(cli, (frame) => (frame as EventMsg).type === 'JOB_STATE');
    cli.send(JSON.stringify(makeRequestFrame('c_target_restart_fresh', 'SET_TEXT', { nodeId: '1:1', text: 'x' })));
    await freshJob;
    await waitFor(() => pluginFrames.frames.some((frame) => (frame as { id?: string }).id === 'c_target_restart_fresh'));
  });

  it('handles a raw-key pause at the broker, then refuses mutations without owning a job or forwarding a frame', async () => {
    const port = await startTestBroker();
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'p-gate', 'Gate File', 'Raw Gate Key');
    const pluginFrames = collectFrames(plugin);
    const cli = await connectSocket(port);
    const gateFrames = collectFrames(cli);
    const pauseId = 'c_gate_pause_1';

    cli.send(JSON.stringify(makeRequestFrame(pauseId, 'MUTATION_GATE', { mode: 'pause', fileKey: 'Raw Gate Key' })));
    await waitFor(() => gateFrames.frames.some((frame) => (frame as { id?: string; type?: string }).id === pauseId || (frame as { type?: string }).type === 'JOB_STATE'));
    expect(gateFrames.frames.find((frame) => (frame as { id?: string }).id === pauseId)).toMatchObject({
      ok: true,
      result: { fileKey: 'Raw Gate Key', state: 'paused' },
    });
    expect(gateFrames.frames.some((frame) => (frame as { type?: string }).type === 'JOB_STATE')).toBe(false);
    expect(pluginFrames.frames.some((frame) => (frame as { id?: string }).id === pauseId)).toBe(false);

    const mutationId = 'c_gate_mutation_1';
    const mutationFrames = collectFrames(cli);
    cli.send(JSON.stringify(makeRequestFrame(mutationId, 'SET_TEXT', { nodeId: '1:1', text: 'blocked' })));
    await waitFor(() => mutationFrames.frames.some((frame) => (frame as { id?: string; type?: string }).id === mutationId || (frame as { type?: string }).type === 'JOB_STATE'));
    expect(mutationFrames.frames.find((frame) => (frame as { id?: string }).id === mutationId)).toMatchObject({
      ok: false,
      error: { code: 'E_MUTATIONS_PAUSED' },
    });
    expect(mutationFrames.frames.some((frame) => (frame as { type?: string }).type === 'JOB_STATE')).toBe(false);
    expect(pluginFrames.frames.some((frame) => (frame as { id?: string }).id === mutationId)).toBe(false);
  });

  it('leaves a running job alone while terminal-cancelling every queued job with a pollable pause reply', async () => {
    const port = await startTestBroker();
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'p-gate-queue', 'Gate Queue', 'Raw Queue Key');
    const pluginFrames = collectFrames(plugin);
    const cliA = await connectSocket(port);
    const jobA = await sendMutatingJob(cliA, 'c_gate_running');
    await waitFor(() => pluginFrames.frames.some((frame) => (frame as { id?: string }).id === 'c_gate_running'));
    const cliB = await connectSocket(port);
    const jobB = await sendMutatingJob(cliB, 'c_gate_queued_b');
    const cliC = await connectSocket(port);
    const jobC = await sendMutatingJob(cliC, 'c_gate_queued_c');

    const pausedB = nextFrame<ReplyErr>(cliB, (frame) => (frame as ReplyErr).id === 'c_gate_queued_b');
    const pausedC = nextFrame<ReplyErr>(cliC, (frame) => (frame as ReplyErr).id === 'c_gate_queued_c');
    cliA.send(JSON.stringify(makeRequestFrame('c_gate_pause_queue', 'MUTATION_GATE', { mode: 'pause', fileKey: 'Raw Queue Key' })));
    await nextFrame<ReplyOk>(cliA, (frame) => (frame as ReplyOk).id === 'c_gate_pause_queue');

    expect((await pausedB).error.code).toBe('E_MUTATIONS_PAUSED');
    expect((await pausedC).error.code).toBe('E_MUTATIONS_PAUSED');
    expect((await pollJob(cliB, jobB, 'c_gate_poll_b')).job.state).toBe('cancelled');
    const polledC = await pollJob(cliC, jobC, 'c_gate_poll_c');
    expect(polledC.job.state).toBe('cancelled');
    expect(polledC.resultFrames?.join('\n')).toContain('E_MUTATIONS_PAUSED');
    expect((await pollJob(cliA, jobA, 'c_gate_poll_a')).job.state).toBe('running');
    expect(pluginFrames.frames.some((frame) => (frame as { id?: string }).id === 'c_gate_queued_b')).toBe(false);
    expect(pluginFrames.frames.some((frame) => (frame as { id?: string }).id === 'c_gate_queued_c')).toBe(false);
  });

  it('allows only the shared safe-read set through a paused file and ignores caller readOnly claims for executable paths', async () => {
    const port = await startTestBroker();
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'p-gate-safe-reads', 'Gate Safe Reads', 'Raw Safe Reads');
    const pluginFrames = collectFrames(plugin);
    const cli = await connectSocket(port);
    cli.send(JSON.stringify(makeRequestFrame('c_gate_pause_reads', 'MUTATION_GATE', { mode: 'pause', fileKey: 'Raw Safe Reads' })));
    await nextFrame<ReplyOk>(cli, (frame) => (frame as ReplyOk).id === 'c_gate_pause_reads');

    const safeReads = [
      'STATUS', 'GET_SELECTION', 'EXPORT_PNG', 'SCAN_DESIGN_SYSTEM', 'GET_CORRECTION_MEMORY',
      'LIST_CONNECTIONS', 'VERIFY_CONNECTIONS', 'SHADER_GRADIENT_PROBE',
    ] as const;
    for (const [index, cmd] of safeReads.entries()) {
      const id = `c_gate_safe_${index}`;
      cli.send(JSON.stringify(makeRequestFrame(id, cmd, {})));
      await waitFor(() => pluginFrames.frames.some((frame) => (frame as { id?: string }).id === id));
    }

    for (const [index, cmd] of (['EXEC_JS', 'BATCH', 'AUDIT_DS'] as const).entries()) {
      const id = `c_gate_unsafe_${index}`;
      cli.send(JSON.stringify(makeRequestFrame(id, cmd, {}, undefined, undefined, undefined, true)));
      const reply = await nextFrame<ReplyErr>(cli, (frame) => (frame as ReplyErr).id === id);
      expect(reply.error.code).toBe('E_MUTATIONS_PAUSED');
      expect(pluginFrames.frames.some((frame) => (frame as { id?: string }).id === id)).toBe(false);
    }
  });
});

describe('daemon harness — process listeners belong to one daemon lifetime', () => {
  it('restores signal and exception listener counts after BROKER_SHUTDOWN_REQUEST', async () => {
    const events = ['SIGTERM', 'SIGINT', 'uncaughtException'] as const;
    const baseline = Object.fromEntries(events.map((event) => [event, process.listenerCount(event)]));
    const port = await startTestBroker();

    for (const event of events) expect(process.listenerCount(event)).toBe(baseline[event] + 1);

    const cli = await connectSocket(port);
    cli.send(JSON.stringify({ type: 'BROKER_SHUTDOWN_REQUEST' }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    for (const event of events) expect(process.listenerCount(event)).toBe(baseline[event]);
  });
});

describe('daemon harness — duplicate request ids never overwrite reply ownership', () => {
  it('refuses the second socket and delivers the plugin reply only to the first', async () => {
    const port = await startTestBroker();
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'plugin-duplicate-id', 'Duplicate Id File', 'RawDuplicate');
    const pluginFrames = collectFrames(plugin);
    const first = await connectSocket(port);
    const second = await connectSocket(port);
    const secondFrames = collectFrames(second);
    const id = 'c_duplicate_1_1000';
    const request = JSON.stringify(makeRequestFrame(id, 'SET_TEXT', { nodeId: '1:1', text: 'first' }));

    first.send(request);
    await nextFrame<EventMsg>(first, (msg) => (msg as EventMsg).type === 'JOB_STATE');
    await waitFor(() => pluginFrames.frames.some((frame) => (frame as { id?: string }).id === id));

    second.send(request);
    await waitFor(() => secondFrames.frames.some((frame) => (frame as { id?: string }).id === id));
    expect(secondFrames.frames.find((frame) => (frame as { id?: string }).id === id)).toMatchObject({
      id,
      ok: false,
      error: { code: 'E_INVALID_ARGS', message: expect.stringContaining('duplicate request id') },
    });

    const firstReplyPending = nextFrame<ReplyOk>(first, (msg) => (msg as ReplyOk).id === id);
    plugin.send(JSON.stringify({ id, ok: true, result: { owner: 'first' } } satisfies ReplyOk));
    const firstReply = await firstReplyPending;
    expect(firstReply).toMatchObject({ id, ok: true, result: { owner: 'first' } });
    expect(pluginFrames.frames.filter((frame) => (frame as { id?: string }).id === id)).toHaveLength(1);
  });
});

describe('daemon harness — cancel-then-complete never dispatches the cancelled job (BLOCKER 1)', () => {
  it('a QUEUED job cancelled via `job --cancel` is never resurrected when the running job finishes', async () => {
    const port = await startTestBroker();
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'plugin-1', 'F1', 'RawF1');
    const pluginFrames = collectFrames(plugin);

    const cliA = await connectSocket(port);
    const jobA = await sendMutatingJob(cliA, 'req-a');
    await waitFor(() => pluginFrames.frames.some((f) => (f as { id?: string }).id === 'req-a'));

    const cliB = await connectSocket(port);
    const jobB = await sendMutatingJob(cliB, 'req-b'); // QUEUED — plugin busy with job A

    // Cancel the still-queued job B.
    cliB.send(JSON.stringify(makeRequestFrame('req-cancel', 'JOB', { mode: 'cancel', jobId: jobB })));
    const cancelReply = await nextFrame<ReplyOk>(cliB, (m) => (m as ReplyOk).id === 'req-cancel');
    expect(cancelReply.ok).toBe(true);
    expect((cancelReply.result as { ok: boolean }).ok).toBe(true);

    // The plugin answers job A's ORIGINAL request — this is what used to resurrect the
    // cancelled job B via advanceQueue's pop.
    plugin.send(JSON.stringify({ id: 'req-a', ok: true, result: { fileName: 'F1' } } satisfies ReplyOk));
    await new Promise((resolve) => setTimeout(resolve, 200)); // let routeFromPlugin/advanceQueue settle

    // Job B was never dispatched — the plugin received EXACTLY one request frame (job A's).
    const requestFrames = pluginFrames.frames.filter((f) => 'cmd' in (f as Record<string, unknown>));
    expect(requestFrames).toHaveLength(1);
    expect((requestFrames[0] as { id: string }).id).toBe('req-a');

    // Job B's own record still reads 'cancelled', not resurrected into 'running'/'queued'.
    const polled = await pollJob(cliB, jobB, 'req-poll-b');
    expect(polled.job.state).toBe('cancelled');
    expect(jobA).not.toBe(jobB);
  });
});

describe('daemon harness — actual transport loss preserves dispatched mutation uncertainty', () => {
  it('holds the unknown slot, fails queued work, discards late reply, then bare force-release advances once', async () => {
    const port = await startTestBroker();
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'plugin-2', 'F2', 'RawF2');
    const pluginFrames = collectFrames(plugin);

    const cliA = await connectSocket(port);
    const jobA = await sendMutatingJob(cliA, 'req-a2'); // dispatched immediately — RUNNING
    await waitFor(() => pluginFrames.frames.some((f) => (f as { id?: string }).id === 'req-a2'));

    const cliB = await connectSocket(port);
    const jobB = await sendMutatingJob(cliB, 'req-b2'); // QUEUED behind job A

    const errA = nextFrame<ReplyErr>(cliA, (m) => (m as ReplyErr).id === 'req-a2');
    const errB = nextFrame<ReplyErr>(cliB, (m) => (m as ReplyErr).id === 'req-b2');
    plugin.terminate(); // the disconnect
    const [replyA, replyB] = await Promise.all([errA, errB]);
    expect(replyA.ok).toBe(false);
    expect(replyA.error).toEqual({
      code: 'E_OUTCOME_UNKNOWN',
      message: expect.stringContaining('canvas may or may not have changed'),
      jobId: jobA,
      recovery: {
        kind: 'inspect-and-force-release',
        command: `figma-agent job ${jobA} --force-release`,
        requiresCanvasInspection: true,
        retryAllowed: false,
      },
    });
    expect(replyB.ok).toBe(false);
    expect(replyB.error.code).toBe('E_NO_PLUGIN');

    // Job B's own record reads 'failed' — never left dangling in a resurrectable state.
    const polledB = await pollJob(cliB, jobB, 'req-poll-b2');
    expect(polledB.job.state).toBe('failed');
    const polledA = await pollJob(cliA, jobA, 'req-poll-a2');
    expect(polledA.job).toMatchObject({
      state: 'outcome-unknown', jobId: jobA,
      recovery: { command: `figma-agent job ${jobA} --force-release`, retryAllowed: false },
    });

    // Reconnect with the SAME instanceId — no parked/queued work exists to flush.
    const plugin2 = await connectSocket(port);
    await helloPlugin(plugin2, 'plugin-2', 'F2', 'RawF2');
    const plugin2Frames = collectFrames(plugin2);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const dispatched = plugin2Frames.frames.filter((f) => 'cmd' in (f as Record<string, unknown>));
    expect(dispatched).toHaveLength(0);
    const { hello: heldStatus } = await connectAndAwaitBrokerHello(port);
    const heldPlugin = (heldStatus.data as { plugins: Array<{ instanceId: string; runningJob?: JobInfo }> })
      .plugins.find((entry) => entry.instanceId === 'plugin-2');
    expect(heldPlugin?.runningJob).toMatchObject({ jobId: jobA, state: 'outcome-unknown' });

    const cliC = await connectSocket(port);
    const jobC = await sendMutatingJob(cliC, 'req-c2');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(plugin2Frames.frames.some((frame) => (frame as { id?: string }).id === 'req-c2')).toBe(false);

    plugin2.send(JSON.stringify({ id: 'req-a2', ok: true, result: { late: true } } satisfies ReplyOk));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await pollJob(cliA, jobA, 'req-poll-a2-late')).lateReplyCount).toBe(1);
    expect((await pollJob(cliC, jobC, 'req-poll-c2')).job.state).toBe('queued');

    const releasePending = nextFrame<ReplyOk>(cliA, (frame) => (frame as ReplyOk).id === 'req-release-a2');
    cliA.send(JSON.stringify(makeRequestFrame('req-release-a2', 'JOB', {
      mode: 'force-release', jobId: jobA, override: false,
    }, 'Inspect then force-release')));
    expect((await releasePending).result).toEqual({ ok: true });
    await waitFor(() => plugin2Frames.frames.some((frame) => (frame as { id?: string }).id === 'req-c2'));
    expect(plugin2Frames.frames.filter((frame) => (frame as { id?: string }).id === 'req-c2')).toHaveLength(1);
    const releasedA = await pollJob(cliA, jobA, 'req-poll-a2-released');
    expect(releasedA.job).toMatchObject({
      jobId: jobA, state: 'outcome-unknown', finishedAt: expect.any(Number),
      uncertaintyReason: 'plugin transport disconnected after dispatch',
    });
    expect(releasedA.job).not.toHaveProperty('recovery');
    expect((await pollJob(cliC, jobC, 'req-poll-c2-owner')).job.state).toBe('running');
    const secondReleasePending = nextFrame<ReplyOk>(cliA, (frame) => (frame as ReplyOk).id === 'req-release-a2-again');
    cliA.send(JSON.stringify(makeRequestFrame('req-release-a2-again', 'JOB', {
      mode: 'force-release', jobId: jobA, override: false,
    }, 'Duplicate release')));
    expect((await secondReleasePending).result).toMatchObject({ ok: false });
    expect(plugin2Frames.frames.filter((frame) => (frame as { id?: string }).id === 'req-c2')).toHaveLength(1);
  });

  it('keeps a dispatched broker-safe read as a normal E_NO_PLUGIN failure', async () => {
    const port = await startTestBroker();
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'plugin-read-loss', 'Read Loss', 'RawReadLoss');
    const pluginFrames = collectFrames(plugin);
    const cli = await connectSocket(port);
    const statePending = nextFrame<EventMsg>(cli, (frame) => (frame as EventMsg).type === 'JOB_STATE');
    cli.send(JSON.stringify(makeRequestFrame('req-read-loss', 'GET_SELECTION', {})));
    const jobId = ((await statePending).data as unknown as JobInfo).jobId;
    await waitFor(() => pluginFrames.frames.some((frame) => (frame as { id?: string }).id === 'req-read-loss'));

    const failurePending = nextFrame<ReplyErr>(cli, (frame) => (frame as ReplyErr).id === 'req-read-loss');
    plugin.terminate();
    expect((await failurePending).error).toEqual({
      code: 'E_NO_PLUGIN', message: 'Figma plugin disconnected mid-request',
    });
    expect((await pollJob(cli, jobId, 'req-read-loss-poll')).job.state).toBe('failed');
  });
});

describe('daemon harness — a watchdog-failed job answered late returns the timeout outcome + lateReplyCount, never E_CHUNK_LOST (closing round R1+R2)', () => {
  it('the late reply is discarded and counted, the ORIGINAL E_TIMEOUT outcome survives', async () => {
    const port = await startTestBroker({ [WATCHDOG_MS_KEY]: '150' }); // real watchdog, shrunk
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'plugin-3', 'F3', 'RawF3');
    const pluginFrames = collectFrames(plugin);

    const cliA = await connectSocket(port);
    const jobA = await sendMutatingJob(cliA, 'req-a3');
    await waitFor(() => pluginFrames.frames.some((f) => (f as { id?: string }).id === 'req-a3'));
    // Plugin stays silent — the watchdog interval (min cadence 1s, regardless of how small
    // WATCHDOG_TIMEOUT_MS is set) is what finishes this job, not a script reply.

    const cliPoll = await connectSocket(port);
    let seq = 0;
    await waitFor(async () => {
      const p = await pollJob(cliPoll, jobA, `req-poll-a3-${seq++}`);
      return p.job.state === 'failed';
    }, 5_000, 150);

    // The late reply — the plugin finally answers the ORIGINAL request, after the watchdog
    // already finished it. This must be discarded, never corrupt replyFrames.
    plugin.send(JSON.stringify({ id: 'req-a3', ok: true, result: { fileName: 'F3' } } satisfies ReplyOk));
    await new Promise((resolve) => setTimeout(resolve, 200));

    const final = await pollJob(cliPoll, jobA, 'req-poll-a3-final');
    expect(final.job.state).toBe('failed'); // the ORIGINAL watchdog outcome, not flipped to done
    expect(final.lateReplyCount).toBeGreaterThan(0);
    expect(final.resultFrames).toBeDefined();
    // The stored reply is the ORIGINAL single E_TIMEOUT frame — parses clean, never a
    // corrupted multi-frame reassembly (the actual old bug: [timeoutErr, realReply] read
    // back as a broken chunk sequence → E_CHUNK_LOST).
    expect(final.resultFrames).toHaveLength(1);
    const parsed = JSON.parse(final.resultFrames![0]!) as ReplyErr;
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe('E_TIMEOUT');
  });

  it('releases a watchdog-held slot once on transport close without fabricating a late reply, then expires it from release time', async () => {
    let controlledNow = 1_000_000;
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => controlledNow);
    try {
      const port = await startTestBroker({ [WATCHDOG_MS_KEY]: '150', [PLUGIN_WAIT_MS_KEY]: '800' });
      const plugin = await connectSocket(port);
      await helloPlugin(plugin, 'plugin-watchdog-close', 'Watchdog Close', 'RawWatchdogClose');
      const pluginFrames = collectFrames(plugin);
      const cliA = await connectSocket(port);
      const jobA = await sendMutatingJob(cliA, 'req-watchdog-close-a');
      await waitFor(() => pluginFrames.frames.some((f) => (f as { id?: string }).id === 'req-watchdog-close-a'));

      const cliB = await connectSocket(port);
      const jobB = await sendMutatingJob(cliB, 'req-watchdog-close-b');
      controlledNow += 151;
      await waitFor(async () => (await pollJob(cliA, jobA, 'req-watchdog-close-watchdog')).job.state === 'failed');

      const held = await pollJob(cliA, jobA, 'req-watchdog-close-held');
      expect(held.resultFrames).toHaveLength(1);
      expect(JSON.parse(held.resultFrames![0]!) as ReplyErr).toMatchObject({
        ok: false,
        error: { code: 'E_TIMEOUT' },
      });
      expect(held.lateReplyCount).toBeUndefined();

      const closeA = nextFrame<ReplyErr>(cliA, (m) => (m as ReplyErr).id === 'req-watchdog-close-a');
      const closeB = nextFrame<ReplyErr>(cliB, (m) => (m as ReplyErr).id === 'req-watchdog-close-b');
      plugin.terminate();
      expect((await closeA).error.code).toBe('E_NO_PLUGIN');
      expect((await closeB).error.code).toBe('E_NO_PLUGIN');

      const afterClose = await pollJob(cliA, jobA, 'req-watchdog-close-after');
      expect(afterClose.resultFrames).toEqual(held.resultFrames);
      expect(afterClose.lateReplyCount).toBeUndefined();
      expect((await pollJob(cliB, jobB, 'req-watchdog-close-b-after')).job.state).toBe('failed');
      expect(pluginFrames.frames.filter((f) => (f as { id?: string }).id === 'req-watchdog-close-b')).toHaveLength(0);

      const contentionPath = join(scratchDir, 'figma-contention.json');
      await waitFor(() => existsSync(contentionPath));
      const contention = JSON.parse(readFileSync(contentionPath, 'utf8')) as ContentionStore;
      expect(Object.values(contention.RawWatchdogClose!)[0]!.jobCount).toBe(2);

      controlledNow += JOB_TTL_MS + 1;
      await new Promise((resolve) => setTimeout(resolve, 250));
      const expired = nextFrame<ReplyErr>(cliA, (m) => (m as ReplyErr).id === 'req-watchdog-close-expired');
      cliA.send(JSON.stringify(makeRequestFrame('req-watchdog-close-expired', 'JOB', { mode: 'poll', jobId: jobA })));
      expect((await expired).error.code).toBe('E_JOB_EXPIRED');
    } finally {
      dateNow.mockRestore();
    }
  });
});

describe('daemon harness — EDIT_FEED routes through the binding index, never the broker\'s spawn cwd (backlog 5.7)', () => {
  it('an unbound batch stages; PROJECT_BIND migrates it into the bound project\'s OWN edit feed; a later batch lands there directly', async () => {
    const port = await startTestBroker();
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'plugin-edit-1', 'Platform - Design System');

    const slug = 'platform-design-system'; // safeSlug('Platform - Design System')
    // Issue #7 (backlog 5.6): staging now roots at the cwd-independent unbound-root
    // scratch dir, never `scratchDir`/`FIGMA_AGENT_CHANGES_DIR` itself.
    const stagingPath = join(scratchDir, 'unbound-root', 'changes', 'unbound', `${slug}.jsonl`);
    // The broker's own cwd-derived default — a Platform DS edit landing HERE (VSF-PCP's
    // tree, in the real live-traced incident) is the exact misattribution 5.7 fixes.
    const cwdDefaultPath = join(scratchDir, 'changes', `${slug}.jsonl`);

    // Unbound: sent before any bind exists for this identity.
    sendEditFeed(plugin, [
      { op: 'deleted', nodeId: 'n1', nodeName: 'Subtitle', nodeType: 'TEXT', parentName: 'Roles / Detail', changedProps: [], origin: 'LOCAL', page: 'Screens', actor: 'owner' },
    ], { fileKey: null, fileName: 'Platform - Design System' });
    await waitFor(() => existsSync(stagingPath));
    expect(readFileSync(stagingPath, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(existsSync(cwdDefaultPath)).toBe(false); // never the broker's own cwd default

    const boundProjectDir = mkdtempSync(join(tmpdir(), 'fa-bound-project-'));
    try {
      const cli = await connectSocket(port);
      const bindResult = await bindProject(cli, 'Platform - Design System', boundProjectDir, 'req-bind-1');
      expect(bindResult.migratedEditCount).toBe(1);

      const boundFeedPath = join(boundProjectDir, 'design', 'changes', `${slug}.jsonl`);
      expect(existsSync(boundFeedPath)).toBe(true); // migrated into the REAL bound project
      expect(existsSync(stagingPath)).toBe(false); // staging cleaned up after migration

      // A second, now-bound batch — lands DIRECTLY in the bound project, never staged,
      // never the broker's cwd default.
      sendEditFeed(plugin, [
        { op: 'updated', nodeId: 'n2', nodeName: 'CTA', nodeType: 'TEXT', parentName: 'Hero', changedProps: ['characters'], origin: 'LOCAL', page: 'Screens', actor: 'owner' },
      ], { fileKey: null, fileName: 'Platform - Design System' });
      await waitFor(() => readFileSync(boundFeedPath, 'utf8').trim().split('\n').length === 2);
      expect(existsSync(cwdDefaultPath)).toBe(false); // still never touches the cwd default
      expect(existsSync(stagingPath)).toBe(false); // never re-created
    } finally {
      rmSync(boundProjectDir, { recursive: true, force: true });
    }
  });
});

describe('daemon harness — pendingKey→fileKey promotion merges the edit feed, never splits it (stage-4 fix round, M2)', () => {
  it('a name-slug-keyed feed migrates into the fileKey-keyed feed the moment FILE_INFO reveals a real fileKey', async () => {
    const port = await startTestBroker();
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'plugin-edit-2', 'Platform - Design System');

    const slug = 'platform-design-system';
    const realFileKey = 'REAL-FILE-KEY-123';
    const boundProjectDir = mkdtempSync(join(tmpdir(), 'fa-bound-project-m2-'));
    try {
      // A real project always already has SOME design/ dir — resolveProjectDir's own
      // isUsable() treats a project without one as "stopped looking like a project"
      // (never a fallback guess), so the fixture pre-creates it the way a genuine bind
      // target would already have one.
      mkdirSync(join(boundProjectDir, 'design'), { recursive: true });
      // Bind BY NAME while the plugin's own fileKey is still unknown (null) — the common
      // "bind before the file has a real key" case (a Figma-Free file, or simply binding
      // before this session ever sent FILE_INFO with one).
      const cli = await connectSocket(port);
      await bindProject(cli, 'Platform - Design System', boundProjectDir, 'req-bind-m2');

      const slugFeedPath = join(boundProjectDir, 'design', 'changes', `${slug}.jsonl`);
      const keyFeedPath = join(boundProjectDir, 'design', 'changes', `${realFileKey}.jsonl`);

      // Still routes by name-slug — fileKey isn't known to this batch yet either.
      sendEditFeed(plugin, [
        { op: 'deleted', nodeId: 'n1', nodeName: 'Subtitle', nodeType: 'TEXT', parentName: 'Roles / Detail', changedProps: [], origin: 'LOCAL', page: 'Screens', actor: 'owner' },
      ], { fileKey: null, fileName: 'Platform - Design System' });
      await waitFor(() => existsSync(slugFeedPath));
      expect(readFileSync(slugFeedPath, 'utf8').trim().split('\n')).toHaveLength(1);

      // FILE_INFO reveals the real fileKey for the first time — triggers promotePendingBind.
      sendFileInfo(plugin, 'Platform - Design System', realFileKey);
      await waitFor(() => existsSync(keyFeedPath));

      // The name-slug feed is GONE (migrated away), never left to silently diverge.
      expect(existsSync(slugFeedPath)).toBe(false);
      expect(readFileSync(keyFeedPath, 'utf8').trim().split('\n')).toHaveLength(1);

      // A THIRD batch, now carrying the real fileKey (as a live plugin would from here on) —
      // lands in the SAME fileKey feed, never re-creating the name-slug one.
      sendEditFeed(plugin, [
        { op: 'updated', nodeId: 'n2', nodeName: 'CTA', nodeType: 'TEXT', parentName: 'Hero', changedProps: ['characters'], origin: 'LOCAL', page: 'Screens', actor: 'owner' },
      ], { fileKey: realFileKey, fileName: 'Platform - Design System' });
      await waitFor(() => readFileSync(keyFeedPath, 'utf8').trim().split('\n').length === 2);
      expect(existsSync(slugFeedPath)).toBe(false); // never re-created
    } finally {
      rmSync(boundProjectDir, { recursive: true, force: true });
    }
  });
});

describe('daemon harness — EDIT_FEED with no data.fileName falls back to the registry scene, never "unknown" (closing round, N4)', () => {
  it('a payload missing fileName entirely still routes to the bound project\'s real slug, not unknown.jsonl', async () => {
    const port = await startTestBroker();
    const plugin = await connectSocket(port);
    // HELLO gives the registry a real fileName — this is what N4's fallback reads.
    await helloPlugin(plugin, 'plugin-edit-n4', 'Platform - Design System');

    const slug = 'platform-design-system';
    const boundProjectDir = mkdtempSync(join(tmpdir(), 'fa-bound-project-n4-'));
    mkdirSync(join(boundProjectDir, 'design'), { recursive: true });
    try {
      const cli = await connectSocket(port);
      await bindProject(cli, 'Platform - Design System', boundProjectDir, 'req-bind-n4');

      const boundFeedPath = join(boundProjectDir, 'design', 'changes', `${slug}.jsonl`);
      const unknownFeedPath = join(boundProjectDir, 'design', 'changes', 'unknown.jsonl');

      // The stale-build payload — no `fileName` key at all.
      sendEditFeedWithoutFileName(plugin, [
        { op: 'deleted', nodeId: 'n1', nodeName: 'Subtitle', nodeType: 'TEXT', parentName: 'Roles / Detail', changedProps: [], origin: 'LOCAL', page: 'Screens', actor: 'owner' },
      ], null);
      await waitFor(() => existsSync(boundFeedPath));

      expect(readFileSync(boundFeedPath, 'utf8').trim().split('\n')).toHaveLength(1);
      expect(existsSync(unknownFeedPath)).toBe(false); // never the permanent-loss bucket
    } finally {
      rmSync(boundProjectDir, { recursive: true, force: true });
    }
  });
});

describe('daemon harness — the error log routes through the binding index, never a once-cached default (issue #7, backlog 5.9)', () => {
  it('an unbound ReplyErr stages; PROJECT_BIND migrates it into the bound project\'s OWN error log; a later error lands there directly', async () => {
    const port = await startTestBroker();
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'plugin-err-1', 'Platform - Design System');

    const slug = 'platform-design-system';
    const stagingPath = join(scratchDir, 'unbound-root', 'errors', 'unbound', `${slug}.jsonl`);

    // Unbound: sent before any bind exists for this identity.
    sendReplyErr(plugin, 'req-err-1', { code: 'E_EVAL', message: 'boom 1' });
    await waitFor(() => existsSync(stagingPath));
    expect(readFileSync(stagingPath, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(readFileSync(stagingPath, 'utf8').trim())).toMatchObject({ code: 'E_EVAL', message: 'boom 1' });

    const boundProjectDir = mkdtempSync(join(tmpdir(), 'fa-bound-project-err-'));
    try {
      const cli = await connectSocket(port);
      const bindResult = await bindProject(cli, 'Platform - Design System', boundProjectDir, 'req-bind-err-1');
      expect(bindResult.migratedErrorCount).toBe(1);

      const boundErrorPath = join(boundProjectDir, 'design', 'figma-errors.jsonl');
      expect(existsSync(boundErrorPath)).toBe(true); // migrated into the REAL bound project
      expect(existsSync(stagingPath)).toBe(false); // staging cleaned up after migration

      // A second, now-bound error — lands DIRECTLY in the bound project, never staged.
      sendReplyErr(plugin, 'req-err-2', { code: 'E_PLUGIN_ERROR', message: 'boom 2' });
      await waitFor(() => readFileSync(boundErrorPath, 'utf8').trim().split('\n').length === 2);
      expect(existsSync(stagingPath)).toBe(false); // never re-created
    } finally {
      rmSync(boundProjectDir, { recursive: true, force: true });
    }
  });
});

describe('daemon harness — one-time startup migration of the OLD unbound-staging root (issue #7, backlog 5.6)', () => {
  it('migrates BOTH the change-log\'s and the edit feed\'s legacy staging into the new cwd-independent root, in one boot', async () => {
    // Simulate a prior broker build's leftover staging at BOTH old locations
    // (`<FIGMA_AGENT_CHANGES_DIR>/unbound/<slug>.jsonl` for change-log, and
    // `<FIGMA_AGENT_CHANGES_DIR>/changes/unbound/<slug>.jsonl` for the edit feed) —
    // created BEFORE the broker (and its startup migration) ever runs.
    const changeSlug = 'legacy-change';
    const editSlug = 'legacy-edit';
    const legacyChangePath = join(scratchDir, 'unbound', `${changeSlug}.jsonl`);
    const legacyEditPath = join(scratchDir, 'changes', 'unbound', `${editSlug}.jsonl`);
    mkdirSync(join(scratchDir, 'unbound'), { recursive: true });
    mkdirSync(join(scratchDir, 'changes', 'unbound'), { recursive: true });
    writeFileSync(legacyChangePath, `${JSON.stringify({ nodeId: 'a' })}\n`, 'utf8');
    writeFileSync(legacyEditPath, `${JSON.stringify({ nodeId: 'b' })}\n`, 'utf8');

    await startTestBroker();

    const newChangePath = join(scratchDir, 'unbound-root', 'unbound', `${changeSlug}.jsonl`);
    const newEditPath = join(scratchDir, 'unbound-root', 'changes', 'unbound', `${editSlug}.jsonl`);
    await waitFor(() => existsSync(newChangePath) && existsSync(newEditPath));
    expect(existsSync(legacyChangePath)).toBe(false); // cleaned up at the old location
    expect(existsSync(legacyEditPath)).toBe(false);
    expect(readFileSync(newChangePath, 'utf8').trim()).toBe(JSON.stringify({ nodeId: 'a' }));
    expect(readFileSync(newEditPath, 'utf8').trim()).toBe(JSON.stringify({ nodeId: 'b' }));
    // Breadcrumb written so a future restart never re-scans.
    expect(existsSync(join(scratchDir, 'unbound-root', '.legacy-migrated'))).toBe(true);
  });

  // Stage-4 fix (reviewer finding 1) — a migration failure must DEFER, not ABORT: the
  // broker still has to come up and accept connections, since this is a best-effort
  // move of already-safe, already-retryable staging data, not a reason to keep the
  // whole relay from ever accepting a connection.
  it('a migration failure defers (never aborts) startup — the broker still accepts connections and surfaces the deferral', async () => {
    // A regular FILE where `legacyUnboundStagingDir()` expects a DIRECTORY —
    // `readdirSync` throws ENOTDIR on it, a real filesystem failure, no mocking needed.
    writeFileSync(join(scratchDir, 'unbound'), 'not a directory', 'utf8');

    const port = await startTestBroker();
    const { hello } = await connectAndAwaitBrokerHello(port);
    expect((hello.data as { legacyMigrationDeferred?: boolean }).legacyMigrationDeferred).toBe(true);

    // The broker is genuinely up and serving — not just alive enough to answer HELLO.
    await helloPlugin(await connectSocket(port), 'plugin-legacy-fail', 'Some File');

    // No breadcrumb written — a future restart must retry the migration, not skip it
    // forever having never actually succeeded.
    expect(existsSync(join(scratchDir, 'unbound-root', '.legacy-migrated'))).toBe(false);
  });
});

// Broker hardening (issue #5), item 2 — heartbeat self-heal, guarded. The
// advertisement-refresh interval must re-advertise if its own file vanishes while
// the broker is still alive (a disk cleaner, another tool's stale-file sweep, an
// accidental `rm` — anything short of the broker itself deciding to exit), but a
// broker that HAS decided to exit must never have a later tick of that same
// interval resurrect the file it just deliberately removed.
//
// FIGMA_AGENT_HEARTBEAT_MS shrinks the refresh cadence so this observes real
// interval ticks instead of waiting out the real 30s production cadence — this
// override only works because the refresh interval now reads the same env-derived
// `HEARTBEAT_MS` the WS-ping interval already used (pre-fix, the refresh interval
// was hardcoded to the raw `HEARTBEAT_INTERVAL_MS` constant and un-overridable).
//
// This test fails against pre-fix code: with no `ownsAdvertisement` guard, the
// interval's `writeAdvertisement` call after BROKER_SHUTDOWN_REQUEST is
// unconditional, so the file reappears within one tick of the shutdown that just
// removed it (the `exit` stub in this harness throws rather than truly halting the
// process, so the interval keeps ticking exactly like a real hung shutdown would).
describe('daemon harness — advertisement self-heals while alive, never resurrects after a clean shutdown (issue #5)', () => {
  afterEach(() => {
    delete process.env.FIGMA_AGENT_HEARTBEAT_MS; // don't leak a shrunk cadence into later tests
  });

  it('re-advertises when its file is deleted out from under it, but stays gone after BROKER_SHUTDOWN_REQUEST', async () => {
    const port = await startTestBroker({ FIGMA_AGENT_HEARTBEAT_MS: '150' });
    const cli = await connectSocket(port);

    expect(existsSync(advertisePath)).toBe(true); // startTestBroker's own startup write
    const originalPid = (JSON.parse(readFileSync(advertisePath, 'utf8')) as { pid: number }).pid;

    // Simulate the file vanishing while the broker is still very much alive.
    rmSync(advertisePath);
    expect(existsSync(advertisePath)).toBe(false);

    await waitFor(() => existsSync(advertisePath), 1_000, 20);
    const healed = JSON.parse(readFileSync(advertisePath, 'utf8')) as { pid: number };
    expect(healed.pid).toBe(originalPid); // the SAME broker re-advertised — no competing spawn

    // Now shut it down for real via the daemon's own designed path.
    cli.send(JSON.stringify({ type: 'BROKER_SHUTDOWN_REQUEST' }));
    await waitFor(() => !existsSync(advertisePath), 1_000, 20);

    // Give the refresh interval several more ticks. Pre-fix, the very next tick's
    // unconditional writeAdvertisement() resurrects the file this shutdown just
    // removed.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(existsSync(advertisePath)).toBe(false);
  });
});

// Backlog 2.10 audit — sender verification in routeFromPlugin. AUDIT FINDING:
// `routeFromPlugin` routed a reply frame to the waiting CLI keyed on `id` ALONE — it
// never checked which socket actually sent the frame against `job.targetInstanceId`
// (the plugin instance the job was dispatched to, pinned at admission). ANY other
// currently-connected plugin instance sending a reply carrying the same `id` was
// accepted and forwarded as if it were the real dispatched plugin's answer. Reachable
// in practice via a CLI-side request-id collision: ids are minted `c_<counter>_<ts>`
// per CLI PROCESS (`requestCounter` resets to 0 on every fresh `figma-agent` invocation),
// so two concurrent CLI invocations issuing their first command in the same millisecond
// produce identical ids. The fix (job-table.ts's `isReplyFromDispatchedInstance`,
// wired into `routeFromPlugin` with the sender's `ws`) verifies by INSTANCE IDENTITY,
// not raw socket reference, so an honest plugin reconnect (new ws, same instanceId)
// still completes its own job normally — only a genuinely different instance's reply
// is discarded.
describe('daemon harness — routeFromPlugin verifies the reply sender against the dispatched instance (backlog 2.10)', () => {
  it('a reply from a DIFFERENT plugin instance carrying the dispatched job\'s id is discarded, not delivered to the waiting CLI', async () => {
    const port = await startTestBroker();
    const pluginX = await connectSocket(port);
    const pluginY = await connectSocket(port);
    await helloPlugin(pluginX, 'inst-x', 'FileX', 'RawFileX');
    await helloPlugin(pluginY, 'inst-y', 'FileY', 'RawFileY');

    const cli = await connectSocket(port);
    const reqId = 'req-sender-verify-1';
    // `expectedFile` pins dispatch to X specifically — two plugins are connected, so
    // dispatch must not depend on ambient recency to land on X.
    cli.send(JSON.stringify(makeRequestFrame(reqId, 'SET_TEXT', { nodeId: '1:1', text: 'x' }, undefined, 'FileX')));
    await nextFrame(cli, (m) => (m as EventMsg).type === 'JOB_STATE'); // dispatch confirmed

    // Y (a DIFFERENT, genuinely connected instance) sends a reply carrying X's dispatched
    // id — simulating the collision/cross-talk this audit exists to catch.
    pluginY.send(JSON.stringify({ id: reqId, ok: true, result: { spoofed: true, from: 'Y' } }));

    // X (the REAL dispatched target) sends its own, later, genuine reply.
    pluginX.send(JSON.stringify({ id: reqId, ok: true, result: { spoofed: false, from: 'X' } }));

    const reply = await nextFrame<ReplyOk>(cli, (m) => (m as ReplyOk | ReplyErr).id === reqId);
    // The FIRST (and only) frame the CLI actually receives for this id must be X's real
    // reply — Y's spoofed frame must never have reached it at all.
    expect(reply.result).toEqual({ spoofed: false, from: 'X' });
  });

  // NOTE on reconnect: a full end-to-end "reconnect, then the NEW socket answers the
  // OLD dispatched id" integration test is not exercised here, because it races an
  // orthogonal, PRE-EXISTING behavior — `handleClose`'s disconnect-triggered job
  // failure. The daemon closes the superseded (pre-reconnect) socket itself the
  // moment the SAME instanceId re-HELLOs; that socket's 'close' event fires
  // `handleClose`, which fails every job still pinned to it (E_NO_PLUGIN) BEFORE the
  // reconnected socket could plausibly answer — unaffected by this fix either way.
  // The identity-vs-socket-reference distinction this fix actually adds (an honest
  // reconnect must not be misread as "a different instance") is proven directly and
  // deterministically at the predicate level instead — see
  // tests/job-table-sender-verification.test.ts.

  // Issue #15 (PR #14 review, non-blocking) — the discard above incremented a
  // `senderMismatchCount` that was LOG-ONLY: no machine-readable trace of a spoofed/
  // misrouted reply existed anywhere a caller could read. This repo's own law
  // ("nothing vanishes silently") already surfaces this exact counter class
  // (resultDropped, lateReplyCount) in envelopes — a discarded cross-instance reply is
  // the most security-relevant member of that class, so it must surface too.
  it('a discarded cross-instance reply bumps senderMismatchCount, visible on a fresh BROKER_HELLO', async () => {
    const port = await startTestBroker();
    const pluginX = await connectSocket(port);
    const pluginY = await connectSocket(port);
    await helloPlugin(pluginX, 'inst-x', 'FileX', 'RawFileX');
    await helloPlugin(pluginY, 'inst-y', 'FileY', 'RawFileY');

    const cli = await connectSocket(port);
    const reqId = 'req-sender-verify-mismatch-count';
    cli.send(JSON.stringify(makeRequestFrame(reqId, 'SET_TEXT', { nodeId: '1:1', text: 'x' }, undefined, 'FileX')));
    await nextFrame(cli, (m) => (m as EventMsg).type === 'JOB_STATE');

    // Y spoofs X's dispatched id — discarded by isReplyFromDispatchedInstance.
    pluginY.send(JSON.stringify({ id: reqId, ok: true, result: { spoofed: true, from: 'Y' } }));
    pluginX.send(JSON.stringify({ id: reqId, ok: true, result: { spoofed: false, from: 'X' } }));
    await nextFrame<ReplyOk>(cli, (m) => (m as ReplyOk | ReplyErr).id === reqId); // drain X's real reply

    // A NEW connection's BROKER_HELLO greeting (the same data `figma-agent status`
    // reads via fetchBrokerHello) must now report the mismatch — daemon-scoped, not
    // per-job, so it must be visible from ANY connection, not just the original CLI.
    // `connectAndAwaitBrokerHello` (not `connectSocket` + `nextFrame`) is deliberate: the
    // broker sends this greeting synchronously in its 'connection' handler, which can
    // race this client's own 'open' event — see that helper's own doc.
    const { hello } = await connectAndAwaitBrokerHello(port);
    expect((hello.data as Record<string, unknown>).senderMismatchCount).toBe(1);
  });
});

describe('daemon harness — SYNC_CONFIG idleMs routes through the binding, never the broker\'s spawn cwd (issue #20)', () => {
  it('a plugin bound to a project with its OWN figma-sync.json gets THAT idleMs, not the broker cwd default, on HELLO after the bind', async () => {
    // Simulates the broker being spawned from "Project A"'s cwd — its own idle window,
    // distinct from the project this daemon ends up serving.
    writeFileSync(join(scratchDir, 'figma-sync.json'), JSON.stringify({ idleMs: 111_000 }), 'utf8');
    const port = await startTestBroker();

    const boundProjectDir = mkdtempSync(join(tmpdir(), 'fa-sync-bound-project-'));
    try {
      mkdirSync(join(boundProjectDir, 'design'), { recursive: true });
      // "Project B" — the project this file is actually bound to — has its OWN idle
      // window, deliberately different from the broker's cwd default above.
      writeFileSync(join(boundProjectDir, 'design', 'figma-sync.json'), JSON.stringify({ idleMs: 222_000 }), 'utf8');

      const plugin = await connectSocket(port);
      await helloPlugin(plugin, 'plugin-sync-1', 'Project B File');

      const cli = await connectSocket(port);
      await bindProject(cli, 'Project B File', boundProjectDir, 'req-bind-sync-1');

      // A fresh HELLO for the SAME (now-bound) file — e.g. a plugin reconnect, or the
      // broker itself having restarted from a different cwd in the meantime. The file
      // identity is bound to Project B, so its SYNC_CONFIG must reflect Project B's own
      // figma-sync.json, never the broker's spawn-cwd default (Project A's 111_000).
      const plugin2 = await connectSocket(port);
      const syncConfigPromise = nextFrame<EventMsg>(plugin2, (m) => (m as EventMsg).type === 'SYNC_CONFIG');
      plugin2.send(JSON.stringify({
        type: 'PLUGIN_HELLO',
        data: { instanceId: 'plugin-sync-2', fileName: 'Project B File', fileKey: null, caps: ['fileGuard'] },
      } satisfies EventMsg));
      const syncConfig = await syncConfigPromise;
      expect((syncConfig.data as { idleMs: number }).idleMs).toBe(222_000);
    } finally {
      rmSync(boundProjectDir, { recursive: true, force: true });
    }
  });

  it('an ALREADY-CONNECTED plugin gets an updated SYNC_CONFIG the moment its file is bound, without needing to reconnect — and an unrelated plugin bound to a DIFFERENT project gets nothing', async () => {
    writeFileSync(join(scratchDir, 'figma-sync.json'), JSON.stringify({ idleMs: 111_000 }), 'utf8');
    const port = await startTestBroker();

    const boundProjectDir = mkdtempSync(join(tmpdir(), 'fa-sync-bound-project-live-'));
    const otherProjectDir = mkdtempSync(join(tmpdir(), 'fa-sync-other-project-'));
    try {
      mkdirSync(join(boundProjectDir, 'design'), { recursive: true });
      writeFileSync(join(boundProjectDir, 'design', 'figma-sync.json'), JSON.stringify({ idleMs: 333_000 }), 'utf8');
      mkdirSync(join(otherProjectDir, 'design'), { recursive: true });
      writeFileSync(join(otherProjectDir, 'design', 'figma-sync.json'), JSON.stringify({ idleMs: 444_000 }), 'utf8');

      // An unrelated plugin, already bound to a DIFFERENT project, connected BEFORE
      // Project C's bind fires — proves the post-bind push targets the one socket whose
      // file was just bound, never every connected plugin.
      const pluginOther = await connectSocket(port);
      await helloPlugin(pluginOther, 'plugin-sync-other-1', 'Project Other File');
      const cliOther = await connectSocket(port);
      await bindProject(cliOther, 'Project Other File', otherProjectDir, 'req-bind-sync-other-1');
      const otherFrames = collectFrames(pluginOther); // observe from here on — its own HELLO/bind traffic already drained

      const plugin = await connectSocket(port);
      await helloPlugin(plugin, 'plugin-sync-live-1', 'Project C File'); // unbound: gets the broker-cwd default

      const postBindSyncConfig = nextFrame<EventMsg>(plugin, (m) => (m as EventMsg).type === 'SYNC_CONFIG');
      const cli = await connectSocket(port);
      await bindProject(cli, 'Project C File', boundProjectDir, 'req-bind-sync-live-1');

      const syncConfig = await postBindSyncConfig;
      expect((syncConfig.data as { idleMs: number }).idleMs).toBe(333_000);

      // Give the unrelated plugin's socket a beat to receive anything it's going to
      // receive, then assert it got NOTHING out of Project C's bind — targeted, not
      // broadcast.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(otherFrames.frames.some((f) => (f as EventMsg).type === 'SYNC_CONFIG')).toBe(false);
    } finally {
      rmSync(boundProjectDir, { recursive: true, force: true });
      rmSync(otherProjectDir, { recursive: true, force: true });
    }
  });

  it('SYNC_CONFIG carries `bound` (auto-connect slice 2, fix round) — false for an unbound HELLO, true after PROJECT_BIND, true on a fresh HELLO for an already-bound file', async () => {
    const port = await startTestBroker();
    const boundProjectDir = mkdtempSync(join(tmpdir(), 'fa-sync-bound-flag-'));
    try {
      mkdirSync(join(boundProjectDir, 'design'), { recursive: true });

      // 1. Unbound HELLO → bound:false.
      const plugin = await connectSocket(port);
      const helloSyncConfig = nextFrame<EventMsg>(plugin, (m) => (m as EventMsg).type === 'SYNC_CONFIG');
      plugin.send(JSON.stringify({
        type: 'PLUGIN_HELLO',
        data: { instanceId: 'plugin-bound-flag-1', fileName: 'Bound Flag File', fileKey: null, caps: ['fileGuard'] },
      } satisfies EventMsg));
      expect(((await helloSyncConfig).data as { bound: boolean }).bound).toBe(false);

      // 2. PROJECT_BIND while still connected → the live push carries bound:true.
      const postBindSyncConfig = nextFrame<EventMsg>(plugin, (m) => (m as EventMsg).type === 'SYNC_CONFIG');
      const cli = await connectSocket(port);
      await bindProject(cli, 'Bound Flag File', boundProjectDir, 'req-bind-flag-1');
      expect(((await postBindSyncConfig).data as { bound: boolean }).bound).toBe(true);

      // 3. A FRESH HELLO for the same (now-bound) file also reads bound:true.
      const plugin2 = await connectSocket(port);
      const reHelloSyncConfig = nextFrame<EventMsg>(plugin2, (m) => (m as EventMsg).type === 'SYNC_CONFIG');
      plugin2.send(JSON.stringify({
        type: 'PLUGIN_HELLO',
        data: { instanceId: 'plugin-bound-flag-2', fileName: 'Bound Flag File', fileKey: null, caps: ['fileGuard'] },
      } satisfies EventMsg));
      expect(((await reHelloSyncConfig).data as { bound: boolean }).bound).toBe(true);
    } finally {
      rmSync(boundProjectDir, { recursive: true, force: true });
    }
  });
});

// `--instance <id>` admission — exercises the real `admitRequest` closure via a real
// in-process broker started with its own scratch advertisement path, ephemeral port,
// and log file, so it never touches a live plugin session's broker discovery.
describe('daemon harness — admitRequest with an `--instance` (expectedInstance) filter', () => {
  it('a keyless mutation with an unmatched instance refuses E_FILE_KEY_UNAVAILABLE instead of parking by name', async () => {
    // The durable mutation gate supersedes the old keyless parking behavior: an instance
    // name is not a raw fileKey, so it cannot snapshot an admission revision safely.
    const port = await startTestBroker({ [PLUGIN_WAIT_MS_KEY]: '200' });
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'inst-live', 'FileLive');

    const cli = await connectSocket(port);
    const reqId = 'req-instance-not-connected';
    cli.send(JSON.stringify(
      makeRequestFrame(reqId, 'SET_TEXT', { nodeId: '1:1', text: 'x' }, undefined, undefined, undefined, undefined, 'inst-gone'),
    ));
    const reply = await nextFrame<ReplyErr>(cli, (m) => (m as ReplyOk | ReplyErr).id === reqId);
    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe('E_FILE_KEY_UNAVAILABLE');
    expect(reply.error.message).toContain('targetFileKey');
  });

  it('two plugins sharing the SAME fileName ("Untitled") → --instance routes to the exact one, never the other', async () => {
    const port = await startTestBroker();
    const pluginA = await connectSocket(port);
    const pluginB = await connectSocket(port);
    await helloPlugin(pluginA, 'inst-a', 'Untitled', 'RawUntitledA');
    await helloPlugin(pluginB, 'inst-b', 'Untitled', 'RawUntitledB');
    const framesA = collectFrames(pluginA);
    const framesB = collectFrames(pluginB);

    const cli = await connectSocket(port);
    const reqId = 'req-instance-exact';
    cli.send(JSON.stringify(
      makeRequestFrame(reqId, 'SET_TEXT', { nodeId: '1:1', text: 'x' }, undefined, undefined, undefined, undefined, 'inst-b'),
    ));
    await nextFrame(cli, (m) => (m as EventMsg).type === 'JOB_STATE');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(framesB.frames.some((f) => (f as { id?: string }).id === reqId)).toBe(true);
    expect(framesA.frames.some((f) => (f as { id?: string }).id === reqId)).toBe(false);
  });
});

// `job --force-release` guard (a HEALTHY still-running job is refused unless `--force`
// overrides it; a watchdog-wedged job keeps unwedging with a bare `--force-release`) —
// exercises the real `handleJobCommand`/`advanceQueue` closures via a real in-process
// broker, isolated from a live plugin session's broker discovery the same way as above.
describe('daemon harness — force-release refuses a HEALTHY running job, allows `--force`, never regresses the wedged-unwedge path', () => {
  it('unfiltered routing sends to older ready A instead of newer stale B without probing B', async () => {
    const port = await startTestBroker({ [APP_READINESS_MS_KEY]: '200', [PLUGIN_WAIT_MS_KEY]: '500' });
    const pluginA = await connectSocket(port);
    await helloPlugin(pluginA, 'plugin-ready-first-a', 'Ready First A', 'Raw-Ready-A', ['fileGuard', 'correlatedHeartbeatV1', 'appProbeV1']);
    const pluginB = await connectSocket(port);
    await helloPlugin(pluginB, 'plugin-ready-first-b', 'Ready First B', 'Raw-Ready-B', ['fileGuard', 'correlatedHeartbeatV1', 'appProbeV1']);
    const framesA = collectFrames(pluginA);
    const framesB = collectFrames(pluginB);
    await new Promise((resolve) => setTimeout(resolve, 250));

    // Parsed ACK renews A's app lease without changing the routing-recency order: B
    // remains newer, so only ready-first selection can choose A.
    pluginA.send(JSON.stringify({ type: 'APP_PROBE_ACK', data: { probeId: 'ready-first-renew-a' } } satisfies EventMsg));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const cli = await connectSocket(port);
    cli.send(JSON.stringify(makeRequestFrame('req-ready-first', 'GET_SELECTION', {})));
    await waitFor(() => framesA.frames.some((frame) => (frame as { id?: string }).id === 'req-ready-first')
      || framesB.frames.some((frame) => (frame as EventMsg).type === 'APP_PROBE'));

    expect(framesA.frames.filter((frame) => (frame as { id?: string }).id === 'req-ready-first')).toHaveLength(1);
    expect(framesB.frames.filter((frame) => (frame as { id?: string }).id === 'req-ready-first')).toHaveLength(0);
    expect(framesB.frames.filter((frame) => (frame as EventMsg).type === 'APP_PROBE')).toHaveLength(0);
  });

  it('unfiltered routing with two unready plugins probes one deterministic target and returns bounded E_APP_UNREADY', async () => {
    const readinessLeaseMs = 200;
    const pluginWaitMs = 500;
    // The response is driven by the broker's readiness waiter, not this harness's
    // unrelated 20s observation ceiling. Retain room for one contended event-loop turn.
    const schedulingToleranceMs = 3_000;
    const port = await startTestBroker({
      [APP_READINESS_MS_KEY]: String(readinessLeaseMs),
      [PLUGIN_WAIT_MS_KEY]: String(pluginWaitMs),
    });
    const pluginA = await connectSocket(port);
    await helloPlugin(pluginA, 'plugin-all-unready-a', 'All Unready A', 'Raw-All-Unready-A', ['fileGuard', 'correlatedHeartbeatV1', 'appProbeV1']);
    const pluginB = await connectSocket(port);
    await helloPlugin(pluginB, 'plugin-all-unready-b', 'All Unready B', 'Raw-All-Unready-B', ['fileGuard', 'correlatedHeartbeatV1', 'appProbeV1']);
    const framesA = collectFrames(pluginA);
    const framesB = collectFrames(pluginB);
    await new Promise((resolve) => setTimeout(resolve, 250));

    const cli = await connectSocket(port);
    const startedAt = Date.now();
    const timedOut = nextFrame<ReplyErr>(cli, (frame) => (frame as ReplyErr).id === 'req-all-unready');
    cli.send(JSON.stringify(makeRequestFrame('req-all-unready', 'GET_SELECTION', {})));

    expect((await timedOut).error.code).toBe('E_APP_UNREADY');
    expect(Date.now() - startedAt).toBeLessThanOrEqual(pluginWaitMs + schedulingToleranceMs);
    expect(framesA.frames.filter((frame) => (frame as EventMsg).type === 'APP_PROBE')).toHaveLength(0);
    expect(framesB.frames.filter((frame) => (frame as EventMsg).type === 'APP_PROBE')).toHaveLength(1);
    expect(framesA.frames.filter((frame) => (frame as { id?: string }).id === 'req-all-unready')).toHaveLength(0);
    expect(framesB.frames.filter((frame) => (frame as { id?: string }).id === 'req-all-unready')).toHaveLength(0);
  });

  it('ACK wins before later cancel: one send, cancel refusal, one normal completion drain', async () => {
    const setup = await createReservedHead('race-ack-cancel');
    setup.plugin.send(JSON.stringify({ type: 'APP_PROBE_ACK', data: { probeId: setup.probeId } } satisfies EventMsg));
    await waitFor(() => setup.pluginFrames.frames.some((frame) => (frame as { id?: string }).id === 'race-ack-cancel-b'));
    expect(setup.pluginFrames.frames.filter((frame) => (frame as { id?: string }).id === 'race-ack-cancel-b')).toHaveLength(1);

    const cancel = nextFrame<ReplyOk>(setup.cliB, (frame) => (frame as ReplyOk).id === 'race-ack-cancel-late');
    setup.cliB.send(JSON.stringify(makeRequestFrame('race-ack-cancel-late', 'JOB', { mode: 'cancel', jobId: setup.jobB })));
    expect((await cancel).result).toMatchObject({ ok: false });
    expect((await pollJob(setup.cliB, setup.jobB, 'race-ack-cancel-poll-running')).job.state).toBe('running');

    setup.plugin.send(JSON.stringify({ id: 'race-ack-cancel-b', ok: true, result: {} } satisfies ReplyOk));
    await waitFor(() => setup.pluginFrames.frames.some((frame) => (frame as { id?: string }).id === 'race-ack-cancel-c'));
    expect(setup.pluginFrames.frames.filter((frame) => (frame as { id?: string }).id === 'race-ack-cancel-c')).toHaveLength(1);
    expect((await pollJob(setup.cliB, setup.jobB, 'race-ack-cancel-poll-done')).job.state).toBe('done');
    expect((await pollJob(setup.cliC, setup.jobC, 'race-ack-cancel-poll-c')).job.state).toBe('running');
  });

  it('target close beats ACK: both pinned queued jobs settle once and a stale ACK cannot resurrect either', async () => {
    const setup = await createReservedHead('race-close-ack');
    const failedB = nextFrame<ReplyErr>(setup.cliB, (frame) => (frame as ReplyErr).id === 'race-close-ack-b');
    const failedC = nextFrame<ReplyErr>(setup.cliC, (frame) => (frame as ReplyErr).id === 'race-close-ack-c');
    setup.plugin.terminate();
    expect((await failedB).error.code).toBe('E_NO_PLUGIN');
    expect((await failedC).error.code).toBe('E_NO_PLUGIN');

    const replacement = await connectSocket(setup.port);
    await helloPlugin(replacement, 'race-close-ack-plugin', 'race-close-ack File', 'race-close-ack-raw', ['fileGuard', 'correlatedHeartbeatV1', 'appProbeV1']);
    const replacementFrames = collectFrames(replacement);
    replacement.send(JSON.stringify({ type: 'APP_PROBE_ACK', data: { probeId: setup.probeId } } satisfies EventMsg));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(replacementFrames.frames.some((frame) => (frame as { id?: string }).id === 'race-close-ack-b')).toBe(false);
    expect(replacementFrames.frames.some((frame) => (frame as { id?: string }).id === 'race-close-ack-c')).toBe(false);
    expect((await pollJob(setup.cliB, setup.jobB, 'race-close-ack-poll-b')).job.state).toBe('failed');
    expect((await pollJob(setup.cliC, setup.jobC, 'race-close-ack-poll-c')).job.state).toBe('failed');
  });

  it('target close beats deadline: expiry callback is stale, with zero frames and no second transition', async () => {
    const setup = await createReservedHead('race-close-deadline');
    const failedB = nextFrame<ReplyErr>(setup.cliB, (frame) => (frame as ReplyErr).id === 'race-close-deadline-b');
    const failedC = nextFrame<ReplyErr>(setup.cliC, (frame) => (frame as ReplyErr).id === 'race-close-deadline-c');
    setup.plugin.terminate();
    expect((await failedB).error.code).toBe('E_NO_PLUGIN');
    expect((await failedC).error.code).toBe('E_NO_PLUGIN');
    await new Promise((resolve) => setTimeout(resolve, 650));
    expect((await pollJob(setup.cliB, setup.jobB, 'race-close-deadline-poll-b')).job.state).toBe('failed');
    expect((await pollJob(setup.cliC, setup.jobC, 'race-close-deadline-poll-c')).job.state).toBe('failed');
    expect(setup.pluginFrames.frames.some((frame) => (frame as { id?: string }).id === 'race-close-deadline-b')).toBe(false);
    expect(setup.pluginFrames.frames.some((frame) => (frame as { id?: string }).id === 'race-close-deadline-c')).toBe(false);
  });

  it('gate denial beats ACK: typed failures drain once and the old generation cannot send', async () => {
    const setup = await createReservedHead('race-gate-ack');
    const failedB = nextFrame<ReplyErr>(setup.cliB, (frame) => (frame as ReplyErr).id === 'race-gate-ack-b');
    const failedC = nextFrame<ReplyErr>(setup.cliC, (frame) => (frame as ReplyErr).id === 'race-gate-ack-c');
    const paused = nextFrame<ReplyOk>(setup.cliB, (frame) => (frame as ReplyOk).id === 'race-gate-ack-pause');
    setup.cliB.send(JSON.stringify(makeRequestFrame('race-gate-ack-pause', 'MUTATION_GATE', {
      mode: 'pause', fileKey: 'race-gate-ack-raw',
    })));
    expect((await paused).result).toMatchObject({ state: 'paused' });
    expect((await failedB).error.code).toBe('E_MUTATIONS_PAUSED');
    expect((await failedC).error.code).toBe('E_MUTATIONS_PAUSED');
    setup.plugin.send(JSON.stringify({ type: 'APP_PROBE_ACK', data: { probeId: setup.probeId } } satisfies EventMsg));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(setup.pluginFrames.frames.some((frame) => (frame as { id?: string }).id === 'race-gate-ack-b')).toBe(false);
    expect(setup.pluginFrames.frames.some((frame) => (frame as { id?: string }).id === 'race-gate-ack-c')).toBe(false);
    expect((await pollJob(setup.cliB, setup.jobB, 'race-gate-ack-poll-b')).job.state).toBe('failed');
    expect((await pollJob(setup.cliC, setup.jobC, 'race-gate-ack-poll-c')).job.state).toBe('failed');
  });

  it('exact unready safe reads probe only the pinned instance, then dispatch once or time out still connected', async () => {
    const port = await startTestBroker({ [APP_READINESS_MS_KEY]: '200', [PLUGIN_WAIT_MS_KEY]: '500' });
    const pluginA = await connectSocket(port);
    await helloPlugin(pluginA, 'plugin-ready-a', 'Ready A', 'Raw-A', ['fileGuard', 'correlatedHeartbeatV1', 'appProbeV1']);
    const pluginB = await connectSocket(port);
    await helloPlugin(pluginB, 'plugin-unready-b', 'Unready B', 'Raw-B', ['fileGuard', 'correlatedHeartbeatV1', 'appProbeV1']);
    const framesA = collectFrames(pluginA);
    const framesB = collectFrames(pluginB);
    await new Promise((resolve) => setTimeout(resolve, 250));
    pluginA.send(JSON.stringify({ type: 'FILE_INFO', data: { fileName: 'Ready A', fileKey: 'Raw-A', page: 'Page 1' } } satisfies EventMsg));

    const cli = await connectSocket(port);
    cli.send(JSON.stringify(makeRequestFrame(
      'req-ready-exact', 'GET_SELECTION', {}, undefined, undefined, undefined, undefined, undefined, undefined, 'Raw-B',
    )));
    await waitFor(() => framesB.frames.some((frame) => (frame as EventMsg).type === 'APP_PROBE'));
    const probe = framesB.frames.find((frame) => (frame as EventMsg).type === 'APP_PROBE') as EventMsg;
    expect(framesA.frames.some((frame) => (frame as { id?: string }).id === 'req-ready-exact')).toBe(false);
    pluginB.send(JSON.stringify({ type: 'APP_PROBE_ACK', data: { probeId: (probe.data as { probeId: string }).probeId } } satisfies EventMsg));
    await waitFor(() => framesB.frames.some((frame) => (frame as { id?: string }).id === 'req-ready-exact'));
    expect(framesB.frames.filter((frame) => (frame as { id?: string }).id === 'req-ready-exact')).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 250));
    const timedOut = nextFrame<ReplyErr>(cli, (frame) => (frame as ReplyErr).id === 'req-unready-timeout');
    cli.send(JSON.stringify(makeRequestFrame(
      'req-unready-timeout', 'GET_SELECTION', {}, undefined, undefined, undefined, undefined, undefined, undefined, 'Raw-B',
    )));
    expect((await timedOut).error.code).toBe('E_APP_UNREADY');
    expect(framesA.frames.some((frame) => (frame as { id?: string }).id === 'req-unready-timeout')).toBe(false);
    expect(framesB.frames.some((frame) => (frame as { id?: string }).id === 'req-unready-timeout')).toBe(false);

    const { hello } = await connectAndAwaitBrokerHello(port);
    expect(hello.data).toMatchObject({ pluginConnected: true });
  });

  it('a valid completion renews app readiness and sends the next mutation once through the final dispatch path', async () => {
    const port = await startTestBroker({ [APP_READINESS_MS_KEY]: '200' });
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'plugin-completion-ready', 'Completion Ready', 'Raw-Completion', ['fileGuard', 'correlatedHeartbeatV1', 'appProbeV1']);
    const pluginFrames = collectFrames(plugin);
    const cliA = await connectSocket(port);
    const jobA = await sendMutatingJob(cliA, 'req-completion-a');
    await waitFor(() => pluginFrames.frames.some((frame) => (frame as { id?: string }).id === 'req-completion-a'));
    const cliB = await connectSocket(port);
    const jobB = await sendMutatingJob(cliB, 'req-completion-b');
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect((await pollJob(cliA, jobA, 'req-completion-poll-a')).job.state).toBe('running');
    expect((await pollJob(cliB, jobB, 'req-completion-poll-b')).job.state).toBe('queued');

    plugin.send(JSON.stringify({ id: 'req-completion-a', ok: true, result: {} } satisfies ReplyOk));
    await waitFor(() => pluginFrames.frames.some((frame) => (frame as { id?: string }).id === 'req-completion-b'));
    expect(pluginFrames.frames.filter((frame) => (frame as { id?: string }).id === 'req-completion-b')).toHaveLength(1);
    expect((await pollJob(cliB, jobB, 'req-completion-poll-b2')).job.state).toBe('running');
    const completedA = await pollJob(cliA, jobA, 'req-completion-poll-a2');
    expect(completedA.job.state).toBe('done');
    expect(completedA.lateReplyCount).toBeUndefined();
  });

  it('keeps a dispatched mutation running after its open socket readiness lease expires, then accepts the pinned reply and advances once', async () => {
    const readinessLeaseMs = 200;
    const port = await startTestBroker({ [APP_READINESS_MS_KEY]: String(readinessLeaseMs) });
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'plugin-open-socket-expiry', 'Open Socket Expiry', 'Raw-Open-Socket-Expiry', [
      'fileGuard', 'correlatedHeartbeatV1', 'appProbeV1',
    ]);
    const pluginFrames = collectFrames(plugin);
    const cliA = await connectSocket(port);
    const jobA = await sendMutatingJob(cliA, 'req-open-socket-expiry-a');
    await waitFor(() => pluginFrames.frames.some((frame) => (frame as { id?: string }).id === 'req-open-socket-expiry-a'));
    const cliB = await connectSocket(port);
    const jobB = await sendMutatingJob(cliB, 'req-open-socket-expiry-b');

    // No WebSocket close: application readiness may age out, but its in-flight reply
    // route remains pinned to this still-open plugin instance.
    await new Promise((resolve) => setTimeout(resolve, readinessLeaseMs + 50));
    const { hello: staleHello } = await connectAndAwaitBrokerHello(port);
    const stalePlugin = (staleHello.data as { plugins: Array<{ instanceId: string; state: string; appReadinessAge: number; runningJob?: JobInfo }> })
      .plugins.find((entry) => entry.instanceId === 'plugin-open-socket-expiry');
    expect(stalePlugin).toMatchObject({
      state: 'connected', runningJob: { jobId: jobA, state: 'running' },
    });
    expect(stalePlugin?.appReadinessAge).toBeGreaterThan(readinessLeaseMs);
    expect((await pollJob(cliA, jobA, 'req-open-socket-expiry-poll-a-stale')).job.state).toBe('running');
    expect((await pollJob(cliB, jobB, 'req-open-socket-expiry-poll-b-stale')).job.state).toBe('queued');
    expect(pluginFrames.frames.filter((frame) => (frame as { id?: string }).id === 'req-open-socket-expiry-a')).toHaveLength(1);
    expect(pluginFrames.frames.filter((frame) => (frame as { id?: string }).id === 'req-open-socket-expiry-b')).toHaveLength(0);

    const completed = nextFrame<ReplyOk>(cliA, (frame) => (frame as ReplyOk).id === 'req-open-socket-expiry-a');
    plugin.send(JSON.stringify({ id: 'req-open-socket-expiry-a', ok: true, result: { settled: true } } satisfies ReplyOk));
    expect((await completed).result).toEqual({ settled: true });
    await waitFor(() => pluginFrames.frames.some((frame) => (frame as { id?: string }).id === 'req-open-socket-expiry-b'));

    const settledA = await pollJob(cliA, jobA, 'req-open-socket-expiry-poll-a-settled');
    expect(settledA.job).toMatchObject({ jobId: jobA, state: 'done' });
    expect(settledA.job.state).not.toBe('outcome-unknown');
    expect(settledA.lateReplyCount).toBeUndefined();
    expect((await pollJob(cliB, jobB, 'req-open-socket-expiry-poll-b-running')).job.state).toBe('running');
    expect(pluginFrames.frames.filter((frame) => (frame as { id?: string }).id === 'req-open-socket-expiry-a')).toHaveLength(1);
    expect(pluginFrames.frames.filter((frame) => (frame as { id?: string }).id === 'req-open-socket-expiry-b')).toHaveLength(1);
  });

  it('force-release reserves once; cancel beats deadline and stale-generation ACK while the next deadline drains once', async () => {
    const port = await startTestBroker({ [APP_READINESS_MS_KEY]: '200', [PLUGIN_WAIT_MS_KEY]: '100' });
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'plugin-reserved', 'Reserved File', 'Raw-Reserved', ['fileGuard', 'correlatedHeartbeatV1', 'appProbeV1']);
    const pluginFrames = collectFrames(plugin);
    const cliA = await connectSocket(port);
    const jobA = await sendMutatingJob(cliA, 'req-reserved-a');
    await waitFor(() => pluginFrames.frames.some((frame) => (frame as { id?: string }).id === 'req-reserved-a'));
    const cliB = await connectSocket(port);
    const jobB = await sendMutatingJob(cliB, 'req-reserved-b');
    const cliC = await connectSocket(port);
    const jobC = await sendMutatingJob(cliC, 'req-reserved-c');
    await new Promise((resolve) => setTimeout(resolve, 250));

    cliA.send(JSON.stringify(makeRequestFrame('req-reserved-release-a', 'JOB', {
      mode: 'force-release', jobId: jobA, override: true,
    })));
    await nextFrame<ReplyOk>(cliA, (frame) => (frame as ReplyOk).id === 'req-reserved-release-a');
    await waitFor(() => pluginFrames.frames.some((frame) => (frame as EventMsg).type === 'APP_PROBE'));
    const probeB = pluginFrames.frames.find((frame) => (frame as EventMsg).type === 'APP_PROBE') as EventMsg;
    const reservedB = await pollJob(cliB, jobB, 'req-reserved-poll-b');
    expect(reservedB.job).toMatchObject({ state: 'queued', dispatchState: 'queued-not-dispatched-readiness-wait' });
    expect(pluginFrames.frames.some((frame) => (frame as { id?: string }).id === 'req-reserved-b')).toBe(false);

    const { hello } = await connectAndAwaitBrokerHello(port);
    const rows = (hello.data as { plugins: Array<{ runningJob?: JobInfo; queueDepth: number }> }).plugins;
    expect(rows[0]).toMatchObject({ runningJob: { jobId: jobB, state: 'queued' }, queueDepth: 1 });

    for (const override of [false, true]) {
      const releaseId = `req-reserved-release-b-${String(override)}`;
      cliB.send(JSON.stringify(makeRequestFrame(releaseId, 'JOB', { mode: 'force-release', jobId: jobB, override })));
      const refusal = await nextFrame<ReplyOk>(cliB, (frame) => (frame as ReplyOk).id === releaseId);
      expect(refusal.result).toEqual({
        ok: false,
        reason: `job '${jobB}' is queued and has not been dispatched; use: figma-agent job ${jobB} --cancel`,
      });
    }
    expect((await pollJob(cliB, jobB, 'req-reserved-poll-b2')).job).toMatchObject({
      state: 'queued', dispatchState: 'queued-not-dispatched-readiness-wait',
    });

    const failedC = nextFrame<ReplyErr>(cliC, (frame) => (frame as ReplyErr).id === 'req-reserved-c');
    cliB.send(JSON.stringify(makeRequestFrame('req-reserved-cancel-b', 'JOB', { mode: 'cancel', jobId: jobB })));
    await nextFrame<ReplyOk>(cliB, (frame) => (frame as ReplyOk).id === 'req-reserved-cancel-b');
    plugin.send(JSON.stringify({ type: 'APP_PROBE_ACK', data: { probeId: (probeB.data as { probeId: string }).probeId } } satisfies EventMsg));
    expect((await failedC).error.code).toBe('E_APP_UNREADY');
    expect((await pollJob(cliB, jobB, 'req-reserved-poll-b3')).job.state).toBe('cancelled');
    expect((await pollJob(cliC, jobC, 'req-reserved-poll-c')).job.state).toBe('failed');
    expect(pluginFrames.frames.some((frame) => (frame as { id?: string }).id === 'req-reserved-b')).toBe(false);
    expect(pluginFrames.frames.some((frame) => (frame as { id?: string }).id === 'req-reserved-c')).toBe(false);
  });

  it('a bare `--force-release` on a job still `running` inside the watchdog window is REFUSED — the slot stays held, nothing advances', async () => {
    const port = await startTestBroker();
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'plugin-fr1', 'FFR1', 'RawFFR1');
    const pluginFrames = collectFrames(plugin);

    const cliA = await connectSocket(port);
    const jobA = await sendMutatingJob(cliA, 'req-fr1-a'); // dispatched immediately — RUNNING
    await waitFor(() => pluginFrames.frames.some((f) => (f as { id?: string }).id === 'req-fr1-a'));

    const cliB = await connectSocket(port);
    const jobB = await sendMutatingJob(cliB, 'req-fr1-b'); // QUEUED behind job A — plugin still busy

    cliA.send(JSON.stringify(makeRequestFrame('req-fr1-release', 'JOB', { mode: 'force-release', jobId: jobA })));
    const reply = await nextFrame<ReplyOk>(cliA, (m) => (m as ReplyOk).id === 'req-fr1-release');
    expect(reply.ok).toBe(true); // the ENVELOPE always replies ok — the refusal is IN the result
    const result = reply.result as { ok: boolean; reason?: string };
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('still running');
    expect(result.reason).toContain('--force');

    // The slot was never freed — job A is still `running`, job B is still `queued`
    // (never dispatched), and the plugin received exactly ONE request frame (job A's).
    const polledA = await pollJob(cliA, jobA, 'req-fr1-poll-a');
    expect(polledA.job.state).toBe('running');
    const polledB = await pollJob(cliB, jobB, 'req-fr1-poll-b');
    expect(polledB.job.state).toBe('queued');
    const requestFrames = pluginFrames.frames.filter((f) => 'cmd' in (f as Record<string, unknown>));
    expect(requestFrames).toHaveLength(1);
    expect((requestFrames[0] as { id: string }).id).toBe('req-fr1-a');
  });

  it('`--force-release` + `override:true` (the CLI\'s `--force`) overrides the guard — the slot frees, the queued job advances, its result is discarded', async () => {
    const port = await startTestBroker();
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'plugin-fr2', 'FFR2', 'RawFFR2');
    const pluginFrames = collectFrames(plugin);

    const cliA = await connectSocket(port);
    const jobA = await sendMutatingJob(cliA, 'req-fr2-a');
    await waitFor(() => pluginFrames.frames.some((f) => (f as { id?: string }).id === 'req-fr2-a'));

    const cliB = await connectSocket(port);
    const jobB = await sendMutatingJob(cliB, 'req-fr2-b'); // QUEUED behind job A

    cliA.send(JSON.stringify(
      makeRequestFrame('req-fr2-release', 'JOB', { mode: 'force-release', jobId: jobA, override: true }, 'Force-release · override'),
    ));
    const reply = await nextFrame<ReplyOk>(cliA, (m) => (m as ReplyOk).id === 'req-fr2-release');
    expect(reply.ok).toBe(true);
    expect((reply.result as { ok: boolean }).ok).toBe(true);

    // Job A's own outcome is now terminal (its running result is discarded/unverified),
    // and job B — previously queued — was dispatched to the plugin.
    const polledA = await pollJob(cliA, jobA, 'req-fr2-poll-a');
    expect(polledA.job.state).toBe('failed');
    await waitFor(() => pluginFrames.frames.some((f) => (f as { id?: string }).id === 'req-fr2-b'));
    expect(pluginFrames.frames.filter((f) => (f as { id?: string }).id === 'req-fr2-b')).toHaveLength(1);
    const polledB = await pollJob(cliB, jobB, 'req-fr2-poll-b');
    expect(polledB.job.state).toBe('running');
  });

  it('regression: a watchdog-wedged job (state !== "running") still force-releases with a BARE `--force-release`, no `--force` needed', async () => {
    const port = await startTestBroker({ [WATCHDOG_MS_KEY]: '150' }); // real watchdog, shrunk
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'plugin-fr3', 'FFR3', 'RawFFR3');
    const pluginFrames = collectFrames(plugin);

    const cliA = await connectSocket(port);
    const jobA = await sendMutatingJob(cliA, 'req-fr3-a');
    await waitFor(() => pluginFrames.frames.some((f) => (f as { id?: string }).id === 'req-fr3-a'));
    // Plugin stays silent — the watchdog (min cadence 1s regardless of how small
    // WATCHDOG_TIMEOUT_MS is set) declares job A wedged, `state` flips to 'failed', but
    // the slot stays held on purpose (broker-daemon.ts's own watchdog comment).
    let seq = 0;
    await waitFor(async () => {
      const p = await pollJob(cliA, jobA, `req-fr3-poll-${seq++}`);
      return p.job.state === 'failed';
    }, 5_000, 150);

    const cliB = await connectSocket(port);
    const jobB = await sendMutatingJob(cliB, 'req-fr3-b'); // QUEUED — slot still held by wedged job A
    expect((await pollJob(cliA, jobA, 'req-fr3-poll-held')).job).toMatchObject({
      jobId: jobA,
      state: 'failed',
    });
    expect((await pollJob(cliB, jobB, 'req-fr3-poll-queued')).job.state).toBe('queued');

    cliA.send(JSON.stringify(makeRequestFrame('req-fr3-release', 'JOB', { mode: 'force-release', jobId: jobA })));
    const reply = await nextFrame<ReplyOk>(cliA, (m) => (m as ReplyOk).id === 'req-fr3-release');
    expect(reply.ok).toBe(true);
    expect((reply.result as { ok: boolean }).ok).toBe(true); // allowed WITHOUT --force — the legitimate unwedge path, unregressed

    await waitFor(() => pluginFrames.frames.some((f) => (f as { id?: string }).id === 'req-fr3-b'));
    expect(pluginFrames.frames.filter((f) => (f as { id?: string }).id === 'req-fr3-b')).toHaveLength(1);
    const polledB = await pollJob(cliB, jobB, 'req-fr3-poll-b');
    expect(polledB.job.state).toBe('running');
  });
});

describe('daemon harness — a finished job\'s queuedMs write-throughs into the durable contention counter', () => {
  it('an UNBOUND file\'s queued time lands at the broker cwd default, keyed by its own fileSlug', async () => {
    const port = await startTestBroker();
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'plugin-cont-1', 'Contention File', 'RawContention');
    const pluginFrames = collectFrames(plugin);

    const cli = await connectSocket(port);
    const jobId = await sendMutatingJob(cli, 'req-cont-1');
    await waitFor(() => pluginFrames.frames.some((f) => (f as { id?: string }).id === 'req-cont-1'));
    plugin.send(JSON.stringify({ id: 'req-cont-1', ok: true, result: {} } satisfies ReplyOk));
    await pollJob(cli, jobId, 'req-cont-1-poll'); // the job is terminal by the time this resolves

    // No PROJECT_BIND ever happened for this identity — the broker's own cwd default
    // (FIGMA_AGENT_CHANGES_DIR, same base changeLogDir()/errorLogPath() use).
    const path = join(scratchDir, 'figma-contention.json');
    await waitFor(() => existsSync(path));
    const store = JSON.parse(readFileSync(path, 'utf8')) as ContentionStore;
    const slug = 'RawContention';
    const days = store[slug];
    expect(days).toBeDefined();
    const totals = Object.values(days!)[0]!;
    expect(totals.jobCount).toBe(1);
    expect(totals.totalQueuedMs).toBeGreaterThanOrEqual(0);
  });

  it('a BOUND file\'s queued time lands in its OWN project, never the broker cwd default', async () => {
    const port = await startTestBroker();
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'plugin-cont-2', 'Bound Contention File', 'RawBoundContention');

    const boundProjectDir = mkdtempSync(join(tmpdir(), 'fa-bound-contention-'));
    try {
      // `resolveProjectDir`'s own `isUsable()` treats a project without a `design/` dir
      // as "stopped looking like a project" (never a fallback guess) — pre-create it the
      // way a genuine bind target always already has one (same idiom as the other bound
      // fixtures in this file).
      mkdirSync(join(boundProjectDir, 'design'), { recursive: true });
      const cliBind = await connectSocket(port);
      await bindProject(cliBind, 'Bound Contention File', boundProjectDir, 'req-cont-bind');

      const cli = await connectSocket(port);
      const pluginFrames = collectFrames(plugin);
      const jobId = await sendMutatingJob(cli, 'req-cont-2');
      await waitFor(() => pluginFrames.frames.some((f) => (f as { id?: string }).id === 'req-cont-2'));
      plugin.send(JSON.stringify({ id: 'req-cont-2', ok: true, result: {} } satisfies ReplyOk));
      await pollJob(cli, jobId, 'req-cont-2-poll');

      const boundPath = join(boundProjectDir, 'design', 'figma-contention.json');
      const cwdDefaultPath = join(scratchDir, 'figma-contention.json');
      await waitFor(() => existsSync(boundPath));
      const store = JSON.parse(readFileSync(boundPath, 'utf8')) as ContentionStore;
    const slug = 'RawBoundContention';
      expect(store[slug]).toBeDefined();
      expect(Object.values(store[slug]!)[0]!.jobCount).toBe(1);
      // Never ALSO written to the broker's own cwd default for this identity.
      if (existsSync(cwdDefaultPath)) {
        const cwdStore = JSON.parse(readFileSync(cwdDefaultPath, 'utf8')) as ContentionStore;
        expect(cwdStore[slug]).toBeUndefined();
      }
    } finally {
      rmSync(boundProjectDir, { recursive: true, force: true });
    }
  });

  it('a job cancelled while still QUEUED also write-throughs its own queuedMs (cancelQueued stamps it, not markRunning)', async () => {
    const port = await startTestBroker();
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'plugin-cont-3', 'Cancel Contention File', 'RawCancelContention');
    const pluginFrames = collectFrames(plugin);

    const cliA = await connectSocket(port);
    await sendMutatingJob(cliA, 'req-cont-3a'); // dispatched immediately — occupies the file's slot
    await waitFor(() => pluginFrames.frames.some((f) => (f as { id?: string }).id === 'req-cont-3a'));

    const cliB = await connectSocket(port);
    const jobB = await sendMutatingJob(cliB, 'req-cont-3b'); // QUEUED behind job A

    cliB.send(JSON.stringify(makeRequestFrame('req-cont-3-cancel', 'JOB', { mode: 'cancel', jobId: jobB })));
    const cancelReply = await nextFrame<ReplyOk>(cliB, (m) => (m as ReplyOk).id === 'req-cont-3-cancel');
    expect((cancelReply.result as { ok: boolean }).ok).toBe(true);

    const path = join(scratchDir, 'figma-contention.json');
    const slug = 'RawCancelContention';
    await waitFor(() => {
      if (!existsSync(path)) return false;
      const store = JSON.parse(readFileSync(path, 'utf8')) as ContentionStore;
      return store[slug] !== undefined;
    });
    const store = JSON.parse(readFileSync(path, 'utf8')) as ContentionStore;
    // Job A is still running (unfinished) — only job B's cancelled queuedMs is recorded so far.
    expect(Object.values(store[slug]!)[0]!.jobCount).toBe(1);
  });
});

// #35 P2 — the panel's "Target this plugin" button (SET_TARGET/CLEAR_TARGET) and the
// daemon's `targetInstancePin` it sets. Exercises the REAL `admitRequest`/`handleClose`/
// `broadcastPeers` closures end to end, same isolation as every other describe block here.
function setTarget(ws: WebSocket, instanceId: string): void {
  ws.send(JSON.stringify({ type: 'SET_TARGET', data: { instanceId } } satisfies EventMsg));
}
function clearTarget(ws: WebSocket, instanceId: string): void {
  ws.send(JSON.stringify({ type: 'CLEAR_TARGET', data: { instanceId } } satisfies EventMsg));
}
/** A broker-safe read (GET_SELECTION) — dispatches immediately, no
 *  per-file queue to reason about, so a test only has to observe WHICH plugin received it. */
function sendReadOnlyRequest(ws: WebSocket, reqId: string, expectedInstance?: string): void {
  ws.send(JSON.stringify(makeRequestFrame(reqId, 'GET_SELECTION', {}, undefined, undefined, undefined, undefined, expectedInstance)));
}
/**
 * JOB_STATE is sent to the CLI the moment a request is ADMITTED (dispatched to a plugin
 * or queued) — BEFORE any plugin reply, which these tests' bare `WebSocket` "plugins"
 * never send. Waiting for a real reply here would hang forever (that bug produced this
 * helper); JOB_STATE alone is the correct, always-present admission signal these
 * precedence/routing tests need.
 */
function waitForJobState(ws: WebSocket): Promise<void> {
  return nextFrame(ws, (m) => (m as EventMsg).type === 'JOB_STATE').then(() => undefined);
}
/**
 * Distinguishes "admitted, dispatched somewhere" (a JOB_STATE arrives) from "refused
 * outright" (an immediate ReplyErr carrying `reqId` arrives, with NO JOB_STATE ever sent
 * — `admitRequest`'s `E_TARGET_DISCONNECTED` refusal returns before job creation). Used
 * only where a test must tell the two apart; every other pin test only needs
 * `waitForJobState` (dispatch always succeeds there).
 */
function admissionOutcome(ws: WebSocket, reqId: string): Promise<'dispatched' | 'refused'> {
  return Promise.race([
    nextFrame(ws, (m) => (m as EventMsg).type === 'JOB_STATE').then(() => 'dispatched' as const),
    nextFrame(ws, (m) => (m as ReplyErr).id === reqId && (m as ReplyErr).ok === false).then(() => 'refused' as const),
  ]);
}

describe('daemon harness — target pin (#35 P2): SET_TARGET/CLEAR_TARGET, precedence, disconnect-clears, PEERS', () => {
  it('SET_TARGET pins routing to that instance even though a DIFFERENT plugin is more recently active', async () => {
    const port = await startTestBroker();
    const pluginA = await connectSocket(port);
    await helloPlugin(pluginA, 'inst-pin-a', 'PinFileA');
    const pluginB = await connectSocket(port);
    await helloPlugin(pluginB, 'inst-pin-b', 'PinFileB'); // B HELLOs after A — B is recency-favored by default
    // Drain the HELLO-triggered PEERS broadcast(s) before attaching the listeners below —
    // otherwise a straggler from registration (not from SET_TARGET) can land on a
    // freshly-attached listener and be misread as this test's own signal.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const framesA = collectFrames(pluginA);
    const framesB = collectFrames(pluginB);

    setTarget(pluginA, 'inst-pin-a');
    await waitFor(() => framesA.frames.some((f) => (f as { type?: string }).type === 'PEERS'));

    const cli = await connectSocket(port);
    sendReadOnlyRequest(cli, 'req-pin-1');
    await waitForJobState(cli);
    await waitFor(() => framesA.frames.some((f) => (f as { id?: string }).id === 'req-pin-1'));

    expect(framesA.frames.some((f) => (f as { id?: string }).id === 'req-pin-1')).toBe(true);
    expect(framesB.frames.some((f) => (f as { id?: string }).id === 'req-pin-1')).toBe(false);
  });

  it('a per-request --instance still overrides the pin (per-request flags always win)', async () => {
    const port = await startTestBroker();
    const pluginA = await connectSocket(port);
    await helloPlugin(pluginA, 'inst-pin-a2', 'PinFileA2');
    const pluginB = await connectSocket(port);
    await helloPlugin(pluginB, 'inst-pin-b2', 'PinFileB2');
    await new Promise((resolve) => setTimeout(resolve, HARNESS_SETTLE_MS)); // drain the HELLO-triggered PEERS broadcast(s)
    const framesA = collectFrames(pluginA);
    const framesB = collectFrames(pluginB);

    setTarget(pluginA, 'inst-pin-a2');
    await waitFor(() => framesA.frames.some((f) => (f as { type?: string }).type === 'PEERS'));

    const cli = await connectSocket(port);
    sendReadOnlyRequest(cli, 'req-pin-2', 'inst-pin-b2'); // explicit --instance targets B despite A's pin
    await waitForJobState(cli);
    await waitFor(() => framesB.frames.some((f) => (f as { id?: string }).id === 'req-pin-2'));

    expect(framesB.frames.some((f) => (f as { id?: string }).id === 'req-pin-2')).toBe(true);
    expect(framesA.frames.some((f) => (f as { id?: string }).id === 'req-pin-2')).toBe(false);
  });

  it('CLEAR_TARGET clears the pin — a later no-flag command falls back to recency', async () => {
    const port = await startTestBroker();
    const pluginA = await connectSocket(port);
    await helloPlugin(pluginA, 'inst-pin-a3', 'PinFileA3');
    const pluginB = await connectSocket(port);
    await helloPlugin(pluginB, 'inst-pin-b3', 'PinFileB3'); // recency-favored once unpinned
    await new Promise((resolve) => setTimeout(resolve, HARNESS_SETTLE_MS)); // drain the HELLO-triggered PEERS broadcast(s)
    const framesA = collectFrames(pluginA);
    const framesB = collectFrames(pluginB);

    setTarget(pluginA, 'inst-pin-a3');
    await waitFor(() => framesA.frames.some((f) => (f as { type?: string }).type === 'PEERS'));
    clearTarget(pluginA, 'inst-pin-a3');
    await waitFor(() => framesA.frames.filter((f) => (f as { type?: string }).type === 'PEERS').length >= 2);

    const cli = await connectSocket(port);
    sendReadOnlyRequest(cli, 'req-pin-3');
    await waitForJobState(cli);
    await waitFor(() => framesB.frames.some((f) => (f as { id?: string }).id === 'req-pin-3'));

    expect(framesB.frames.some((f) => (f as { id?: string }).id === 'req-pin-3')).toBe(true);
    expect(framesA.frames.some((f) => (f as { id?: string }).id === 'req-pin-3')).toBe(false);
  });

  it('the pinned instance disconnecting clears the pin — a later no-flag command falls through to recency, never stuck refusing', async () => {
    const port = await startTestBroker();
    const pluginA = await connectSocket(port);
    await helloPlugin(pluginA, 'inst-pin-a4', 'PinFileA4');
    const pluginB = await connectSocket(port);
    await helloPlugin(pluginB, 'inst-pin-b4', 'PinFileB4');
    await new Promise((resolve) => setTimeout(resolve, HARNESS_SETTLE_MS)); // drain the HELLO-triggered PEERS broadcast(s)
    const framesA = collectFrames(pluginA);

    setTarget(pluginA, 'inst-pin-a4');
    await waitFor(() => framesA.frames.some((f) => (f as { type?: string }).type === 'PEERS'));

    const peersAfterDisconnect = nextFrame<EventMsg>(pluginB, (m) => (m as EventMsg).type === 'PEERS');
    pluginA.terminate(); // the pinned instance disconnects
    // `handleClose` clears the pin + broadcasts PEERS to survivors in the SAME turn the
    // registry drops A's entry — B (the only survivor) is trivially the recency target
    // now, and no longer merely "the non-pinned one".
    const peers = await peersAfterDisconnect;
    expect(peers.data).toMatchObject({ isActiveTarget: true, pinned: false });

    const cli = await connectSocket(port);
    sendReadOnlyRequest(cli, 'req-pin-4');
    // JOB_STATE means it was ADMITTED (dispatched to B via ordinary recency); a ReplyErr
    // would mean it was REFUSED (E_TARGET_DISCONNECTED against the now-gone pin) —
    // exactly the regression this test exists to catch.
    const outcome = await admissionOutcome(cli, 'req-pin-4');
    expect(outcome).toBe('dispatched');
  });

  it('SET_TARGET refuses a claimed instanceId that does not match the sender\'s OWN registered instance', async () => {
    const port = await startTestBroker();
    const pluginA = await connectSocket(port);
    await helloPlugin(pluginA, 'inst-pin-a5', 'PinFileA5');
    const pluginB = await connectSocket(port);
    await helloPlugin(pluginB, 'inst-pin-b5', 'PinFileB5'); // recency-favored — proves the pin never took
    await new Promise((resolve) => setTimeout(resolve, HARNESS_SETTLE_MS)); // drain the HELLO-triggered PEERS broadcast(s)
    const framesA = collectFrames(pluginA);
    const framesB = collectFrames(pluginB);

    setTarget(pluginA, 'inst-pin-b5'); // A claims to be B — must be refused
    await new Promise((resolve) => setTimeout(resolve, HARNESS_SETTLE_MS)); // let the broker process it (no ack frame to await)

    const cli = await connectSocket(port);
    sendReadOnlyRequest(cli, 'req-pin-5');
    await waitForJobState(cli);
    await waitFor(() => framesB.frames.some((f) => (f as { id?: string }).id === 'req-pin-5'));

    expect(framesB.frames.some((f) => (f as { id?: string }).id === 'req-pin-5')).toBe(true); // recency, unaffected
    expect(framesA.frames.some((f) => (f as { id?: string }).id === 'req-pin-5')).toBe(false);
  });

  it('PEERS reflects the pin: `pinned`/`isActiveTarget` on the pinned entry, both false elsewhere; CLEAR_TARGET reverts to recency', async () => {
    const port = await startTestBroker();
    const pluginA = await connectSocket(port);
    await helloPlugin(pluginA, 'inst-pin-a6', 'PinFileA6');
    const pluginB = await connectSocket(port);
    await helloPlugin(pluginB, 'inst-pin-b6', 'PinFileB6'); // recency-favored while unpinned
    await new Promise((resolve) => setTimeout(resolve, HARNESS_SETTLE_MS)); // drain the HELLO-triggered PEERS broadcast(s)

    const peersAAfterPin = nextFrame<EventMsg>(pluginA, (m) => (m as EventMsg).type === 'PEERS');
    const peersBAfterPin = nextFrame<EventMsg>(pluginB, (m) => (m as EventMsg).type === 'PEERS');
    setTarget(pluginA, 'inst-pin-a6');
    const [helloA, helloB] = await Promise.all([peersAAfterPin, peersBAfterPin]);
    expect(helloA.data).toMatchObject({ isActiveTarget: true, pinned: true });
    expect(helloB.data).toMatchObject({ isActiveTarget: false, pinned: false });

    const peersAAfterClear = nextFrame<EventMsg>(pluginA, (m) => (m as EventMsg).type === 'PEERS');
    const peersBAfterClear = nextFrame<EventMsg>(pluginB, (m) => (m as EventMsg).type === 'PEERS');
    clearTarget(pluginA, 'inst-pin-a6');
    const [clearedA, clearedB] = await Promise.all([peersAAfterClear, peersBAfterClear]);
    // Unpinned: recency decides — B HELLO'd after A, so B is the recency target, neither is pinned.
    expect(clearedA.data).toMatchObject({ isActiveTarget: false, pinned: false });
    expect(clearedB.data).toMatchObject({ isActiveTarget: true, pinned: false });
  });
});

// Broker-restart reconnect visibility (last-plugins.json) — the owner's actual live
// symptom: a fresh broker's registry starts EMPTY, so a backgrounded editor that hasn't
// reconnected yet (Figma throttles it) is invisible after a restart. These tests exercise
// the REAL `runBrokerDaemon` end to end across TWO daemon instances sharing the SAME
// scratch advertisement path (the harness's own stand-in for "the same machine, a
// restarted broker process") — never a live plugin session's real /tmp files.
interface AwaitingReconnectHelloData {
  plugins?: unknown[];
  awaitingReconnect?: { fileName: string | null; lastSeenBeforeShutdown: number }[];
}

describe('daemon harness — broker-restart reconnect visibility (last-plugins.json)', () => {
  it('a recently-seen plugin survives a broker restart as awaitingReconnect — never inside plugins[] — and clears the moment it re-HELLOs (by fileName, a fresh instanceId)', async () => {
    const lastPluginsPath = join(scratchDir, 'last-plugins.json');

    const port1 = await startTestBroker({ FIGMA_AGENT_LAST_PLUGINS_DEBOUNCE_MS: '30' });
    const plugin1 = await connectSocket(port1);
    await helloPlugin(plugin1, 'inst-restart-old', 'Restart File');
    await waitFor(() => existsSync(lastPluginsPath) && readFileSync(lastPluginsPath, 'utf8').includes('inst-restart-old'));

    // The old advertisement no longer describes a live broker (what a genuine process
    // restart leaves behind) — the persisted last-plugins.json is untouched by this,
    // exactly the point: it survives independently of the advertisement file's lifecycle.
    rmSync(advertisePath, { force: true });

    const port2 = await startTestBroker({ FIGMA_AGENT_LAST_PLUGINS_DEBOUNCE_MS: '30' });
    const { hello: helloBeforeReconnect } = await connectAndAwaitBrokerHello(port2);
    const dataBefore = helloBeforeReconnect.data as AwaitingReconnectHelloData;
    expect(dataBefore.plugins).toEqual([]); // the fresh registry is genuinely empty
    expect(dataBefore.awaitingReconnect).toEqual([
      { fileName: 'Restart File', lastSeenBeforeShutdown: expect.any(Number) as number },
    ]);

    // Reconnect against the NEW broker — a fresh iframe load mints a NEW instanceId (the
    // exact reason the clear falls back to fileName), same fileName as before the restart.
    const plugin2 = await connectSocket(port2);
    await helloPlugin(plugin2, 'inst-restart-new', 'Restart File');

    const { hello: helloAfterReconnect } = await connectAndAwaitBrokerHello(port2);
    const dataAfter = helloAfterReconnect.data as AwaitingReconnectHelloData;
    expect(dataAfter.awaitingReconnect).toBeUndefined(); // cleared — present-only-when-non-empty
    expect(dataAfter.plugins).toHaveLength(1);
    expect((dataAfter.plugins![0] as { fileName?: string }).fileName).toBe('Restart File');
  });

  it('awaitingReconnect goes empty once this broker has been up past the expiry window, even though nothing ever reconnected', async () => {
    const lastPluginsPath = join(scratchDir, 'last-plugins.json');

    const port1 = await startTestBroker({ FIGMA_AGENT_LAST_PLUGINS_DEBOUNCE_MS: '30' });
    const plugin1 = await connectSocket(port1);
    await helloPlugin(plugin1, 'inst-expire-old', 'Expire File');
    await waitFor(() => existsSync(lastPluginsPath) && readFileSync(lastPluginsPath, 'utf8').includes('inst-expire-old'));
    rmSync(advertisePath, { force: true });

    const port2 = await startTestBroker({
      FIGMA_AGENT_LAST_PLUGINS_DEBOUNCE_MS: '30',
      FIGMA_AGENT_AWAITING_RECONNECT_EXPIRY_MS: '150',
    });
    const { hello: helloEarly } = await connectAndAwaitBrokerHello(port2);
    expect((helloEarly.data as AwaitingReconnectHelloData).awaitingReconnect).toEqual([
      { fileName: 'Expire File', lastSeenBeforeShutdown: expect.any(Number) as number },
    ]);

    await new Promise((resolve) => setTimeout(resolve, 250)); // past the shrunk 150ms expiry window
    const { hello: helloLate } = await connectAndAwaitBrokerHello(port2);
    expect((helloLate.data as AwaitingReconnectHelloData).awaitingReconnect).toBeUndefined();
  });
});

// A frame the relay buffered through an outage is HISTORY: it must land in the feed
// dated to when the edit happened, marked as a replay, and it must not read as live
// activity. `appendEditFrames`/`appendChangeFrames` stamped broker-append time — true
// while an unsendable frame was destroyed, wrong the moment a whole outage gets
// replayed on reconnect.
describe('daemon harness — a replayed capture is filed at its CAPTURE time, never at reconnect time', () => {
  const slug = 'replay-file';
  const editAt = (nodeId: string): EditInputLike => ({
    op: 'updated', nodeId, nodeName: `Node ${nodeId}`, nodeType: 'FRAME', parentName: null,
    changedProps: ['x'], origin: 'LOCAL', page: 'Page 1', actor: 'owner',
  });

  it('stamps the plugin\'s capturedAt onto the frame and marks it replayed', async () => {
    const port = await startTestBroker();
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'inst-replay-1', 'Replay File');
    const stagingPath = join(scratchDir, 'unbound-root', 'changes', 'unbound', `${slug}.jsonl`);
    const capturedAt = Date.now() - 40 * 60_000; // a 40-minute outage, replayed in one batch

    plugin.send(JSON.stringify({
      type: 'EDIT_FEED',
      data: {
        edits: [editAt('gap:1')], fileKey: null, fileName: 'Replay File', source: 'live',
        capturedAt, replayed: true,
      },
    } satisfies EventMsg));

    await waitFor(() => existsSync(stagingPath));
    const frame = JSON.parse(readFileSync(stagingPath, 'utf8').trim()) as { ts: number; replayed?: boolean };
    expect(frame.ts, 'the edit is dated when it happened, not when the socket came back').toBe(capturedAt);
    expect(frame.replayed).toBe(true);
    expect(readFileSync(scratchLogFile, 'utf8')).toMatch(/replayed 1 frame\(s\)/);
  });

  it('a batch with no capturedAt (an older plugin bundle) is still dated broker-now', async () => {
    const port = await startTestBroker();
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'inst-replay-2', 'Replay File');
    const stagingPath = join(scratchDir, 'unbound-root', 'changes', 'unbound', `${slug}.jsonl`);
    const before = Date.now();

    sendEditFeed(plugin, [editAt('live:1')], { fileKey: null, fileName: 'Replay File' });

    await waitFor(() => existsSync(stagingPath));
    const frame = JSON.parse(readFileSync(stagingPath, 'utf8').trim()) as { ts: number; replayed?: boolean };
    expect(frame.ts).toBeGreaterThanOrEqual(before);
    expect(frame.ts).toBeLessThanOrEqual(Date.now());
    expect(frame, 'a live frame carries no replay marker at all').not.toHaveProperty('replayed');
  });

  it('a capturedAt in the future is refused, dated broker-now, and counted in the log', async () => {
    const port = await startTestBroker();
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'inst-replay-3', 'Replay File');
    const stagingPath = join(scratchDir, 'unbound-root', 'changes', 'unbound', `${slug}.jsonl`);
    const before = Date.now();

    plugin.send(JSON.stringify({
      type: 'EDIT_FEED',
      data: {
        edits: [editAt('skewed:1')], fileKey: null, fileName: 'Replay File', source: 'live',
        capturedAt: Date.now() + 24 * 60 * 60_000, replayed: true,
      },
    } satisfies EventMsg));

    await waitFor(() => existsSync(stagingPath));
    const frame = JSON.parse(readFileSync(stagingPath, 'utf8').trim()) as { ts: number };
    expect(frame.ts).toBeGreaterThanOrEqual(before);
    // Refused, but never silently: an edit parked in the future would never surface in
    // `changes --since` again.
    expect(readFileSync(scratchLogFile, 'utf8')).toMatch(/capturedAt refused/);
  });
});

describe('daemon harness — the relay drop tally is logged as a delta, never the same total twice', () => {
  it('logs each report\'s increment and stays silent on a re-report of a tally already recorded', async () => {
    const port = await startTestBroker();
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'inst-drops-1', 'Drop File');

    const stats = (frames: number, chars: number): void => {
      plugin.send(JSON.stringify({
        type: 'PLUGIN_RELAY_STATS', data: { preOpenDropped: { frames, chars } },
      } satisfies EventMsg));
    };

    stats(5, 40);
    await waitFor(() => /lost 5 capture frame\(s\)/.test(readFileSync(scratchLogFile, 'utf8')));
    stats(9, 100);
    await waitFor(() => /lost 4 capture frame\(s\)/.test(readFileSync(scratchLogFile, 'utf8')));
    stats(9, 100); // the plugin re-sends its cumulative tally on every reconnect
    await new Promise((resolve) => setTimeout(resolve, HARNESS_SETTLE_MS));

    const lines = readFileSync(scratchLogFile, 'utf8').split('\n').filter((l) => l.includes('capture frame(s)'));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('lost 5 capture frame(s) (40 chars)');
    expect(lines[1]).toContain('lost 4 capture frame(s) (60 chars)');
    expect(lines[1], 'the session total is named alongside the increment').toContain('9');
    // The handshake itself never carried the tally, so the registration line cannot
    // double-log it.
    expect(readFileSync(scratchLogFile, 'utf8')).not.toContain('preOpenDropped');
  });

  it('an event type this broker has never heard of is ignored without disturbing the connection', async () => {
    const port = await startTestBroker();
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'inst-unknown-evt', 'Unknown Event File');

    plugin.send(JSON.stringify({ type: 'PLUGIN_FUTURE_TELEMETRY', data: { whatever: [1, 2, 3] } } satisfies EventMsg));

    // The socket still works: an app-level PING is still answered.
    const pong = nextFrame<EventMsg>(plugin, (m) => (m as EventMsg).type === 'PONG');
    plugin.send(JSON.stringify({ type: 'PING', data: { t: Date.now() } } satisfies EventMsg));
    expect((await pong).type).toBe('PONG');
    expect(plugin.readyState).toBe(WebSocket.OPEN);
  });
});
