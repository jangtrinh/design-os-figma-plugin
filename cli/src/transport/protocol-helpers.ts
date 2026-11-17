// Wire-protocol helpers shared by broker daemon + broker client:
// typed guards, chunked send (>512KB), chunk reassembly, raw-frame decoding.
// Protocol constants/types live in shared/protocol.ts (frozen contract).
import {
  CHUNK_LIMIT,
  type ChunkMsg,
  type ErrorCode,
  type EventMsg,
  type JobRecovery,
  type ReplyMsg,
  type RequestMsg,
  type WireMsg,
} from '../../../shared/protocol.ts';

/** Error carrying a protocol error code; the CLI prints it as {error:{code,message}}. */
export class CliError extends Error {
  readonly code: ErrorCode;
  /** Set when EXEC_JS --undo-group rolled the script's changes back (WireError.rolledBack). */
  readonly rolledBack?: boolean;
  /**
   * Concurrency & jobs (backlog 1.1+2.6+4.3) — set on an E_TIMEOUT once the broker has
   * confirmed the request became a job (a JOB_STATE was seen before the timeout fired).
   * The one signal `runWithWarmRetry` needs to stop retrying a timeout: the CLI never
   * re-dispatches once a job exists, because the job survives and its result is
   * retrievable (`figma-agent job <id>`) — retrying would double-dispatch instead.
   */
  readonly jobId?: string;
  readonly recovery?: JobRecovery;
  /** E_AMBIGUOUS (`resolve-component`): every node that answered to the name, as data. */
  readonly candidates?: readonly unknown[];
  constructor(code: ErrorCode, message: string, opts?: { rolledBack?: boolean; jobId?: string; recovery?: JobRecovery; candidates?: readonly unknown[] }) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    if (opts?.rolledBack) this.rolledBack = opts.rolledBack;
    if (opts?.jobId !== undefined) this.jobId = opts.jobId;
    if (opts?.recovery !== undefined) this.recovery = opts.recovery;
    if (opts?.candidates !== undefined) this.candidates = opts.candidates;
  }
}

/**
 * Read a positive-integer env override, else fall back. Shared by broker-daemon.ts
 * (idle-shutdown/heartbeat/plugin-wait knobs) and broker-discovery.ts
 * (`isAdvertisementLive`'s staleness slack) so both sides of the same heartbeat
 * contract shrink together under a test override — one function, not two
 * independently-hardcoded copies that could silently drift apart.
 */
export function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** ws 'message' payloads arrive as Buffer | ArrayBuffer | Buffer[] — normalize to utf8 text. */
export function rawToString(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw as Buffer[]).toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  return (raw as Buffer).toString('utf8');
}

export function parseWireMsg(text: string): WireMsg | null {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' ? (value as WireMsg) : null;
  } catch {
    return null;
  }
}

// ── Type guards (check most-specific shape first at call sites) ─────
export function isChunkMsg(m: WireMsg): m is ChunkMsg {
  const c = m as ChunkMsg;
  return typeof c.id === 'string' && typeof c.seq === 'number' && typeof c.chunk === 'string';
}

export function isReplyMsg(m: WireMsg): m is ReplyMsg {
  const r = m as ReplyMsg;
  return typeof r.id === 'string' && typeof (r as { ok?: unknown }).ok === 'boolean';
}

export function isRequestMsg(m: WireMsg): m is RequestMsg {
  const r = m as RequestMsg;
  return typeof r.id === 'string' && typeof r.cmd === 'string';
}

export function isEventMsg(m: WireMsg): m is EventMsg {
  return typeof (m as EventMsg).type === 'string' && !('id' in m);
}

/** Minimal structural socket type so both ws server-side and client sockets fit. */
interface Sendable {
  send(data: string): void;
}

/**
 * Send a wire message, splitting into {id,seq,last,chunk} frames when the
 * serialized form exceeds CHUNK_LIMIT (both directions per protocol §2).
 */
export function sendWireMsg(ws: Sendable, msg: RequestMsg | ReplyMsg | EventMsg): void {
  const full = JSON.stringify(msg);
  if (full.length <= CHUNK_LIMIT || !('id' in msg)) {
    ws.send(full);
    return;
  }
  const totalChunks = Math.ceil(full.length / CHUNK_LIMIT);
  for (let seq = 0; seq < totalChunks; seq++) {
    const frame: ChunkMsg = {
      id: msg.id,
      seq,
      last: seq === totalChunks - 1,
      chunk: full.slice(seq * CHUNK_LIMIT, (seq + 1) * CHUNK_LIMIT),
    };
    ws.send(JSON.stringify(frame));
  }
}

/**
 * Reassembles chunked messages by id. WS frames are TCP-ordered, so the
 * `last` frame arrives last; missing frames at that point → E_CHUNK_LOST.
 */
export class ChunkAssembler {
  private readonly parts = new Map<string, { chunks: string[]; received: number }>();

  /** Returns the fully reassembled message when `last` arrives, else null. */
  accept(msg: ChunkMsg): WireMsg | null {
    let entry = this.parts.get(msg.id);
    if (!entry) {
      entry = { chunks: [], received: 0 };
      this.parts.set(msg.id, entry);
    }
    if (entry.chunks[msg.seq] === undefined) entry.received++;
    entry.chunks[msg.seq] = msg.chunk;
    if (!msg.last) return null;

    this.parts.delete(msg.id);
    const total = msg.seq + 1;
    if (entry.received !== total) {
      throw new CliError('E_CHUNK_LOST', `chunked message ${msg.id}: received ${entry.received}/${total} frames`);
    }
    const parsed = parseWireMsg(entry.chunks.join(''));
    if (!parsed) {
      throw new CliError('E_CHUNK_LOST', `chunked message ${msg.id}: reassembled JSON is invalid`);
    }
    return parsed;
  }
}

// Request-side admission and cleanup live in their own transport boundary. Re-export the
// established buffer helpers here so existing callers keep the same internal API.
export {
  abandonedChunkIds,
  deleteConnectionChunk,
  deleteConnectionChunks,
  getConnectionChunks,
  requestChunkCandidateId,
  summarizeChunkCleanups,
  sweepAbandonedChunks,
  validateRequestChunkFrame,
  type ChunkBuffers,
  type ChunkCleanup,
} from './request-chunk-admission.ts';
