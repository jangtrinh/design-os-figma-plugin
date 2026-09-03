// The adopt→flush wiring, lifted out of ui-relay.ts so it can be executed instead of
// only read. Two failures lived here with no test able to reach them:
//
//  1. the "already adopted" guard — the second greeting of a probe race must be CLOSED,
//     never adopted over a live socket, and it must not drain the buffer on its way out;
//  2. the retention guard — `send()` on a CLOSING/CLOSED socket discards the data
//     SILENTLY (WHATWG: it only throws while CONNECTING), so draining the buffer before
//     knowing the socket is OPEN could destroy a whole outage's captures with nothing
//     counted anywhere. The gap must survive for the next adopt.
//
// Both now run against a fake socket that answers exactly like the browser's does.
import { describe, expect, it } from 'vitest';
import { createPreOpenBuffer, handshakeBatch } from '../plugin/src/ui/outbound-buffer.ts';
import {
  SOCKET_CLOSED, SOCKET_CLOSING, SOCKET_CONNECTING, SOCKET_OPEN,
  flushHandshake, refuseAdoption, type AdoptableSocket,
} from '../plugin/src/ui/socket-adoption.ts';

interface FakeSocket extends AdoptableSocket {
  sent: string[];
  closes: number;
}

function fakeSocket(readyState: number = SOCKET_OPEN, onSend?: (json: string, sock: FakeSocket) => void): FakeSocket {
  const sock: FakeSocket = {
    readyState,
    sent: [],
    closes: 0,
    send(json: string) { sock.sent.push(json); onSend?.(json, sock); },
    close() { sock.closes += 1; },
  };
  return sock;
}

const editFeed = (n: number): string => JSON.stringify({ type: 'EDIT_FEED', data: { seq: n } });
const hello = { fileName: 'F', instanceId: 'i1' };

describe('refuseAdoption — one live socket, and it has to be OPEN', () => {
  it('refuses and closes a second greeting while a socket is already adopted', () => {
    const live = fakeSocket();
    const late = fakeSocket();

    expect(refuseAdoption(live, late)).toBe('already-adopted');
    expect(late.closes, 'the loser is closed, not left dangling').toBe(1);
    expect(late.sent).toEqual([]);
  });

  it('refuses a re-adopt of the SAME socket without closing the connection out from under itself', () => {
    const live = fakeSocket();
    expect(refuseAdoption(live, live)).toBe('already-adopted');
    expect(live.closes).toBe(0);
  });

  it('refuses a socket that died between the greeting and the handshake, and does not leave it half-open', () => {
    for (const state of [SOCKET_CLOSING, SOCKET_CLOSED, SOCKET_CONNECTING]) {
      const dead = fakeSocket(state);
      expect(refuseAdoption(null, dead), String(state)).toBe('socket-not-open');
      expect(dead.closes, String(state)).toBe(1);
    }
  });

  it('admits the winner when nothing is adopted and the socket is open', () => {
    expect(refuseAdoption(null, fakeSocket(SOCKET_OPEN))).toBeNull();
  });
});

describe('a refused adoption never costs the buffer a frame', () => {
  it('a dead winner leaves the whole gap buffered for the next adopt', () => {
    const buffer = createPreOpenBuffer();
    buffer.enqueue(editFeed(1));
    buffer.enqueue(editFeed(2));
    const dead = fakeSocket(SOCKET_CLOSING);

    expect(refuseAdoption(null, dead)).toBe('socket-not-open');
    // The caller must not have built the handshake batch at all — building it drains.
    expect(buffer.size, 'the gap is still held').toBe(2);
    expect(buffer.dropped, 'nothing was lost, so nothing is counted lost').toEqual({ frames: 0, chars: 0 });
    expect(dead.sent).toEqual([]);
  });
});

describe('flushHandshake — the handshake, then the gap, then the heartbeat', () => {
  it('writes every frame in order and starts the heartbeat only after the last one', () => {
    const buffer = createPreOpenBuffer();
    buffer.enqueue(editFeed(1));
    buffer.enqueue(editFeed(2));
    const batch = handshakeBatch(hello, buffer);
    const order: string[] = [];
    const socket = fakeSocket(SOCKET_OPEN, (json) => order.push(JSON.parse(json).type as string));

    const outcome = flushHandshake({
      socket, batch, buffer, onFlushed: () => order.push('HEARTBEAT_START'),
    });

    expect(order).toEqual(['PLUGIN_HELLO', 'EDIT_FEED', 'EDIT_FEED', 'HEARTBEAT_START']);
    expect(outcome).toEqual({ sent: 3, reBuffered: 0 });
    expect(buffer.size).toBe(0);
  });

  it('reports the drop tally as its own event, right behind the handshake', () => {
    const buffer = createPreOpenBuffer({ maxFrames: 1 });
    buffer.enqueue(editFeed(1));
    buffer.enqueue(editFeed(2));
    const socket = fakeSocket();

    flushHandshake({ socket, batch: handshakeBatch(hello, buffer), buffer, onFlushed: () => { /* not under test */ } });

    expect(socket.sent.map((json) => JSON.parse(json).type))
      .toEqual(['PLUGIN_HELLO', 'PLUGIN_RELAY_STATS', 'EDIT_FEED']);
  });

  it('re-queues only the captures when the handshake itself fails — the stats event is control, not cargo', () => {
    const buffer = createPreOpenBuffer({ maxFrames: 1 });
    buffer.enqueue(editFeed(1));
    buffer.enqueue(editFeed(2));
    const batch = handshakeBatch(hello, buffer);
    const socket = fakeSocket(SOCKET_OPEN, () => { throw new Error('socket went away'); });

    const outcome = flushHandshake({ socket, batch, buffer, onFlushed: () => { /* not under test */ } });

    expect(outcome).toEqual({ sent: 0, reBuffered: 1 });
    // The next connection mints its own hello and reports the same (unchanged) tally
    // itself, so re-queueing either control frame would replay it as if it were an edit.
    expect(buffer.drain()).toEqual([editFeed(2)]);
  });

  it('re-buffers the unsent captures when a host throws mid-flush, and never re-queues the handshake', () => {
    const buffer = createPreOpenBuffer();
    buffer.enqueue(editFeed(1));
    buffer.enqueue(editFeed(2));
    buffer.enqueue(editFeed(3));
    const batch = handshakeBatch(hello, buffer);
    const socket = fakeSocket(SOCKET_OPEN, (json) => {
      if (json === editFeed(2)) throw new Error('socket went away');
    });

    const outcome = flushHandshake({ socket, batch, buffer, onFlushed: () => { /* not under test */ } });

    expect(outcome).toEqual({ sent: 2, reBuffered: 2 });
    // The frame that threw was never confirmed sent, so it is re-queued WITH the tail;
    // the hello is not, because the next connection mints its own.
    expect(buffer.drain()).toEqual([editFeed(2), editFeed(3)]);
  });

  it('starts the heartbeat even after a mid-flush failure — the driver is what tears a dead socket down', () => {
    const buffer = createPreOpenBuffer();
    buffer.enqueue(editFeed(1));
    let started = false;
    const socket = fakeSocket(SOCKET_OPEN, () => { throw new Error('socket went away'); });

    flushHandshake({
      socket, batch: handshakeBatch(hello, buffer), buffer, onFlushed: () => { started = true; },
    });

    expect(started).toBe(true);
  });
});
