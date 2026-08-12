// Multi-plugin registry (P4): the broker keeps ONE slot per connected plugin
// instance, keyed by a stable instanceId the relay mints once per iframe load.
// This replaces the old single `pluginWs` — two Figma files open at once used to
// evict each other on every PLUGIN_HELLO (the connect/disconnect flapping bug).
// Nothing here touches a socket beyond reading `readyState`, so the whole routing
// / cull / status contract is pure and unit-testable with fake sockets.
import type { PluginScene, PluginStatusEntry } from '../../../shared/protocol.ts';
import { fileMatches } from '../../../shared/file-match.ts';
import { envMs } from './protocol-helpers.ts';
import type { FilterKind } from './route-filter.ts';

/** WebSocket.OPEN — inlined so the registry needs no `ws` import (kept pure). */
export const WS_OPEN = 1;

// Zombie-watchdog observability — the broker conflates two liveness layers today:
// TRANSPORT liveness (a WS pong, which Chromium auto-answers from the network
// process even while the iframe's JS is frozen) and APP liveness (a JS-originated
// frame — HELLO/FILE_INFO/command reply/chunk — which dies the instant the freeze
// hits). A frozen iframe still auto-pongs, so `lastSeenAt` alone reads as perfectly
// healthy; `lastAppFrameAt` is the sensor that actually goes stale. A merely-
// throttled (not frozen) background tab still services its ~10s app-level PING on a
// slower cadence, so this threshold sits comfortably above that jitter — a
// throttled tab is caught by the reconnect-streak path below instead. Env-
// overridable via the same `envMs` knob pattern the daemon's other cadence
// constants use, so a test can shrink it to observe a flip in real seconds.
export const FROZEN_AFTER_MS = envMs('FIGMA_AGENT_ZOMBIE_MS', 75_000);

// A throttled-background reconnect loop (the OTHER zombie mode: the tab never
// fully freezes, but the browser throttles its timers enough that its socket
// drops and reconnects on unchanged content) flags after this many same-scene
// re-registers. Three is the register()-side floor: one reconnect is routine
// network noise, two is still plausibly a blip, three with an unchanged scene is
// a pattern.
const FLAPPER_STREAK_THRESHOLD = 3;

// A same-scene re-HELLO only ever COUNTS toward the flapper streak when it lands
// within this long since the PREVIOUS re-HELLO — a daily sleep/wake reconnect
// (hours apart, same scene) must never accumulate toward the threshold; only a
// tight reconnect cadence indicates throttling.
const REHELLO_STREAK_WINDOW_MS = 10 * 60_000;

/** The minimal socket surface the registry reads. Real `ws` sockets satisfy it. */
export interface RegistrySocket {
  readyState: number;
}

export interface PluginEntry<S extends RegistrySocket = RegistrySocket> {
  instanceId: string;
  ws: S;
  scene: PluginScene; // { fileName, page, ... } — grows via FILE_INFO
  connectedAt: number; // first HELLO for this instance (survives same-instance re-HELLO)
  lastSeenAt: number; // any inbound frame/pong — LIVENESS only (heartbeat cull)
  lastActiveAt: number; // real interaction (HELLO/FILE_INFO/command traffic) — drives ROUTING recency
  // Monotonic tie-break for `lastActiveAt`, bumped alongside it on every write (register,
  // updateScene, touchActive). `Date.now()` is millisecond-resolution — two HELLOs on the
  // same fast loopback connection routinely land in the SAME tick, and a bare
  // `lastActiveAt` comparison then falls through to `Array.prototype.sort`'s stability,
  // silently favoring whichever entry was inserted into the Map FIRST instead of whichever
  // one actually happened last. That is backwards from the documented "most recently
  // active" routing contract. `activitySeq` never ties (each write takes the next integer),
  // so it always resolves the real order even when the wall clock can't tell the two apart.
  activitySeq: number;
  // Zombie-watchdog observability — bumped ONLY by `touchApp`/`register` (real
  // JS-originated frames), NEVER by the transport-only `touch` a raw WS pong uses.
  // This one split is the whole design: it is what lets a frozen-but-still-
  // pinging iframe read as stale instead of healthy.
  lastAppFrameAt: number;
  // Diagnostic: total same-instance re-registers this run (any reconnect with a
  // NEW socket for the same instanceId), regardless of scene or timing.
  reHelloCount: number;
  // Consecutive same-scene reconnects landing within `REHELLO_STREAK_WINDOW_MS`
  // of each other — the throttled-flapper signal. Reset by any genuine app
  // activity (`touchActive`) or a scene-CHANGING `updateScene`; a fresh instance
  // starts at 1 (seen once, nothing to flap yet).
  sameSceneStreak: number;
  // When the last reconnect (superseded same-instance register) happened, or
  // null before the first one — the anchor `sameSceneStreak` windows against.
  lastReHelloAt: number | null;
  // auto-connect slice 1 — retained (not stripped like the rest of PROTOCOL_KEYS)
  // so `statusList()` can surface what build/protocol this instance is actually
  // running. `undefined` (never sent — an older plugin bundle) is distinct from
  // any real value; `statusList()` itself only surfaces these raw fields — the
  // computed versionMatch/protocolMatch comparison lives in broker-peek.ts.
  pluginVersion?: string;
  protocolV?: number;
}

// HELLO payload keys that are protocol plumbing, not scene identity.
const PROTOCOL_KEYS = new Set(['instanceId', 'pluginVersion', 'protocolV']);

/** Strip protocol keys from a HELLO/FILE_INFO payload → the scene subset. */
export function extractScene(data: Record<string, unknown> | null | undefined): PluginScene {
  const scene: PluginScene = {};
  for (const [k, v] of Object.entries(data ?? {})) if (!PROTOCOL_KEYS.has(k)) scene[k] = v;
  return scene;
}

/**
 * Zombie-watchdog detection predicate, computed at READ time (no new timer): either
 * the app-frame-silence sensor tripped (frozen — the primary, invisible-otherwise
 * mode) or the same-scene reconnect streak did (throttled flapper — secondary).
 * Absence of scene-changing activity is NEVER evidence on its own — an idle-healthy
 * file with hours-old edits but a live 10s app PING trips neither branch.
 */
export function suspectedZombie<S extends RegistrySocket>(
  e: PluginEntry<S>,
  now: number,
  thresholdMs: number = FROZEN_AFTER_MS,
): boolean {
  return now - e.lastAppFrameAt > thresholdMs || e.sameSceneStreak >= FLAPPER_STREAK_THRESHOLD;
}

/** The human-readable cause behind `suspectedZombie`, or null if neither branch
 *  tripped. Checked in the same frozen-first order as the predicate: a fully-frozen
 *  instance is the more severe/invisible failure mode, so its message wins even if a
 *  stale flapper streak also happens to be sitting at/above threshold. */
function zombieReason<S extends RegistrySocket>(e: PluginEntry<S>, now: number, thresholdMs: number): string | null {
  const appSilenceMs = now - e.lastAppFrameAt;
  if (appSilenceMs > thresholdMs) {
    return `no app heartbeat for ${Math.round(appSilenceMs / 1000)}s — editor window likely backgrounded/frozen; focus it once to revive`;
  }
  if (e.sameSceneStreak >= FLAPPER_STREAK_THRESHOLD) {
    return `${e.sameSceneStreak} reconnects with unchanged scene — editor window throttled in background; focus it once`;
  }
  return null;
}

/**
 * The set of live plugin instances behind the broker. Add/update on PLUGIN_HELLO,
 * merge scene on FILE_INFO, remove on socket close (or cull a dead socket), and
 * pick a routing target by most-recent activity (optionally filtered by fileName).
 */
export class PluginRegistry<S extends RegistrySocket = RegistrySocket> {
  private readonly plugins = new Map<string, PluginEntry<S>>();
  private counter = 0;
  // Separate from `counter` (which only advances when `mint()` coins a fresh instanceId,
  // i.e. NOT on a carried-instanceId re-HELLO) — this one advances on every `lastActiveAt`
  // write, so it is a reliable total order over ALL activity, not just first-time registers.
  private activitySeqCounter = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Register or update a plugin instance. The id comes from the HELLO payload
   * (`instanceId`, minted once per relay load); a legacy plugin that omits it
   * reuses the id already bound to this socket, else a fresh minted one.
   * NEVER evicts a DIFFERENT instance — that was the whole bug. Returns whether
   * this REPLACED the same instance's prior entry, plus any prior *live* socket
   * the same instance is superseding (a reconnect), so the daemon can close it.
   */
  register(ws: S, data: Record<string, unknown>): { instanceId: string; replaced: boolean; superseded: S | null } {
    const now = this.now();
    const carried = typeof data.instanceId === 'string' && data.instanceId ? data.instanceId : null;
    const id = carried ?? this.instanceForWs(ws) ?? this.mint();
    const existing = this.plugins.get(id);
    const superseded = existing && existing.ws !== ws ? existing.ws : null;
    const scene = extractScene(data);
    // Zombie-watchdog flapper streak — only a reconnect on a NEW socket for this
    // same instance (`superseded !== null`) is a candidate re-HELLO; a duplicate
    // HELLO on the SAME still-open socket is not a reconnect at all, so it leaves
    // the streak untouched.
    let reHelloCount = existing?.reHelloCount ?? 0;
    let sameSceneStreak = existing?.sameSceneStreak ?? 1;
    let lastReHelloAt = existing?.lastReHelloAt ?? null;
    if (superseded !== null) {
      reHelloCount += 1;
      const sameScene = JSON.stringify(scene) === JSON.stringify(existing!.scene);
      const withinWindow = existing!.lastReHelloAt !== null && now - existing!.lastReHelloAt < REHELLO_STREAK_WINDOW_MS;
      sameSceneStreak = sameScene && withinWindow ? existing!.sameSceneStreak + 1 : 1;
      lastReHelloAt = now;
    }
    this.plugins.set(id, {
      instanceId: id,
      ws,
      scene,
      connectedAt: existing ? existing.connectedAt : now,
      lastSeenAt: now,
      lastActiveAt: now,
      activitySeq: ++this.activitySeqCounter,
      lastAppFrameAt: now, // a HELLO is itself an app frame — real JS just spoke
      reHelloCount,
      sameSceneStreak,
      lastReHelloAt,
      // auto-connect slice 1 — read straight off THIS HELLO's data, not carried over
      // from `existing`: a reconnect after a plugin rebuild must report the NEW build's
      // version, never a stale one left over from the superseded socket.
      pluginVersion: typeof data.pluginVersion === 'string' ? data.pluginVersion : undefined,
      protocolV: typeof data.protocolV === 'number' ? data.protocolV : undefined,
    });
    return { instanceId: id, replaced: existing !== undefined, superseded };
  }

  /** Merge a FILE_INFO scene update (page change) into the socket's entry. A scene
   *  change is real activity AND proves the reconnect streak wasn't flapping on
   *  unchanged content, so it resets `sameSceneStreak` — but only when the scene
   *  actually changed; re-sending the same scene must not silently clear suspicion. */
  updateScene(ws: S, data: Record<string, unknown>): boolean {
    const entry = this.getByWs(ws);
    if (!entry) return false;
    const merged = { ...entry.scene, ...extractScene(data) };
    const changed = JSON.stringify(merged) !== JSON.stringify(entry.scene);
    entry.scene = merged;
    entry.lastSeenAt = this.now();
    entry.lastActiveAt = entry.lastSeenAt;
    entry.activitySeq = ++this.activitySeqCounter;
    if (changed) entry.sameSceneStreak = 0;
    return true;
  }

  /** Bump TRANSPORT liveness only — a raw WS pong, which a browser answers from its
   *  network process even while the tab's JS is frozen. Deliberately does NOT touch
   *  `lastAppFrameAt`: a frozen iframe must stay flagged stale by the app-liveness
   *  sensor no matter how healthy its transport still looks. Returns false if the
   *  socket is not a registered plugin (i.e. it is a CLI client). */
  touch(ws: S): boolean {
    const entry = this.getByWs(ws);
    if (!entry) return false;
    entry.lastSeenAt = this.now();
    return true;
  }

  /** Bump APP liveness — a parsed frame that only real JS could have sent (any
   *  message the daemon's socket handler receives at all). Also counts as transport
   *  liveness (a superset), so it bumps `lastSeenAt` too. */
  touchApp(ws: S): boolean {
    const entry = this.getByWs(ws);
    if (!entry) return false;
    const now = this.now();
    entry.lastSeenAt = now;
    entry.lastAppFrameAt = now;
    return true;
  }

  /** Bump ROUTING recency too — only real interaction frames (command replies, chunks,
   *  FILE_INFO). Heartbeat PONGs must NOT call this: they fire for every connected file
   *  on a timer, which would flip the routing target on heartbeat phase instead of
   *  tracking what the user actually touched. Any real interaction also proves the
   *  instance isn't flapping right now, so it clears `sameSceneStreak`. */
  touchActive(ws: S): boolean {
    const entry = this.getByWs(ws);
    if (!entry) return false;
    entry.lastSeenAt = this.now();
    entry.lastActiveAt = entry.lastSeenAt;
    entry.activitySeq = ++this.activitySeqCounter;
    entry.sameSceneStreak = 0;
    return true;
  }

  getByWs(ws: S): PluginEntry<S> | null {
    for (const e of this.plugins.values()) if (e.ws === ws) return e;
    return null;
  }

  /**
   * Concurrency & jobs (backlog 1.1+2.6+4.3) — resolve a job's PINNED `targetInstanceId`
   * at dequeue time. Never re-resolves by filter/recency (a queued mutation must land in
   * the SAME file it was admitted for, never whichever file became most-recent while it
   * waited) — only whether that exact instance is still live. `null` (instance gone) or a
   * closed socket both mean the same thing to a caller: the pinned target vanished.
   */
  getByInstanceId(instanceId: string): PluginEntry<S> | null {
    return this.plugins.get(instanceId) ?? null;
  }

  private instanceForWs(ws: S): string | null {
    return this.getByWs(ws)?.instanceId ?? null;
  }

  /** Remove the entry owning this socket (disconnect). Returns its id, or null
   *  if the socket owned no entry (a CLI client, or an already-superseded socket). */
  removeByWs(ws: S): string | null {
    const entry = this.getByWs(ws);
    if (!entry) return null;
    this.plugins.delete(entry.instanceId);
    return entry.instanceId;
  }

  /** Drop every entry whose socket is no longer OPEN. Returns removed ids.
   *  (The daemon culls via socket 'close'; this is the pure equivalent for tests
   *  and a defensive sweep.) Each dead socket removes only ITS entry — no global
   *  eviction. */
  cullClosed(): string[] {
    const removed: string[] = [];
    for (const [id, e] of this.plugins) {
      if (e.ws.readyState !== WS_OPEN) {
        this.plugins.delete(id);
        removed.push(id);
      }
    }
    return removed;
  }

  /** Live entries (socket OPEN), in insertion order. */
  liveEntries(): PluginEntry<S>[] {
    return [...this.plugins.values()].filter((e) => e.ws.readyState === WS_OPEN);
  }

  /** Count of live plugin instances. */
  size(): number {
    return this.liveEntries().length;
  }

  /**
   * Live entries matching the filter. `opts.kind === 'instance'` (instance targeting)
   * branches to `getByInstanceId` instead of name matching: an instanceId is
   * exact and unique by construction, so the result is the single live entry or `[]` — NEVER
   * a name-fuzzy list, even when other entries share the same fileName (the whole reason
   * `--instance` exists: two unsaved files both named "Untitled" are otherwise indistinguishable).
   * Default (`kind` omitted or `'name'`): live entries whose fileName matches (unfiltered →
   * all). Ordering: most-recently-active first.
   */
  matching(filter?: string | null, opts?: { exact?: boolean; kind?: FilterKind }): PluginEntry<S>[] {
    const f = filter?.trim();
    if (opts?.kind === 'instance') {
      if (!f) return [];
      const hit = this.getByInstanceId(f);
      return hit && hit.ws.readyState === WS_OPEN ? [hit] : [];
    }
    const live = this.liveEntries();
    const hits = f ? live.filter((e) => fileMatches(e.scene.fileName as string | undefined, f, opts?.exact === true)) : live;
    // A named/filtered ask is a deliberate targeting decision — it always resolves by
    // pure recency, reaching a suspected zombie if that's what the name (or instance,
    // handled above) names. Only the UNFILTERED default selection deprioritizes a
    // suspected zombie: it must never win the no-flag routing slot over a healthy
    // plugin purely by having re-HELLO'd more recently. When every live candidate is
    // suspected, the group collapses to one and recency alone decides — a fallback,
    // never a refusal, since a suspected zombie is still a connected, usable plugin.
    if (!f) {
      const now = this.now();
      return [...hits].sort((a, b) => {
        const zombieRank = Number(suspectedZombie(a, now)) - Number(suspectedZombie(b, now));
        if (zombieRank !== 0) return zombieRank;
        // `activitySeq` breaks a `lastActiveAt` millisecond tie with the TRUE order —
        // see the field's own doc comment on `PluginEntry`.
        return b.lastActiveAt - a.lastActiveAt || b.activitySeq - a.activitySeq;
      });
    }
    return [...hits].sort((a, b) => b.lastActiveAt - a.lastActiveAt || b.activitySeq - a.activitySeq);
  }

  /**
   * The routing target: the live plugin with the most-recent `lastActiveAt` — "the
   * file the user touched last" — EXCEPT when no filter is given at all, where a
   * suspected zombie (see `suspectedZombie`) is deprioritized behind any healthy
   * plugin (see `matching`). An optional fileName filter (case-insensitive substring
   * by default, or `opts.exact` for a whole-name match — see `matching`) restricts
   * candidates by pure recency instead — a named/instance ask is explicit targeting
   * and reaches a suspected zombie on purpose; no candidate matches → null.
   */
  selectTarget(filter?: string | null, opts?: { exact?: boolean; kind?: FilterKind }): PluginEntry<S> | null {
    return this.matching(filter, opts)[0] ?? null;
  }

  /** The per-file list for BROKER_HELLO / `figma-agent status`, most-recent first. */
  statusList(): PluginStatusEntry[] {
    const now = this.now();
    return this.liveEntries()
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .map((e) => {
        const reason = zombieReason(e, now, FROZEN_AFTER_MS);
        return {
          instanceId: e.instanceId,
          fileName: (e.scene.fileName as string | undefined) ?? null,
          page: (e.scene.page as string | undefined) ?? null,
          state: 'connected' as const,
          lastHeartbeatAge: e.lastSeenAt ? now - e.lastSeenAt : null,
          connectedAt: e.connectedAt,
          fileKey: (e.scene.fileKey as string | null | undefined) ?? null,
          // Zombie-watchdog observability — the raw sensor is ALWAYS present (an agent
          // can judge staleness itself); the derived flag/counter/reason are present
          // only when they carry information, same present-only contract as
          // senderMismatchCount on the top-level BROKER_HELLO payload.
          appSilenceMs: now - e.lastAppFrameAt,
          ...(e.reHelloCount > 0 && { reHelloCount: e.reHelloCount }),
          ...(reason !== null && { suspectedZombie: true as const, zombieReason: reason }),
          // auto-connect slice 1 — present only when the HELLO actually carried it (an
          // older plugin bundle omits both), same "common case stays byte-identical"
          // contract as reHelloCount/suspectedZombie above.
          ...(e.pluginVersion !== undefined && { pluginVersion: e.pluginVersion }),
          ...(e.protocolV !== undefined && { protocolV: e.protocolV }),
        };
      });
  }

  private mint(): string {
    return `p_${++this.counter}_${this.now()}`;
  }
}
