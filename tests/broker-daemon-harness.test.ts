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
import { envMs } from '../cli/src/transport/protocol-helpers.ts';

// Scoped to THIS file only (vitest's own default 5_000ms stays the ceiling everywhere
// else, so a hung test in another file still fails fast) — the real-socket waits below
// legitimately need more room than the suite's fast pure-function tests do.
vi.setConfig({ testTimeout: 30_000 });

type BrokerDaemonModule = typeof import('../cli/src/transport/broker-daemon.ts');

const WATCHDOG_MS_KEY = 'FIGMA_AGENT_WATCHDOG_MS';
const PLUGIN_WAIT_MS_KEY = 'FIGMA_AGENT_PLUGIN_WAIT_MS';
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

async function helloPlugin(ws: WebSocket, instanceId: string, fileName: string): Promise<void> {
  ws.send(JSON.stringify({
    type: 'PLUGIN_HELLO',
    data: { instanceId, fileName, fileKey: null, caps: ['fileGuard'] },
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
  ws.send(JSON.stringify(makeRequestFrame(reqId, 'SET_TEXT', { nodeId: '1:1', text: 'x' })));
  const jobState = await nextFrame<EventMsg>(ws, (m) => (m as EventMsg).type === 'JOB_STATE');
  return (jobState.data as unknown as JobInfo).jobId;
}

async function pollJob(ws: WebSocket, jobId: string, reqId: string): Promise<{ job: JobInfo; resultFrames?: string[]; resultDropped?: boolean; lateReplyCount?: number }> {
  ws.send(JSON.stringify(makeRequestFrame(reqId, 'JOB', { mode: 'poll', jobId })));
  const reply = await nextFrame<ReplyOk | ReplyErr>(ws, (m) => (m as ReplyOk | ReplyErr).id === reqId);
  if (!reply.ok) throw new Error(`poll failed: ${JSON.stringify(reply.error)}`);
  return reply.result as { job: JobInfo; resultFrames?: string[]; resultDropped?: boolean; lateReplyCount?: number };
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

describe('daemon harness — cancel-then-complete never dispatches the cancelled job (BLOCKER 1)', () => {
  it('a QUEUED job cancelled via `job --cancel` is never resurrected when the running job finishes', async () => {
    const port = await startTestBroker();
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'plugin-1', 'F1');
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

describe('daemon harness — plugin disconnect fails a queued job, reconnect never re-dispatches it (BLOCKER 2)', () => {
  it('E_NO_PLUGIN reaches the CLI for both the running and queued job; a same-instanceId reconnect gets nothing', async () => {
    const port = await startTestBroker();
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'plugin-2', 'F2');
    const pluginFrames = collectFrames(plugin);

    const cliA = await connectSocket(port);
    await sendMutatingJob(cliA, 'req-a2'); // dispatched immediately — RUNNING
    await waitFor(() => pluginFrames.frames.some((f) => (f as { id?: string }).id === 'req-a2'));

    const cliB = await connectSocket(port);
    const jobB = await sendMutatingJob(cliB, 'req-b2'); // QUEUED behind job A

    const errA = nextFrame<ReplyErr>(cliA, (m) => (m as ReplyErr).id === 'req-a2');
    const errB = nextFrame<ReplyErr>(cliB, (m) => (m as ReplyErr).id === 'req-b2');
    plugin.terminate(); // the disconnect
    const [replyA, replyB] = await Promise.all([errA, errB]);
    expect(replyA.ok).toBe(false);
    expect(replyA.error.code).toBe('E_NO_PLUGIN');
    expect(replyB.ok).toBe(false);
    expect(replyB.error.code).toBe('E_NO_PLUGIN');

    // Job B's own record reads 'failed' — never left dangling in a resurrectable state.
    const polledB = await pollJob(cliB, jobB, 'req-poll-b2');
    expect(polledB.job.state).toBe('failed');

    // Reconnect with the SAME instanceId — no parked/queued work exists to flush.
    const plugin2 = await connectSocket(port);
    await helloPlugin(plugin2, 'plugin-2', 'F2');
    const plugin2Frames = collectFrames(plugin2);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const dispatched = plugin2Frames.frames.filter((f) => 'cmd' in (f as Record<string, unknown>));
    expect(dispatched).toHaveLength(0);
  });
});

describe('daemon harness — a watchdog-failed job answered late returns the timeout outcome + lateReplyCount, never E_CHUNK_LOST (closing round R1+R2)', () => {
  it('the late reply is discarded and counted, the ORIGINAL E_TIMEOUT outcome survives', async () => {
    const port = await startTestBroker({ [WATCHDOG_MS_KEY]: '150' }); // real watchdog, shrunk
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'plugin-3', 'F3');
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
    await helloPlugin(pluginX, 'inst-x', 'FileX');
    await helloPlugin(pluginY, 'inst-y', 'FileY');

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
    await helloPlugin(pluginX, 'inst-x', 'FileX');
    await helloPlugin(pluginY, 'inst-y', 'FileY');

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
  it('an instanceId matching NO connected plugin → E_NO_PLUGIN names the instanceId, never "open the file panel"', async () => {
    // A non-matching --instance parks (same as any unmatched filter) until the plugin-wait
    // window elapses, then answers E_NO_PLUGIN — shrink the window so this test observes
    // that real deadline instead of the 12s production default (same envMs override
    // pattern the watchdog tests already use).
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
    expect(reply.error.code).toBe('E_NO_PLUGIN');
    expect(reply.error.message).toContain('--instance "inst-gone"');
    expect(reply.error.message).not.toContain('panel');
  });

  it('two plugins sharing the SAME fileName ("Untitled") → --instance routes to the exact one, never the other', async () => {
    const port = await startTestBroker();
    const pluginA = await connectSocket(port);
    const pluginB = await connectSocket(port);
    await helloPlugin(pluginA, 'inst-a', 'Untitled');
    await helloPlugin(pluginB, 'inst-b', 'Untitled');
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
  it('a bare `--force-release` on a job still `running` inside the watchdog window is REFUSED — the slot stays held, nothing advances', async () => {
    const port = await startTestBroker();
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'plugin-fr1', 'FFR1');
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
    await helloPlugin(plugin, 'plugin-fr2', 'FFR2');
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
    const polledB = await pollJob(cliB, jobB, 'req-fr2-poll-b');
    expect(polledB.job.state).toBe('running');
  });

  it('regression: a watchdog-wedged job (state !== "running") still force-releases with a BARE `--force-release`, no `--force` needed', async () => {
    const port = await startTestBroker({ [WATCHDOG_MS_KEY]: '150' }); // real watchdog, shrunk
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'plugin-fr3', 'FFR3');
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

    cliA.send(JSON.stringify(makeRequestFrame('req-fr3-release', 'JOB', { mode: 'force-release', jobId: jobA })));
    const reply = await nextFrame<ReplyOk>(cliA, (m) => (m as ReplyOk).id === 'req-fr3-release');
    expect(reply.ok).toBe(true);
    expect((reply.result as { ok: boolean }).ok).toBe(true); // allowed WITHOUT --force — the legitimate unwedge path, unregressed

    await waitFor(() => pluginFrames.frames.some((f) => (f as { id?: string }).id === 'req-fr3-b'));
    const polledB = await pollJob(cliB, jobB, 'req-fr3-poll-b');
    expect(polledB.job.state).toBe('running');
  });
});

describe('daemon harness — a finished job\'s queuedMs write-throughs into the durable contention counter', () => {
  it('an UNBOUND file\'s queued time lands at the broker cwd default, keyed by its own fileSlug', async () => {
    const port = await startTestBroker();
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'plugin-cont-1', 'Contention File');
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
    const slug = 'contention-file'; // safeSlug('Contention File') — no fileKey, so fileIdentity falls back to the name slug
    const days = store[slug];
    expect(days).toBeDefined();
    const totals = Object.values(days!)[0]!;
    expect(totals.jobCount).toBe(1);
    expect(totals.totalQueuedMs).toBeGreaterThanOrEqual(0);
  });

  it('a BOUND file\'s queued time lands in its OWN project, never the broker cwd default', async () => {
    const port = await startTestBroker();
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'plugin-cont-2', 'Bound Contention File');

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
      const slug = 'bound-contention-file';
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
    await helloPlugin(plugin, 'plugin-cont-3', 'Cancel Contention File');
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
    const slug = 'cancel-contention-file';
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
/** A read-only request (GET_SELECTION, IMPLICIT_READ_ONLY) — dispatches immediately, no
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
