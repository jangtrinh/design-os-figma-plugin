// `exec-js` run budget starts when the broker dispatches the script, not when the CLI sends
// it. A broker that announces dispatch (`JOB_STATE` with `announcesRunning: true`) splits
// the wait in two: a queue limit while the job waits behind others on the same file, and
// the run budget from the `running` event. A job still queued at the queue limit is
// cancelled before it can reach the plugin. A broker that never announces keeps the single
// clock from send. `exchange()` runs against a fake socket with fake timers; the
// `exec-js` command runs with `runCommand` stubbed.
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
// `exchange` stays real (it only touches the socket it is handed); `runCommand`, the one
// path that connects to a broker, is a stub.
vi.mock('../cli/src/transport/broker-client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../cli/src/transport/broker-client.ts')>()),
  runCommand: vi.fn(),
}));

import { parseArgs } from '../cli/src/arg-parse.ts';
import { run } from '../cli/src/commands/exec-js.ts';
import { exchange, runCommand } from '../cli/src/transport/broker-client.ts';
import { CliError } from '../cli/src/transport/protocol-helpers.ts';
import { DEFAULT_TIMEOUT_MS, type JobInfo } from '../shared/protocol.ts';

type FakeWs = EventEmitter & { send: (text: string) => void; sent: string[] };

function fakeWs(): FakeWs {
  const emitter = new EventEmitter() as FakeWs;
  emitter.sent = [];
  emitter.send = (text: string) => { emitter.sent.push(text); };
  return emitter;
}

const RUN_MS = 5_000;
const QUEUE_MS = 20_000;
const JOB = 'j_9_1';

type Announced = Partial<JobInfo> & { announcesRunning?: boolean; blockedBy?: string };

function emitJobState(ws: FakeWs, state: JobInfo['state'], extra: Announced = { announcesRunning: true }): void {
  const data = { jobId: JOB, state, cmd: 'EXEC_JS', fileSlug: 'fileA', ...extra };
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'JOB_STATE', data })));
}

function emitReply(ws: FakeWs, id: string, body: Record<string, unknown>): void {
  ws.emit('message', Buffer.from(JSON.stringify({ id, ...body })));
}

function frame(ws: FakeWs, index: number): { id: string; cmd: string; params: Record<string, unknown> } {
  return JSON.parse(ws.sent[index]!) as { id: string; cmd: string; params: Record<string, unknown> };
}

/** Starts an opted-in exchange and reports whether it has settled yet. */
function start(ws: FakeWs): { promise: Promise<unknown>; settled: () => boolean } {
  let done = false;
  const promise = exchange(ws as never, 'EXEC_JS', {}, RUN_MS, 'Run script', undefined, { queueTimeoutMs: QUEUE_MS });
  promise.then(() => { done = true; }, () => { done = true; });
  return { promise, settled: () => done };
}

async function failure(promise: Promise<unknown>): Promise<CliError> {
  const err = await promise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(CliError);
  return err as CliError;
}

describe('exec-js dispatch budget — exchange clocks', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('keeps the single clock from send when no JOB_STATE arrives', async () => {
    const ws = fakeWs();
    const { promise } = start(ws);
    await vi.advanceTimersByTimeAsync(RUN_MS);
    const err = await failure(promise);
    expect(err.code).toBe('E_TIMEOUT');
    expect(err.message).toBe('EXEC_JS timed out after 5000ms');
    expect(ws.sent).toHaveLength(1);
  });

  it('keeps the single clock when the broker does not announce running', async () => {
    const ws = fakeWs();
    const { promise } = start(ws);
    emitJobState(ws, 'queued', {});
    await vi.advanceTimersByTimeAsync(RUN_MS);
    const err = await failure(promise);
    expect(err.code).toBe('E_TIMEOUT');
    expect(err.jobId).toBe(JOB);
    expect(err.message).toBe(
      `EXEC_JS still running after 5000ms — job ${JOB} was NOT cancelled. Get the result with: figma-agent job ${JOB} --wait`,
    );
    expect(ws.sent).toHaveLength(1);
  });

  it('does not spend the run budget while queued: queued past the run budget, then running, then the reply resolves', async () => {
    const ws = fakeWs();
    const { promise, settled } = start(ws);
    emitJobState(ws, 'queued');
    await vi.advanceTimersByTimeAsync(RUN_MS + 3_000);
    expect(settled()).toBe(false);
    emitJobState(ws, 'running');
    await vi.advanceTimersByTimeAsync(RUN_MS - 1);
    emitReply(ws, frame(ws, 0).id, { ok: true, result: { value: 42 } });
    await expect(promise).resolves.toEqual({ value: 42 });
    expect(ws.sent).toHaveLength(1);
  });

  it('arms the queue limit once, on the first announced queued event', async () => {
    const ws = fakeWs();
    const { settled } = start(ws);
    emitJobState(ws, 'queued');
    await vi.advanceTimersByTimeAsync(4_000);
    emitJobState(ws, 'queued', { announcesRunning: true, queuePosition: 1 });
    await vi.advanceTimersByTimeAsync(QUEUE_MS - 4_000 - 1);
    expect(ws.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(ws.sent).toHaveLength(2);
    expect(settled()).toBe(false);
  });

  it('cancels a job still queued at the queue limit: one JOB cancel frame, then "never ran" with the jobId', async () => {
    const ws = fakeWs();
    const { promise, settled } = start(ws);
    emitJobState(ws, 'queued');
    await vi.advanceTimersByTimeAsync(QUEUE_MS);
    expect(ws.sent).toHaveLength(2);
    const cancel = frame(ws, 1);
    expect(cancel.cmd).toBe('JOB');
    expect(cancel.params).toEqual({ mode: 'cancel', jobId: JOB });
    expect(cancel.id).not.toBe(frame(ws, 0).id);
    expect(settled()).toBe(false);
    emitReply(ws, cancel.id, { ok: true, result: { ok: true } });
    const err = await failure(promise);
    expect(err.code).toBe('E_TIMEOUT');
    expect(err.jobId).toBe(JOB);
    expect(err.message).toContain('never ran');
    expect(err.message).toContain(JOB);
    expect(ws.sent).toHaveLength(2);
  });

  it('running before a refused cancel keeps the run timer and the reply inside the budget resolves', async () => {
    const ws = fakeWs();
    const { promise } = start(ws);
    emitJobState(ws, 'queued');
    await vi.advanceTimersByTimeAsync(QUEUE_MS);
    const cancel = frame(ws, 1);
    emitJobState(ws, 'running');
    await vi.advanceTimersByTimeAsync(1_000);
    emitReply(ws, cancel.id, { ok: true, result: { ok: false, reason: "job 'j_9_1' is running and cannot be cancelled" } });
    await vi.advanceTimersByTimeAsync(RUN_MS - 1_000 - 1);
    emitReply(ws, frame(ws, 0).id, { ok: true, result: { done: true } });
    await expect(promise).resolves.toEqual({ done: true });
  });

  it('never restarts the run timer on a refused cancel that follows running', async () => {
    const ws = fakeWs();
    const { promise, settled } = start(ws);
    emitJobState(ws, 'queued');
    await vi.advanceTimersByTimeAsync(QUEUE_MS);
    emitJobState(ws, 'running');
    await vi.advanceTimersByTimeAsync(2_000);
    emitReply(ws, frame(ws, 1).id, { ok: true, result: { ok: false, reason: 'running' } });
    await vi.advanceTimersByTimeAsync(RUN_MS - 2_000 - 1);
    expect(settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const err = await failure(promise);
    expect(err.code).toBe('E_TIMEOUT');
    expect(err.message).toContain('was NOT cancelled');
  });

  it('a refused cancel with no running seen rejects at once: cancel refused, job state unknown, with the jobId', async () => {
    const ws = fakeWs();
    const { promise } = start(ws);
    emitJobState(ws, 'queued');
    await vi.advanceTimersByTimeAsync(QUEUE_MS);
    emitReply(ws, frame(ws, 1).id, { ok: true, result: { ok: false, reason: `no such job '${JOB}'` } });
    const err = await failure(promise);
    expect(err.code).toBe('E_TIMEOUT');
    expect(err.jobId).toBe(JOB);
    expect(err.message).toContain('cancel refused');
    expect(err.message).toContain('job state unknown');
    expect(err.message).toContain(`figma-agent job ${JOB}`);
  });

  it('a failed cancel envelope rejects with cancel failed, job state unknown, with the jobId', async () => {
    const ws = fakeWs();
    const { promise } = start(ws);
    emitJobState(ws, 'queued');
    await vi.advanceTimersByTimeAsync(QUEUE_MS);
    emitReply(ws, frame(ws, 1).id, { ok: false, error: { code: 'E_JOB_UNKNOWN', message: 'unknown job' } });
    const err = await failure(promise);
    expect(err.code).toBe('E_TIMEOUT');
    expect(err.jobId).toBe(JOB);
    expect(err.message).toContain('cancel failed');
    expect(err.message).toContain('job state unknown');
  });

  it('PLUGIN_GONE while queued sends the cancel before rejecting', async () => {
    const ws = fakeWs();
    const { promise, settled } = start(ws);
    emitJobState(ws, 'queued');
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'PLUGIN_GONE', data: {} })));
    await vi.advanceTimersByTimeAsync(0);
    expect(ws.sent).toHaveLength(2);
    expect(frame(ws, 1).params).toEqual({ mode: 'cancel', jobId: JOB });
    expect(settled()).toBe(false);
    emitReply(ws, frame(ws, 1).id, { ok: true, result: { ok: true } });
    const err = await failure(promise);
    expect(err.code).toBe('E_NO_PLUGIN');
    expect(err.jobId).toBe(JOB);
    expect(err.message).toContain('never ran');
  });

  it('the original reply settles the call while the cancel is still pending', async () => {
    const ws = fakeWs();
    const { promise } = start(ws);
    emitJobState(ws, 'queued');
    await vi.advanceTimersByTimeAsync(QUEUE_MS);
    expect(ws.sent).toHaveLength(2);
    emitReply(ws, frame(ws, 0).id, { ok: false, error: { code: 'E_PAUSED', message: 'file paused', jobId: JOB } });
    const err = await failure(promise);
    expect(err.code).toBe('E_PAUSED');
  });

  it('a cancel reply that never arrives rejects after the cancel-reply timer: cancel failed, with the jobId', async () => {
    const ws = fakeWs();
    const { promise, settled } = start(ws);
    emitJobState(ws, 'queued');
    await vi.advanceTimersByTimeAsync(QUEUE_MS);
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS - 1);
    expect(settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const err = await failure(promise);
    expect(err.code).toBe('E_TIMEOUT');
    expect(err.jobId).toBe(JOB);
    expect(err.message).toContain('cancel failed');
    expect(err.message).toContain('job state unknown');
  });

  it('running past the run budget rejects with the jobId, the --wait hint and the queue wait', async () => {
    const ws = fakeWs();
    const { promise } = start(ws);
    emitJobState(ws, 'queued');
    await vi.advanceTimersByTimeAsync(3_000);
    emitJobState(ws, 'running');
    await vi.advanceTimersByTimeAsync(RUN_MS);
    const err = await failure(promise);
    expect(err.code).toBe('E_TIMEOUT');
    expect(err.jobId).toBe(JOB);
    expect(err.message).toContain(`ran ${RUN_MS}ms after 3000ms in queue`);
    expect(err.message).toContain(`job ${JOB} was NOT cancelled`);
    expect(err.message).toContain(`figma-agent job ${JOB} --wait`);
    expect(ws.sent).toHaveLength(1);
  });

  it('a queued event naming a wedged blocker cancels at once and names the blocker and --force-release', async () => {
    const ws = fakeWs();
    const { promise } = start(ws);
    emitJobState(ws, 'queued');
    emitJobState(ws, 'queued', { announcesRunning: true, blockedBy: 'j_1_1' });
    await vi.advanceTimersByTimeAsync(0);
    expect(ws.sent).toHaveLength(2);
    expect(frame(ws, 1).params).toEqual({ mode: 'cancel', jobId: JOB });
    emitReply(ws, frame(ws, 1).id, { ok: true, result: { ok: true } });
    const err = await failure(promise);
    expect(err.code).toBe('E_TIMEOUT');
    expect(err.jobId).toBe(JOB);
    expect(err.message).toContain('file blocked by wedged job j_1_1');
    expect(err.message).toContain('figma-agent job j_1_1 --force-release');
    expect(err.message).toContain('never ran');
  });

  it('without the opt-in, an announcing broker still gets the single clock from send', async () => {
    const ws = fakeWs();
    const promise = exchange(ws as never, 'EXEC_JS', {}, RUN_MS);
    promise.catch(() => { /* asserted below */ });
    emitJobState(ws, 'queued');
    await vi.advanceTimersByTimeAsync(RUN_MS);
    const err = await failure(promise);
    expect(err.message).toContain(`still running after ${RUN_MS}ms — job ${JOB} was NOT cancelled`);
    expect(ws.sent).toHaveLength(1);
  });
});

describe('exec-js command — timeout notice and --queue-timeout', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'figma-agent-exec-budget-'));
  const path = join(scratch, 'script.js');
  writeFileSync(path, 'return 1', 'utf8');
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(runCommand).mockReset();
    vi.mocked(runCommand).mockResolvedValue({ ok: true });
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => stderr.mockRestore());

  const opts = (): Record<string, unknown> => vi.mocked(runCommand).mock.calls[0]![2] as Record<string, unknown>;
  const notices = (): string[] => stderr.mock.calls.map(([line]) => String(line)).filter((l) => l.startsWith('notice:'));

  it('prints one notice naming the requested and effective values when --timeout exceeds the ceiling', async () => {
    await run(parseArgs([path, '--timeout', '300000']));
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toContain('300000');
    expect(notices()[0]).toContain('120000');
    expect((vi.mocked(runCommand).mock.calls[0]![1] as { timeoutMs: number }).timeoutMs).toBe(120_000);
  });

  it('prints no notice inside the ceiling', async () => {
    await run(parseArgs([path, '--timeout', '60000']));
    expect(notices()).toHaveLength(0);
    expect((vi.mocked(runCommand).mock.calls[0]![1] as { timeoutMs: number }).timeoutMs).toBe(60_000);
  });

  it('opts into the dispatch budget with a 600000ms queue limit by default', async () => {
    await run(parseArgs([path]));
    expect(opts()).toMatchObject({ queueTimeoutMs: 600_000 });
  });

  it('passes an explicit --queue-timeout through', async () => {
    await run(parseArgs([path, '--queue-timeout', '90000']));
    expect(opts()).toMatchObject({ queueTimeoutMs: 90_000 });
  });

  it.each([
    ['bare', [path, '--queue-timeout']],
    ['zero', [path, '--queue-timeout', '0']],
    ['negative', [path, '--queue-timeout=-5']],
    ['non-numeric', [path, '--queue-timeout', 'abc']],
  ])('rejects a %s --queue-timeout before any broker call', async (_label, argv) => {
    await expect(run(parseArgs(argv))).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
    expect(runCommand).not.toHaveBeenCalled();
  });
});
