// Plugin-disconnect record (`figma-disconnects.jsonl`) — fs layer + pure record builder.
//
// Every plugin socket close appends ONE JSON line: who closed it (the peer, the heartbeat
// cull, a same-instance re-HELLO superseding it, or this broker shutting down), what was
// in flight on it, and how stale it was. The file sits beside the broker's own
// advertisement (same broker-instance, cwd-independent location as `last-plugins.json`),
// never in a project's `design/` dir — a broker inherits whichever cwd spawned it.
//
// Privacy: a record carries identifiers, labels and timings only — never request
// params, script source, or canvas content. `inFlightJobs` reads the job's envelope
// fields (`cmd`, `activity`), which the broker already treats as metadata.
import { closeSync, constants, fchmodSync, fstatSync, openSync, readSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { rotateIfNeeded } from './log-rotate.ts';

export const DISCONNECT_LOG_FILENAME = 'figma-disconnects.jsonl';
/** How many newest records BROKER_HELLO carries — it rides every connect, so stay small. */
export const DISCONNECT_RING_SIZE = 5;
/** A WebSocket close reason is at most 123 bytes on the wire; never store more. */
const CLOSE_REASON_MAX_BYTES = 123;
/** Startup seed reads at most this much of the file's end. */
const SEED_TAIL_MAX_BYTES = 64 * 1024;

export type DisconnectClosedBy = 'peer' | 'broker-heartbeat-cull' | 'broker-superseded' | 'broker-shutdown';

export interface DisconnectInFlightJob {
  jobId: string;
  cmd: string;
  activity: string | null;
  elapsedMs: number;
}

export interface DisconnectRecord {
  at: string;
  instanceId: string;
  fileName: string | null;
  fileKey: string | null;
  closeCode: number | null;
  closeReason: string;
  closedBy: DisconnectClosedBy;
  superseded: boolean;
  msSinceLastSeen: number | null;
  msSinceLastAppFrame: number | null;
  socketOpenForMs: number;
  inFlightJobs: DisconnectInFlightJob[];
  queueDepthByFile: Record<string, number>;
}

/** The BROKER_HELLO `disconnects` field. */
export interface DisconnectsStatus {
  path: string;
  last: DisconnectRecord[];
  appendFailures: number;
  /** Startup reads of the record file that failed (a missing file is not one). */
  readFailures: number;
}

/** What the broker knows about one plugin socket, independent of the registry entry —
 *  a same-instance re-HELLO repoints that entry at the NEW socket, so the old socket's
 *  identity and last-known liveness must be kept here to describe its own close. */
export interface PluginSocketInfo {
  instanceId: string;
  openedAt: number;
  /** Set when a re-HELLO superseded this socket: the registry entry's view of it at that
   *  moment, since the entry itself now describes the replacement socket. */
  supersededSnapshot?: PluginLiveness;
}

export interface PluginLiveness {
  fileName: string | null;
  fileKey: string | null;
  lastSeenAt: number;
  lastAppFrameAt: number;
}

/** `<dirname(advertisePath)>/figma-disconnects.jsonl` — mirrors `lastPluginsPathFor`. */
export function disconnectLogPathFor(advertisePath: string): string {
  return join(dirname(advertisePath), DISCONNECT_LOG_FILENAME);
}

/** Truncate to at most 123 UTF-8 bytes without splitting a code point. */
export function boundedCloseReason(reason: string | Buffer | undefined): string {
  const text = reason === undefined ? '' : reason.toString();
  if (Buffer.byteLength(text) <= CLOSE_REASON_MAX_BYTES) return text;
  let out = '';
  for (const ch of text) {
    if (Buffer.byteLength(out + ch) > CLOSE_REASON_MAX_BYTES) break;
    out += ch;
  }
  return out;
}

export interface BuildDisconnectRecordInput {
  now: number;
  info: PluginSocketInfo;
  /** The live registry entry for this socket's instance when it still points at this
   *  socket; `null` when superseded (then `info.supersededSnapshot` describes it). */
  liveEntry: PluginLiveness | null;
  closedBy: DisconnectClosedBy;
  closeCode: number | null;
  closeReason: string | Buffer | undefined;
  inFlightJobs: Array<{ jobId: string; cmd: string; activity?: string; startedAt?: number; createdAt: number }>;
  queueDepthByFile: Record<string, number>;
}

export function buildDisconnectRecord(input: BuildDisconnectRecordInput): DisconnectRecord {
  const { now, info } = input;
  const liveness = input.liveEntry ?? info.supersededSnapshot ?? null;
  return {
    at: new Date(now).toISOString(),
    instanceId: info.instanceId,
    fileName: liveness?.fileName ?? null,
    fileKey: liveness?.fileKey ?? null,
    closeCode: input.closeCode,
    closeReason: boundedCloseReason(input.closeReason),
    closedBy: input.closedBy,
    superseded: input.liveEntry === null,
    msSinceLastSeen: liveness ? Math.max(0, now - liveness.lastSeenAt) : null,
    msSinceLastAppFrame: liveness ? Math.max(0, now - liveness.lastAppFrameAt) : null,
    socketOpenForMs: Math.max(0, now - info.openedAt),
    inFlightJobs: input.inFlightJobs.map((job) => ({
      jobId: job.jobId,
      cmd: job.cmd,
      activity: job.activity ?? null,
      elapsedMs: Math.max(0, now - (job.startedAt ?? job.createdAt)),
    })),
    queueDepthByFile: input.queueDepthByFile,
  };
}

/**
 * Append one record, synchronously (the shutdown path exits right after). Opened with
 * O_NOFOLLOW and created 0600 — the production path is in shared /tmp — and an existing
 * file with looser bits (e.g. the fresh file `rotateIfNeeded` leaves) is tightened
 * before writing. Throws on failure; the caller counts it. Rotation is the caller's
 * next step (`rotateDisconnectLog`).
 */
export function appendDisconnectRecord(path: string, record: DisconnectRecord): void {
  const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW;
  const fd = openSync(path, flags, 0o600);
  try {
    if ((fstatSync(fd).mode & 0o077) !== 0) fchmodSync(fd, 0o600);
    writeSync(fd, `${JSON.stringify(record)}\n`);
  } finally {
    closeSync(fd);
  }
}

/** Rotate after an append — kept apart from `appendDisconnectRecord` so a rotation
 *  failure is reported as one, never counted as a lost record. */
export function rotateDisconnectLog(path: string): void {
  rotateIfNeeded(path);
}

/** Newest-first ring of the last `DISCONNECT_RING_SIZE` records. Returns a new array. */
export function pushDisconnectRing(ring: readonly DisconnectRecord[], record: DisconnectRecord): DisconnectRecord[] {
  return [record, ...ring].slice(0, DISCONNECT_RING_SIZE);
}

/**
 * Newest-first records from the END of the file, for seeding the ring at broker start so
 * `status` still shows records written before a restart (incl. `broker-shutdown` ones).
 * Reads at most `SEED_TAIL_MAX_BYTES`; a line cut by the window's start is dropped, and
 * lines that do not parse as a record are counted in `skipped`. A missing file is empty.
 * Throws only on a real read error — the caller counts it.
 */
export function readDisconnectTail(path: string): { records: DisconnectRecord[]; skipped: number } {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { records: [], skipped: 0 };
    throw err;
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - SEED_TAIL_MAX_BYTES);
    const buf = Buffer.alloc(size - start);
    let filled = 0;
    while (filled < buf.length) {
      const n = readSync(fd, buf, filled, buf.length - filled, start + filled);
      if (n === 0) break;
      filled += n;
    }
    const lines = buf.subarray(0, filled).toString('utf8').split('\n');
    if (start > 0) lines.shift();
    if (lines[lines.length - 1] === '') lines.pop();
    const records: DisconnectRecord[] = [];
    let skipped = 0;
    for (const line of lines) {
      if (line.trim() === '') continue;
      try {
        const parsed = JSON.parse(line) as DisconnectRecord;
        if (parsed === null || typeof parsed !== 'object' || typeof parsed.at !== 'string' || typeof parsed.instanceId !== 'string') skipped += 1;
        else records.push(parsed);
      } catch { skipped += 1; }
    }
    return { records: records.slice(-DISCONNECT_RING_SIZE).reverse(), skipped };
  } finally {
    closeSync(fd);
  }
}
