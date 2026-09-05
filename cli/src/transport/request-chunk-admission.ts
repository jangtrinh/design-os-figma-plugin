import type { ChunkMsg, WireMsg } from '../../../shared/protocol.ts';

export interface PendingRequestChunk {
  frames: string[];
  lastFrameAt: number;
}

export type ChunkBuffers<Connection> = Map<Connection, Map<string, PendingRequestChunk>>;

export interface ChunkCleanup<Connection> {
  connection: Connection;
  id: string;
  requestCount: 1;
  frameCount: number;
  utf8Bytes: number;
}

export interface ChunkCleanupSummary {
  requestCount: number;
  frameCount: number;
  utf8Bytes: number;
}

type ChunkValidation =
  | { ok: true; frame: ChunkMsg }
  | { ok: false; kind: 'metadata' | 'sequence'; message: string };

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * Classify only otherwise-unclassified CLI frames. A valid request or reply keeps its
 * existing route even if a future envelope adds a top-level chunk-like field.
 */
export function requestChunkCandidateId(msg: WireMsg): string | null {
  const value = msg as unknown as Record<string, unknown>;
  if (typeof value.id !== 'string') return null;
  if (typeof value.cmd === 'string' || typeof value.ok === 'boolean') return null;
  return hasOwn(value, 'seq') || hasOwn(value, 'last') || hasOwn(value, 'chunk') ? value.id : null;
}

/** Validate request-side metadata and ordering before the raw frame is retained. */
export function validateRequestChunkFrame(msg: WireMsg, expectedSequence: number): ChunkValidation {
  const value = msg as unknown as Record<string, unknown>;
  if (!Number.isSafeInteger(value.seq) || (value.seq as number) < 0) {
    return { ok: false, kind: 'metadata', message: 'chunk seq must be a nonnegative safe integer' };
  }
  if (typeof value.last !== 'boolean') {
    return { ok: false, kind: 'metadata', message: 'chunk last must be a boolean' };
  }
  if (typeof value.chunk !== 'string') {
    return { ok: false, kind: 'metadata', message: 'chunk payload must be a string' };
  }
  if (value.seq !== expectedSequence) {
    return {
      ok: false,
      kind: 'sequence',
      message: `chunk sequence ${String(value.seq)} does not match expected ${expectedSequence}`,
    };
  }
  return { ok: true, frame: value as unknown as ChunkMsg };
}

export function getConnectionChunks<Connection>(
  buffers: ChunkBuffers<Connection>,
  connection: Connection,
): Map<string, PendingRequestChunk> {
  let chunks = buffers.get(connection);
  if (!chunks) {
    chunks = new Map();
    buffers.set(connection, chunks);
  }
  return chunks;
}

function cleanupFor<Connection>(
  connection: Connection,
  id: string,
  entry: PendingRequestChunk,
): ChunkCleanup<Connection> {
  let utf8Bytes = 0;
  for (const frame of entry.frames) utf8Bytes += Buffer.byteLength(frame, 'utf8');
  return { connection, id, requestCount: 1, frameCount: entry.frames.length, utf8Bytes };
}

/** Release one connection/id and return its retained usage before deletion. */
export function deleteConnectionChunk<Connection>(
  buffers: ChunkBuffers<Connection>,
  connection: Connection,
  id: string,
): ChunkCleanup<Connection> | null {
  const chunks = buffers.get(connection);
  const entry = chunks?.get(id);
  if (!chunks || !entry) return null;
  const cleanup = cleanupFor(connection, id, entry);
  chunks.delete(id);
  if (chunks.size === 0) buffers.delete(connection);
  return cleanup;
}

/** Release every partial request owned by one closing connection. */
export function deleteConnectionChunks<Connection>(
  buffers: ChunkBuffers<Connection>,
  connection: Connection,
): ChunkCleanup<Connection>[] {
  const chunks = buffers.get(connection);
  if (!chunks) return [];
  const cleanups = [...chunks].map(([id, entry]) => cleanupFor(connection, id, entry));
  buffers.delete(connection);
  return cleanups;
}

export function abandonedChunkIds(
  pendingChunks: ReadonlyMap<string, { lastFrameAt: number }>,
  now: number,
  boundMs: number,
): string[] {
  const ids: string[] = [];
  for (const [id, entry] of pendingChunks) {
    if (now - entry.lastFrameAt > boundMs) ids.push(id);
  }
  return ids;
}

/** Sweep stale partial requests and return exact retained usage for audit/replies. */
export function sweepAbandonedChunks<Connection>(
  buffers: ChunkBuffers<Connection>,
  now: number,
  boundMs: number,
): ChunkCleanup<Connection>[] {
  const cleanups: ChunkCleanup<Connection>[] = [];
  for (const [connection, chunks] of buffers) {
    for (const id of abandonedChunkIds(chunks, now, boundMs)) {
      const entry = chunks.get(id);
      if (!entry) continue;
      cleanups.push(cleanupFor(connection, id, entry));
      chunks.delete(id);
    }
    if (chunks.size === 0) buffers.delete(connection);
  }
  return cleanups;
}

export function summarizeChunkCleanups<Connection>(
  cleanups: readonly ChunkCleanup<Connection>[],
): ChunkCleanupSummary {
  let requestCount = 0;
  let frameCount = 0;
  let utf8Bytes = 0;
  for (const cleanup of cleanups) {
    requestCount += cleanup.requestCount;
    frameCount += cleanup.frameCount;
    utf8Bytes += cleanup.utf8Bytes;
  }
  return { requestCount, frameCount, utf8Bytes };
}
