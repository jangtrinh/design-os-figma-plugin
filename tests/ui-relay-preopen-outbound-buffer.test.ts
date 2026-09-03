// `wsSend` used to `return` silently whenever the socket was not OPEN: the boot
// gap-fill EDIT_FEED that main posts right after its diff, and every live edit
// captured during a reconnect gap, vanished with no counter — the one thing this
// repo's house rules forbid. These tests pin the replacement: captured frames wait in
// a bounded buffer, flush in arrival order once the socket is adopted, and an
// overflow drops the OLDEST frame while counting exactly what it dropped. Replies
// stay unbuffered on purpose (a reply to a dead socket is meaningless). Nothing here
// existed before this change, so the import fails against pre-fix code.
import { describe, expect, it } from 'vitest';
import {
  PRE_OPEN_MAX_CHARS, PRE_OPEN_MAX_FRAMES, createPreOpenBuffer, handshakeBatch, isBufferableFrame,
} from '../plugin/src/ui/outbound-buffer.ts';

const editFeed = (n: number): string => JSON.stringify({ type: 'EDIT_FEED', data: { seq: n } });

describe('createPreOpenBuffer — order in, order out', () => {
  it('drains the frames it took, in arrival order, and empties itself', () => {
    const buffer = createPreOpenBuffer();
    buffer.enqueue(editFeed(1));
    buffer.enqueue(JSON.stringify({ type: 'DOC_CHANGE', data: {} }));
    buffer.enqueue(editFeed(2));

    expect(buffer.size).toBe(3);
    expect(buffer.drain()).toEqual([
      editFeed(1),
      JSON.stringify({ type: 'DOC_CHANGE', data: {} }),
      editFeed(2),
    ]);
    expect(buffer.size).toBe(0);
    expect(buffer.drain()).toEqual([]);
    expect(buffer.dropped).toEqual({ frames: 0, chars: 0 });
  });

  it('a drained buffer keeps its drop tally — the count is a session total, not a queue length', () => {
    const buffer = createPreOpenBuffer({ maxFrames: 2 });
    buffer.enqueue(editFeed(1));
    buffer.enqueue(editFeed(2));
    buffer.enqueue(editFeed(3));
    buffer.drain();

    expect(buffer.dropped).toEqual({ frames: 1, chars: editFeed(1).length });
  });
});

describe('createPreOpenBuffer — the cap drops the OLDEST and counts it', () => {
  it('holds the newest frames when the frame cap is exceeded', () => {
    const buffer = createPreOpenBuffer({ maxFrames: 3 });
    for (let n = 1; n <= 5; n++) buffer.enqueue(editFeed(n));

    expect(buffer.drain()).toEqual([editFeed(3), editFeed(4), editFeed(5)]);
    expect(buffer.dropped).toEqual({ frames: 2, chars: editFeed(1).length + editFeed(2).length });
  });

  it('holds the newest frames when the size cap is exceeded', () => {
    const big = JSON.stringify({ type: 'EDIT_FEED', data: { blob: 'x'.repeat(400) } });
    const buffer = createPreOpenBuffer({ maxChars: big.length * 2 });
    buffer.enqueue(big);
    buffer.enqueue(big);
    buffer.enqueue(big);

    expect(buffer.size).toBe(2);
    expect(buffer.chars).toBe(big.length * 2);
    expect(buffer.dropped).toEqual({ frames: 1, chars: big.length });
  });

  it('a single frame larger than the whole cap is dropped and counted, never silently kept', () => {
    const buffer = createPreOpenBuffer({ maxChars: 100 });
    const huge = JSON.stringify({ type: 'EDIT_FEED', data: { blob: 'x'.repeat(500) } });
    buffer.enqueue(huge);

    expect(buffer.size).toBe(0);
    expect(buffer.dropped).toEqual({ frames: 1, chars: huge.length });
  });

  it('ships the documented production caps', () => {
    expect(PRE_OPEN_MAX_FRAMES).toBe(200);
    expect(PRE_OPEN_MAX_CHARS).toBe(1_000_000);
    const buffer = createPreOpenBuffer();
    for (let n = 0; n <= PRE_OPEN_MAX_FRAMES; n++) buffer.enqueue(editFeed(n));
    expect(buffer.size).toBe(PRE_OPEN_MAX_FRAMES);
    expect(buffer.dropped.frames).toBe(1);
  });

  it('hands back a copy of the tally — a reader cannot rewrite the counter', () => {
    const buffer = createPreOpenBuffer({ maxFrames: 1 });
    buffer.enqueue(editFeed(1));
    buffer.enqueue(editFeed(2));
    const snapshot = buffer.dropped;
    snapshot.frames = 0;

    expect(buffer.dropped.frames).toBe(1);
  });
});

describe('isBufferableFrame — captured edits wait, replies and control traffic do not', () => {
  it('buffers the main→broker capture events', () => {
    expect(isBufferableFrame({ type: 'EDIT_FEED', data: {} })).toBe(true);
    expect(isBufferableFrame({ type: 'DOC_CHANGE', data: {} })).toBe(true);
  });

  it('never buffers FILE_INFO — current state, re-announced on every selection change', () => {
    // Queueing it would let a user clicking around while the broker is down push real
    // captures out of a bounded buffer; the newest identity rides the handshake anyway.
    expect(isBufferableFrame({ type: 'FILE_INFO', data: { fileName: 'F' } })).toBe(false);
  });

  it('never buffers a reply — an answer to a request nobody can still be waiting on', () => {
    expect(isBufferableFrame({ id: 'req_1', ok: true, result: {} })).toBe(false);
    expect(isBufferableFrame({ id: 'req_1', ok: false, error: { code: 'E_PLUGIN_ERROR', message: 'x' } })).toBe(false);
    expect(isBufferableFrame({ id: 'req_1', seq: 0, last: true, chunk: '{' })).toBe(false);
  });

  it('never buffers handshake, heartbeat or click-intent traffic', () => {
    for (const type of ['PLUGIN_HELLO', 'PING', 'APP_PROBE_ACK', 'SYNC_REQUEST', 'SET_TARGET', 'CLEAR_TARGET']) {
      expect(isBufferableFrame({ type, data: {} }), type).toBe(false);
    }
    expect(isBufferableFrame(null)).toBe(false);
    expect(isBufferableFrame({ data: {} })).toBe(false);
  });
});

describe('handshakeBatch — the handshake goes first, then the gap in order', () => {
  const hello = { fileName: 'F', instanceId: 'i1', caps: ['fileGuard'], pluginVersion: '0.1.0', protocolV: 1 };

  it('writes PLUGIN_HELLO, then every held frame in arrival order, and empties the buffer', () => {
    const buffer = createPreOpenBuffer();
    buffer.enqueue(editFeed(1));
    buffer.enqueue(editFeed(2));

    const batch = handshakeBatch(hello, buffer);

    expect(batch).toEqual({
      control: [JSON.stringify({ type: 'PLUGIN_HELLO', data: hello })],
      captures: [editFeed(1), editFeed(2)],
      reported: null,
    });
    expect(buffer.size, 'the buffer is handed over, not copied').toBe(0);
  });

  it('a handshake with nothing to report is exactly the hello frame, and nothing else', () => {
    const batch = handshakeBatch(hello, createPreOpenBuffer());
    expect(batch).toEqual({
      control: [JSON.stringify({ type: 'PLUGIN_HELLO', data: hello })], captures: [], reported: null,
    });
    expect(batch.control[0]).not.toContain('dropped');
  });

  // The tally travels as its OWN event rather than as a PLUGIN_HELLO field: the hello
  // payload is scene identity to every broker that reads it, and a broker predating this
  // change would have kept a growing tally IN the scene — making each handshake look
  // like a scene change and silently resetting the flapper streak the zombie watchdog
  // counts on. That older broker re-broadcasts the unknown event to its CLI clients,
  // which ignore event types they do not know.
  it('reports the delta as PLUGIN_RELAY_STATS, right behind an unchanged handshake', () => {
    const buffer = createPreOpenBuffer({ maxFrames: 1 });
    buffer.enqueue(editFeed(1));
    buffer.enqueue(editFeed(2));

    const { control, captures, reported } = handshakeBatch(hello, buffer);

    expect(JSON.parse(control[0] as string), 'the hello shape never changes').toEqual({
      type: 'PLUGIN_HELLO', data: hello,
    });
    expect(JSON.parse(control[1] as string)).toEqual({
      type: 'PLUGIN_RELAY_STATS',
      data: {
        dropped: { frames: 1, chars: editFeed(1).length },
        sessionTotal: { frames: 1, chars: editFeed(1).length },
      },
    });
    expect(reported, 'what the flush must clear once this frame is actually written')
      .toEqual({ frames: 1, chars: editFeed(1).length });
    expect(captures, 'what survived the cap still ships').toEqual([editFeed(2)]);
  });

  it('sends no stats event at all when nothing was ever dropped', () => {
    const buffer = createPreOpenBuffer();
    buffer.enqueue(editFeed(1));

    expect(handshakeBatch(hello, buffer).control.some((f) => f.includes('PLUGIN_RELAY_STATS'))).toBe(false);
  });

  // The reconnect the accounting exists for: nothing acknowledges the report, so the
  // relay only forgets a drop once a write of it succeeded (see socket-adoption.ts).
  it('re-reports the same delta until it is confirmed, then only what is new', () => {
    const buffer = createPreOpenBuffer({ maxFrames: 1 });
    buffer.enqueue(editFeed(1));
    buffer.enqueue(editFeed(2)); // 1 dropped

    const first = handshakeBatch(hello, buffer);
    expect(first.reported).toEqual({ frames: 1, chars: editFeed(1).length });

    // The write never landed, so a second handshake owes the same delta again.
    const second = handshakeBatch(hello, buffer);
    expect(second.reported).toEqual({ frames: 1, chars: editFeed(1).length });

    buffer.confirmReported(second.reported as { frames: number; chars: number });
    expect(handshakeBatch(hello, buffer).reported, 'a confirmed delta is never reported twice').toBeNull();

    buffer.enqueue(editFeed(3));
    buffer.enqueue(editFeed(4)); // one more drop, after the confirmation
    const third = handshakeBatch(hello, buffer);
    expect(third.reported, 'only the new loss').toEqual({ frames: 1, chars: editFeed(3).length });
    expect(JSON.parse(third.control[1] as string).data.sessionTotal, 'the session total keeps counting')
      .toEqual({ frames: 2, chars: editFeed(1).length + editFeed(3).length });
  });
});
