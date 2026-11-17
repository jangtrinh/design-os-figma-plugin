import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { makeRequestFrame, type EventMsg, type ReplyErr, type WireMsg } from '../shared/protocol.ts';
import { connect, logPath, nextFrame, registerPlugin, snapshot, startBroker, waitFor } from './broker-request-chunk-fixture';

describe('broker request chunk admission', () => {
  it('correlates malformed metadata and payload refusals before retention', async () => {
    const port = await startBroker();
    const cli = await connect(port);
    const invalid = [
      { id: 'negative', seq: -1, last: false, chunk: 'DO_NOT_LOG' },
      { id: 'missing-seq', last: false, chunk: 'DO_NOT_LOG' },
      { id: 'fractional', seq: 0.5, last: false, chunk: 'DO_NOT_LOG' },
      { id: 'unsafe', seq: Number.MAX_SAFE_INTEGER + 1, last: false, chunk: 'DO_NOT_LOG' },
      { id: 'bad-last', seq: 0, last: 'false', chunk: 'DO_NOT_LOG' },
      { id: 'bad-payload', seq: 0, last: false, chunk: 42 },
    ];

    for (const candidate of invalid) {
      const refusal = nextFrame<ReplyErr>(cli, (frame) => 'id' in frame && frame.id === candidate.id && 'ok' in frame);
      cli.send(JSON.stringify(candidate));
      expect((await refusal).error.code).toBe('E_INVALID_ARGS');
      expect(snapshot().pendingChunks.incompleteIdCount).toBe(0);
    }
    const log = readFileSync(logPath, 'utf8');
    expect(log).not.toContain('DO_NOT_LOG');
    expect(log).toMatch(/request chunk refused: code=E_INVALID_ARGS .*retainedFrames=0 retainedUtf8Bytes=0 rejectedFrames=1 rejectedUtf8Bytes=\d+/);
  });

  it('releases an out-of-order id, then accepts a fresh Unicode assembly with an empty fragment', async () => {
    const port = await startBroker();
    const plugin = await registerPlugin(port);
    const cli = await connect(port);
    const id = 'arbitrary / 🧪 id';
    const request = JSON.stringify(makeRequestFrame(id, 'GET_SELECTION', { text: '你好🧪' }));
    cli.send(JSON.stringify({ id, seq: 0, last: false, chunk: request.slice(0, 10) }));
    const other = await connect(port);
    const healthy = {
      ...makeRequestFrame('healthy-request-shape', 'GET_SELECTION', { text: 'still routed as a request' }),
      seq: 99,
      last: 'request metadata',
      chunk: 'request metadata',
    };
    other.send(JSON.stringify(healthy));
    await waitFor(() => plugin.frames.some((frame) => 'id' in frame && frame.id === healthy.id));
    expect(snapshot().pendingChunks.incompleteIdCount).toBe(1);
    const refusal = nextFrame<ReplyErr>(cli, (frame) => 'id' in frame && frame.id === id && 'ok' in frame);
    cli.send(JSON.stringify({ id, seq: 0, last: true, chunk: request.slice(10) }));
    expect((await refusal).error.code).toBe('E_CHUNK_LOST');
    expect(snapshot().pendingChunks.incompleteIdCount).toBe(0);
    cli.send(JSON.stringify({ id, seq: 0, last: false, chunk: '' }));
    cli.send(JSON.stringify({ id, seq: 1, last: true, chunk: request }));
    await waitFor(() => plugin.frames.some((frame) => 'id' in frame && frame.id === id));
    expect(plugin.frames.find((frame) => 'id' in frame && frame.id === id)).toMatchObject({ params: { text: '你好🧪' } });
  });

  it('runs the existing owner guard before malformed-frame refusal', async () => {
    const port = await startBroker();
    const plugin = await registerPlugin(port);
    const owner = await connect(port);
    const other = await connect(port);
    const id = 'owned-before-validation';
    const state = nextFrame<EventMsg>(owner, (frame) => (frame as EventMsg).type === 'JOB_STATE');
    owner.send(JSON.stringify(makeRequestFrame(id, 'GET_SELECTION', {})));
    await state;
    await waitFor(() => plugin.frames.some((frame) => 'id' in frame && frame.id === id));
    const ownerFrames: WireMsg[] = [];
    owner.on('message', (raw) => ownerFrames.push(JSON.parse(raw.toString()) as WireMsg));
    owner.send(JSON.stringify({ id, seq: 'bad', last: 'bad', chunk: 42 }));
    const duplicate = nextFrame<ReplyErr>(other, (frame) => 'id' in frame && frame.id === id && 'ok' in frame);
    other.send(JSON.stringify({ id, seq: 'bad', last: 'bad', chunk: 42 }));
    expect((await duplicate).error).toMatchObject({ code: 'E_INVALID_ARGS', message: expect.stringContaining('duplicate request id') });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(ownerFrames.some((frame) => 'id' in frame && frame.id === id && 'ok' in frame)).toBe(false);
    expect(plugin.frames.filter((frame) => 'id' in frame && frame.id === id)).toHaveLength(1);
  });

  it('releases partial chunks immediately on close and audits exact retained usage', async () => {
    const port = await startBroker();
    const cli = await connect(port);
    const raw = JSON.stringify({ id: 'close-partial', seq: 0, last: false, chunk: '你好🧪' });
    cli.send(raw);
    await waitFor(() => snapshot().pendingChunks.incompleteIdCount === 1);
    const closed = new Promise<void>((resolve) => cli.once('close', () => resolve()));
    cli.terminate();
    await closed;
    await waitFor(() => snapshot().pendingChunks.incompleteIdCount === 0);
    expect(readFileSync(logPath, 'utf8')).toContain(
      `request chunk close cleanup: requests=1 frames=1 utf8Bytes=${Buffer.byteLength(raw, 'utf8')}`,
    );
  });

  it('keeps gap-sweep cleanup wire-silent and audits exact retained usage', async () => {
    const port = await startBroker();
    const cli = await connect(port);
    const raw = JSON.stringify({ id: 'sweep-partial', seq: 0, last: false, chunk: 'café🧪' });
    const received: WireMsg[] = [];
    cli.on('message', (frame) => received.push(JSON.parse(frame.toString()) as WireMsg));
    cli.send(raw);
    await waitFor(() => snapshot().pendingChunks.incompleteIdCount === 1);
    await waitFor(() => snapshot().pendingChunks.incompleteIdCount === 0);
    expect(received.some((frame) => 'id' in frame && frame.id === 'sweep-partial')).toBe(false);
    expect(readFileSync(logPath, 'utf8')).toContain(
      `request chunk sweep cleanup: requests=1 frames=1 utf8Bytes=${Buffer.byteLength(raw, 'utf8')}`,
    );
  });

  it('releases request chunks on close after the socket registers as a plugin', async () => {
    const port = await startBroker();
    const cli = await connect(port);
    await connect(port);
    const raw = JSON.stringify({ id: 'promoted-partial', seq: 0, last: false, chunk: 'held' });
    cli.send(raw);
    await waitFor(() => snapshot().pendingChunks.incompleteIdCount === 1);
    await registerPlugin(port, cli);
    const closed = new Promise<void>((resolve) => cli.once('close', () => resolve()));
    cli.terminate();
    await closed;
    await waitFor(() => readFileSync(logPath, 'utf8').includes('plugin [strict-chunk-plugin] disconnected'));
    expect(snapshot().pendingChunks.incompleteIdCount).toBe(0);
    expect(readFileSync(logPath, 'utf8')).toContain(
      `request chunk close cleanup: requests=1 frames=1 utf8Bytes=${Buffer.byteLength(raw, 'utf8')}`,
    );
  });

  it('does not settle an admitted request when stale partial chunks reuse its id', async () => {
    const port = await startBroker();
    const plugin = await registerPlugin(port);
    const cli = await connect(port);
    const id = 'partial-then-admitted';
    const received: WireMsg[] = [];
    cli.on('message', (raw) => received.push(JSON.parse(raw.toString()) as WireMsg));
    cli.send(JSON.stringify({ id, seq: 0, last: false, chunk: '{' }));
    await waitFor(() => snapshot().pendingChunks.incompleteIdCount === 1);
    cli.send(JSON.stringify(makeRequestFrame(id, 'GET_SELECTION', {})));
    await waitFor(() => plugin.frames.some((frame) => 'id' in frame && frame.id === id));
    await waitFor(() => snapshot().pendingChunks.incompleteIdCount === 0);
    expect(received.filter((frame) => 'id' in frame && frame.id === id && 'ok' in frame)).toEqual([]);
    const reply = nextFrame(cli, (frame) => 'id' in frame && frame.id === id && 'ok' in frame);
    plugin.ws.send(JSON.stringify({ id, ok: true, result: { preserved: true } }));
    expect(await reply).toMatchObject({ id, ok: true, result: { preserved: true } });
    expect(plugin.frames.filter((frame) => 'id' in frame && frame.id === id)).toHaveLength(1);
  });
});
