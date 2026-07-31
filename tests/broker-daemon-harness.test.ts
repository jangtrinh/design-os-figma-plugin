// Closing round (daemon harness ruling) — the ONE test file exercising broker-daemon.ts's
// REAL dispatch closures (admitRequest/routeFromPlugin/advanceQueue/handleClose/
// handleJobCommand/the watchdog interval) end to end, via a real in-process broker + real
// `ws` sockets speaking the actual wire protocol. Everything else in this wave was proven
// via pure-function extraction (file-queue.ts/job-table.ts/protocol-helpers.ts) — these
// closures had ZERO coverage until now, and stage-4's BLOCKER 1/2 both lived exactly here.
//
// Isolation (team-lead ruling, option B — dependency injection, NOT core extraction):
// `runBrokerDaemon`'s optional `options` param — an OS-assigned ephemeral port
// (`ports: [0]`), a tmpdir advertisement path, and an `exit` stub that THROWS instead of
// killing the vitest worker — so this file NEVER touches this machine's real
// /tmp/figma-agent-broker.json, the real 9410-9419 port range, or a real live broker. Also
// redirects the change-log dir (`FIGMA_AGENT_CHANGES_DIR`, existing test convention — see
// change-log.ts's own header) and the bind-cache file (`FIGMA_AGENT_BINDS_FILE`, existing
// override — see project-bind.ts) to the same scratch tmpdir.
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

type BrokerDaemonModule = typeof import('../cli/src/transport/broker-daemon.ts');

const WATCHDOG_MS_KEY = 'FIGMA_AGENT_WATCHDOG_MS';
const CHANGES_DIR_KEY = 'FIGMA_AGENT_CHANGES_DIR';
const BINDS_FILE_KEY = 'FIGMA_AGENT_BINDS_FILE';
const UNBOUND_DIR_KEY = 'FIGMA_AGENT_UNBOUND_DIR';

let scratchDir: string;
let advertisePath: string;
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
  await mod.runBrokerDaemon({ advertisePath, ports: [0], exit: testExit() });
  const ad = JSON.parse(readFileSync(advertisePath, 'utf8')) as { port: number };
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

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 3_000, stepMs = 50): Promise<void> {
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
  it('migrates a file staged before this fix at the cwd-relative location into the new cwd-independent root', async () => {
    // Simulate a prior broker build's leftover staging, at the OLD location
    // (`<FIGMA_AGENT_CHANGES_DIR>/unbound/<slug>.jsonl`) — created BEFORE the broker
    // (and its startup migration) ever runs.
    const slug = 'legacy-file';
    const legacyPath = join(scratchDir, 'unbound', `${slug}.jsonl`);
    mkdirSync(join(scratchDir, 'unbound'), { recursive: true });
    writeFileSync(legacyPath, `${JSON.stringify({ nodeId: 'a' })}\n`, 'utf8');

    await startTestBroker();

    const newPath = join(scratchDir, 'unbound-root', 'unbound', `${slug}.jsonl`);
    await waitFor(() => existsSync(newPath));
    expect(existsSync(legacyPath)).toBe(false); // cleaned up at the old location
    expect(readFileSync(newPath, 'utf8').trim()).toBe(JSON.stringify({ nodeId: 'a' }));
    // Breadcrumb written so a future restart never re-scans.
    expect(existsSync(join(scratchDir, 'unbound-root', '.legacy-migrated'))).toBe(true);
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
