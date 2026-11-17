// Signal cancellation for exec-js: when the process receives SIGINT or SIGTERM while
// a job is queued, the CLI sends a JOB cancel frame over the open socket, waits up to
// the bounded cancel timeout, and rejects with E_CANCELLED. If interrupted while running,
// no cancel is sent (running mutations cannot be rolled back mid-flight). Process signal
// listeners are always cleaned up after completion or error.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../cli/src/transport/broker-discovery.ts', () => ({
  ensureBroker: vi.fn(async () => { throw new Error('refusing to reach a real broker from a test'); }),
  isPidAlive: vi.fn(() => false),
  loopbackWsUrl: vi.fn((port: number) => `ws://127.0.0.1:${port}`),
}));

vi.mock('../cli/src/transport/broker-client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../cli/src/transport/broker-client.ts')>()),
  runCommand: vi.fn(),
}));

import { parseArgs } from '../cli/src/arg-parse.ts';
import { run } from '../cli/src/commands/exec-js.ts';
import { exchange, runCommand } from '../cli/src/transport/broker-client.ts';
import { CliError } from '../cli/src/transport/protocol-helpers.ts';
import type { JobInfo } from '../shared/protocol.ts';

type FakeWs = EventEmitter & { send: (text: string) => void; sent: string[] };

function fakeWs(): FakeWs {
  const emitter = new EventEmitter() as FakeWs;
  emitter.sent = [];
  emitter.send = (text: string) => { emitter.sent.push(text); };
  return emitter;
}

const RUN_MS = 5_000;
const QUEUE_MS = 20_000;
const JOB = 'j_sig_1';

type Announced = Partial<JobInfo> & { announcesRunning?: boolean; blockedBy?: string };

function emitJobState(ws: FakeWs, state: JobInfo['state'], extra: Announced = { announcesRunning: true }): void {
  const data = { jobId: JOB, state, cmd: 'EXEC_JS', fileSlug: 'fileSig', ...extra };
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'JOB_STATE', data })));
}

function emitReply(ws: FakeWs, id: string, body: Record<string, unknown>): void {
  ws.emit('message', Buffer.from(JSON.stringify({ id, ...body })));
}

function frame(ws: FakeWs, index: number): { id: string; cmd: string; params: Record<string, unknown> } {
  return JSON.parse(ws.sent[index]!) as { id: string; cmd: string; params: Record<string, unknown> };
}

function failure(promise: Promise<unknown>): Promise<CliError> {
  return promise.then(
    () => { throw new Error('expected promise to reject'); },
    (e: unknown) => {
      expect(e).toBeInstanceOf(CliError);
      return e as CliError;
    },
  );
}

describe('exec-js signal cancellation — exchange', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('cancels queued job on SIGINT: sends JOB cancel, waits for reply, rejects with E_CANCELLED', async () => {
    const ws = fakeWs();
    const ac = new AbortController();
    const promise = exchange(
      ws as never,
      'EXEC_JS',
      {},
      RUN_MS,
      'Run script',
      undefined,
      { queueTimeoutMs: QUEUE_MS, signal: ac.signal },
    );

    emitJobState(ws, 'queued');
    expect(ws.sent).toHaveLength(1);

    ac.abort('SIGINT');
    expect(ws.sent).toHaveLength(2);
    const cancel = frame(ws, 1);
    expect(cancel.cmd).toBe('JOB');
    expect(cancel.params).toEqual({ mode: 'cancel', jobId: JOB });

    emitReply(ws, cancel.id, { ok: true, result: { ok: true } });
    const err = await failure(promise);
    expect(err.code).toBe('E_CANCELLED');
    expect(err.jobId).toBe(JOB);
    expect(err.message).toContain('cancelled while queued');
    expect(err.message).toContain('interrupted by SIGINT');
    expect(err.message).toContain('never ran');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels queued job on SIGTERM: sends JOB cancel and reports SIGTERM', async () => {
    const ws = fakeWs();
    const ac = new AbortController();
    const promise = exchange(
      ws as never,
      'EXEC_JS',
      {},
      RUN_MS,
      'Run script',
      undefined,
      { queueTimeoutMs: QUEUE_MS, signal: ac.signal },
    );

    emitJobState(ws, 'queued');
    ac.abort('SIGTERM');
    expect(ws.sent).toHaveLength(2);
    const cancel = frame(ws, 1);
    emitReply(ws, cancel.id, { ok: true, result: { ok: true } });

    const err = await failure(promise);
    expect(err.code).toBe('E_CANCELLED');
    expect(err.jobId).toBe(JOB);
    expect(err.message).toContain('interrupted by SIGTERM');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounded wait if broker never answers the cancel frame', async () => {
    const ws = fakeWs();
    const ac = new AbortController();
    const promise = exchange(
      ws as never,
      'EXEC_JS',
      {},
      RUN_MS,
      'Run script',
      undefined,
      { queueTimeoutMs: QUEUE_MS, signal: ac.signal, signalCancelTimeoutMs: 2_000 },
    );

    emitJobState(ws, 'queued');
    ac.abort('SIGINT');
    expect(ws.sent).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(1);

    const failPromise = failure(promise);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    const err = await failPromise;
    expect(err.code).toBe('E_CANCELLED');
    expect(err.jobId).toBe(JOB);
    expect(err.message).toContain('interrupted by SIGINT');
    expect(err.message).toContain('cancel failed (no reply within 2000ms)');
    expect(err.message).toContain('job state unknown');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('SIGINT while running does NOT send cancel and reports job was NOT cancelled', async () => {
    const ws = fakeWs();
    const ac = new AbortController();
    const promise = exchange(
      ws as never,
      'EXEC_JS',
      {},
      RUN_MS,
      'Run script',
      undefined,
      { queueTimeoutMs: QUEUE_MS, signal: ac.signal },
    );

    emitJobState(ws, 'queued');
    emitJobState(ws, 'running');
    expect(ws.sent).toHaveLength(1);

    ac.abort('SIGINT');
    expect(ws.sent).toHaveLength(1); // No cancel frame sent

    const err = await failure(promise);
    expect(err.code).toBe('E_CANCELLED');
    expect(err.jobId).toBe(JOB);
    expect(err.message).toContain(`interrupted by SIGINT while running — job ${JOB} was NOT cancelled`);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('SIGINT before any JOB_STATE in legacy phase cancels immediately', async () => {
    const ws = fakeWs();
    const ac = new AbortController();
    const promise = exchange(
      ws as never,
      'EXEC_JS',
      {},
      RUN_MS,
      'Run script',
      undefined,
      { queueTimeoutMs: QUEUE_MS, signal: ac.signal },
    );

    ac.abort('SIGINT');
    expect(ws.sent).toHaveLength(1); // No cancel frame sent because no queued jobId

    const err = await failure(promise);
    expect(err.code).toBe('E_CANCELLED');
    expect(err.jobId).toBeUndefined();
    expect(err.message).toBe('EXEC_JS cancelled by SIGINT');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('exec-js command — signal listener cleanup', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'figma-agent-exec-signal-'));
  const path = join(scratch, 'script.js');
  writeFileSync(path, 'return 1', 'utf8');

  beforeEach(() => {
    vi.mocked(runCommand).mockReset();
  });

  it('cleans up process listeners after successful run', async () => {
    vi.mocked(runCommand).mockResolvedValue({ ok: true });
    const sigintBefore = process.listenerCount('SIGINT');
    const sigtermBefore = process.listenerCount('SIGTERM');

    await run(parseArgs([path]));

    expect(process.listenerCount('SIGINT')).toBe(sigintBefore);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore);
  });

  it('cleans up process listeners after run failure', async () => {
    vi.mocked(runCommand).mockRejectedValue(new CliError('E_PLUGIN_ERROR', 'script failed'));
    const sigintBefore = process.listenerCount('SIGINT');
    const sigtermBefore = process.listenerCount('SIGTERM');

    await expect(run(parseArgs([path]))).rejects.toMatchObject({ code: 'E_PLUGIN_ERROR' });

    expect(process.listenerCount('SIGINT')).toBe(sigintBefore);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore);
  });
});
