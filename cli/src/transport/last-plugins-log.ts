// Broker-restart reconnect visibility (`last-plugins.json`) — fs layer for the broker.
//
// A freshly-spawned broker's registry starts EMPTY: a backgrounded editor (FigJam/Slides,
// throttled by Figma so its reconnect loop stalls) that hasn't reconnected yet is
// INVISIBLE after a restart — the owner's actual live symptom, the "focus-dance" of
// clicking every window to revive it. This module persists the LIVE plugin set,
// debounced, beside the broker's own advertisement file (broker-INSTANCE state, never a
// project's `design/` dir — a project may not even be bound yet). On the next startup, a
// recently-seen entry is held as `awaitingReconnect` until it re-HELLOs or ages out — a
// HINT derived from last-known state, NEVER a claim of a live connection (see
// `toAwaitingReconnectStatus`'s own doc). A JSON snapshot, not an append-only log (unlike
// contention-log.ts/error-log.ts): only the LATEST live set matters here, never history —
// same "near-copy, deliberately separate" contract as those two, not a shared util.
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const LAST_PLUGINS_FILENAME = 'last-plugins.json';

/** One persisted plugin's last-known identity + liveness, as of the most recent
 *  debounced write. Never anything beyond these three fields — not scene, not jobs
 *  (spec non-goal: this is a reconnect hint, not a state mirror). */
export interface LastPluginRecord {
  instanceId: string;
  fileName: string | null;
  lastSeenAt: number;
}

/** The broker's own in-memory bookkeeping between startup and either a clear (RE-HELLO)
 *  or a wholesale expiry — carries `instanceId` internally so `clearReconnected` can
 *  match it, but `instanceId` never reaches `status` (see `AwaitingReconnectStatusEntry`). */
export interface AwaitingReconnectEntry {
  instanceId: string;
  fileName: string | null;
  lastSeenAt: number;
}

/** The `awaitingReconnect` shape surfaced on `status` — deliberately WITHOUT
 *  `instanceId`: an agent/human reading `status` must never mistake this for an
 *  addressable live target (`plugins[]` is the only truth for that). */
export interface AwaitingReconnectStatusEntry {
  fileName: string | null;
  lastSeenBeforeShutdown: number;
}

/** `<dirname(advertisePath)>/last-plugins.json` — the SAME directory as the broker's own
 *  advertisement file (cwd-independent, one per broker instance), never a project's
 *  `design/` dir: this is broker-instance state, unrelated to any project binding and
 *  readable before one exists. */
export function lastPluginsPathFor(advertisePath: string): string {
  return join(dirname(advertisePath), LAST_PLUGINS_FILENAME);
}

function isValidRecord(v: unknown): v is LastPluginRecord {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r.instanceId === 'string' &&
    (r.fileName === null || typeof r.fileName === 'string') &&
    typeof r.lastSeenAt === 'number' && Number.isFinite(r.lastSeenAt);
}

/** Reads the persisted plugin set. A missing or corrupt file reads as empty — no prior
 *  broker ever persisted one (or left a torn write behind), never an error; degrades to
 *  "nothing to hold as awaiting" rather than blocking startup (same contract as
 *  contention-log.ts's `readContentionStore`). A parsed-but-malformed entry is dropped
 *  individually, never one bad entry discarding the whole file. */
export function readLastPlugins(path: string): LastPluginRecord[] {
  if (!existsSync(path)) return [];
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(raw) ? raw.filter(isValidRecord) : [];
  } catch {
    return [];
  }
}

/** Atomic write (mirrors broker-discovery.ts's `writeFileAtomic` for the advertisement
 *  file — deliberately a separate copy, not a shared util, per this repo's own
 *  "near-copy, kept separate" contract for these small fs helpers): full write to a
 *  process-unique temp file, then `renameSync`. This file is read only ONCE, at broker
 *  startup — before this same broker's own debounced writer has ever run — so there is
 *  no self-race to guard against; the atomic rename instead protects the NEXT broker's
 *  startup read from ever seeing a half-written blob left by a SIGKILL mid-write
 *  (`readLastPlugins`'s try/catch would degrade that to empty regardless, but the atomic
 *  rename avoids losing the previous good snapshot to the corruption in the first place). */
export function writeLastPluginsAtomic(path: string, records: readonly LastPluginRecord[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(records));
  try {
    renameSync(tmpPath, path);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* best-effort cleanup — the rename error below still wins */ }
    throw err;
  }
}

/** Filter persisted records down to those "recently seen" as of `startedAt` (THIS
 *  broker's own start time, injected — never `Date.now()` read here) — held as
 *  `awaitingReconnect` until cleared by a RE-HELLO or expired wholesale. `thresholdMs` is
 *  the spec's "< 10 min before this broker's start", passed in rather than hardcoded so a
 *  test can shrink it without a second copy of the production value. */
export function filterAwaitingReconnect(
  records: readonly LastPluginRecord[], startedAt: number, thresholdMs: number,
): AwaitingReconnectEntry[] {
  return records
    .filter((r) => startedAt - r.lastSeenAt < thresholdMs)
    .map((r) => ({ instanceId: r.instanceId, fileName: r.fileName, lastSeenAt: r.lastSeenAt }));
}

/** Clear the entry for a RE-HELLO — matched by `instanceId` first (the stable key across
 *  an ordinary same-session reconnect), falling back to `fileName` when no instanceId
 *  matches: a fresh iframe load mints a NEW instanceId (plugin-registry.ts's `register`
 *  contract), so the instanceId a broker restart persisted is never the one a
 *  post-restart reconnect re-HELLOs with. Returns a NEW array (pure) — never mutates
 *  `entries`, so the daemon's own closure state is always reassigned explicitly. */
export function clearReconnected(
  entries: readonly AwaitingReconnectEntry[], instanceId: string, fileName: string | null,
): AwaitingReconnectEntry[] {
  const byInstance = entries.filter((e) => e.instanceId !== instanceId);
  if (byInstance.length !== entries.length) return byInstance; // matched by instanceId
  if (fileName === null) return byInstance;
  return byInstance.filter((e) => e.fileName !== fileName);
}

/** The `status`-surfaced shape: EMPTY once this broker has been up `expiryMs` or more (a
 *  plugin that hasn't reconnected in that long is not "awaiting" — the user closed it or
 *  moved on; never nag forever) — else the internal entries stripped of `instanceId`
 *  (Law 1: `awaitingReconnect` must never read as addressable the way a live `plugins[]`
 *  row does). `uptimeMs` is `now - startedAt`, computed by the caller (this module never
 *  reads the clock itself, so both the threshold and the expiry stay deterministic for
 *  tests). */
export function toAwaitingReconnectStatus(
  entries: readonly AwaitingReconnectEntry[], uptimeMs: number, expiryMs: number,
): AwaitingReconnectStatusEntry[] {
  if (uptimeMs >= expiryMs) return [];
  return entries.map((e) => ({ fileName: e.fileName, lastSeenBeforeShutdown: e.lastSeenAt }));
}
