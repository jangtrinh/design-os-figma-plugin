// Adopting the winning broker socket: the two guards and the ordered flush, kept out of
// ui-relay.ts so they can be executed by a test instead of only reviewed by reading
// (ui-relay.ts is DOM-coupled at module scope and cannot be imported under vitest).
// Same injected-transport shape broker-scan.ts and outbound-buffer.ts already use.
//
// Nothing here touches the DOM, a timer, or a real WebSocket type — it reads
// `readyState` and calls `send`/`close` on whatever it is handed.

import type { HandshakeBatch, PreOpenBuffer } from './outbound-buffer';

// WebSocket readiness constants, inlined so this module needs no DOM lib reference.
export const SOCKET_CONNECTING = 0;
export const SOCKET_OPEN = 1;
export const SOCKET_CLOSING = 2;
export const SOCKET_CLOSED = 3;

/** The minimal socket surface adoption reads. A real browser WebSocket satisfies it. */
export interface AdoptableSocket {
  readyState: number;
  send(data: string): void;
  close(): void;
}

/** Why an adoption was refused, or null when the candidate may be adopted. */
export type AdoptionRefusal = 'already-adopted' | 'socket-not-open' | null;

/**
 * Decide whether this greeting may become the relay's socket.
 *
 * `already-adopted`: the port race can produce a second greeting after a winner is
 * already live (a loser that opened late, a probe that settled in the same tick). It is
 * closed here rather than left dangling — and the caller must NOT build the handshake
 * batch for it, because building drains the buffer.
 *
 * `socket-not-open`: the winner greeted and then died before the handshake — a broker
 * that idle-shut-down or was replaced in between. This is the guard that matters:
 * `send()` on a CLOSING/CLOSED socket DISCARDS the data silently (per WHATWG it only
 * throws while CONNECTING), so draining the buffer into a dead socket would destroy a
 * whole outage's captures with nothing counted anywhere. Refusing before the drain
 * leaves the gap intact for the next adopt.
 */
export function refuseAdoption<S extends AdoptableSocket>(current: S | null, candidate: S): AdoptionRefusal {
  if (current !== null) {
    if (current !== candidate) closeQuietly(candidate);
    return 'already-adopted';
  }
  if (candidate.readyState === SOCKET_OPEN) return null;
  closeQuietly(candidate); // refused, and not left half-open either
  return 'socket-not-open';
}

function closeQuietly(socket: AdoptableSocket): void {
  try { socket.close(); } catch { /* already closing or closed */ }
}

/** What the flush actually managed to do — `reBuffered` is non-zero only on the
 *  defensive path below, and is what the panel's drop counter re-reads. */
export interface FlushOutcome {
  sent: number;
  reBuffered: number;
}

/**
 * Write the handshake batch to the adopted socket, in order, then hand control back.
 *
 * `onFlushed` runs after the last frame — and after a failure too — because it is where
 * the relay starts its heartbeat, and the heartbeat driver is what tears a dead socket
 * down. The ordering is a contract, not a convenience: a PING that overtook the replayed
 * gap would be control traffic racing captures the broker files against a plugin
 * registration those same frames depend on.
 *
 * The catch is NOT the loss guard — `refuseAdoption` above is, because a socket that is
 * already gone DISCARDS what it is handed rather than throwing, and this loop is
 * synchronous so `readyState` cannot change part-way through it. It covers only a host
 * that throws out of `send` at all, and it exists so such a throw re-queues the captures
 * it could not confirm instead of losing them. Control frames are never re-queued: the
 * next connection mints its own hello, and its own stats report from a tally that is
 * cleared only by the confirmation below.
 *
 * That confirmation is the drop report's only acknowledgement. Nothing on the wire acks
 * it, so "written to a socket that was OPEN and did not throw" is as much delivery as the
 * relay can observe — and it is checked HERE rather than trusted from the adopt-time
 * guard, because this function is also the one place a dead socket could silently swallow
 * the report and make the loss vanish from both the panel's next report and the log.
 */
export function flushHandshake<S extends AdoptableSocket>(params: {
  socket: S;
  batch: HandshakeBatch;
  buffer: PreOpenBuffer;
  onFlushed: () => void;
}): FlushOutcome {
  const { socket, batch, buffer, onFlushed } = params;
  let sent = 0;
  const write = (json: string): boolean => {
    // `send()` on a CLOSING/CLOSED socket discards in silence (per WHATWG it only throws
    // while CONNECTING), so a readyState check is the only way to tell a write that
    // landed from one that evaporated.
    if (socket.readyState !== SOCKET_OPEN) return false;
    try {
      socket.send(json);
      sent += 1;
      return true;
    } catch {
      return false;
    }
  };

  let from = batch.captures.length; // nothing left to re-queue unless a write fails
  if (batch.control.every(write)) {
    // Every control frame landed, so the stats frame among them did too.
    if (batch.reported) buffer.confirmReported(batch.reported);
    from = batch.captures.findIndex((frame) => !write(frame));
    if (from === -1) from = batch.captures.length;
  } else {
    from = 0; // the handshake never landed, so no capture was sent either
  }
  for (let i = from; i < batch.captures.length; i++) buffer.enqueue(batch.captures[i] as string);

  onFlushed();
  return { sent, reBuffered: batch.captures.length - from };
}
