import { describe, expect, it } from 'vitest';
import { JOB_TTL_MS, JobTable } from '../cli/src/transport/job-table.ts';

function fixture() {
  let now = 100;
  const table = new JobTable(() => now, () => 'owned-job');
  const job = table.create({
    requestId: 'owned-request', cmd: 'SET_TEXT', fileSlug: 'owned-file', readOnly: false,
    requestFrames: ['request'], from: null, targetInstanceId: 'owned-plugin',
  });
  return { table, job, expire: () => { now += JOB_TTL_MS + 1; return table.sweep(); } };
}

function counts(table: JobTable): number[] {
  const s = table.resourceSnapshot();
  return [s.liveJobCount, s.queuedJobCount, s.runningJobCount,
    s.outcomeUnknownJobCount, s.finishedJobCount, s.retentionHeldJobCount];
}

describe('resource liveness follows retained job ownership', () => {
  it('keeps an unknown outcome live until its inspected release, then allows retention expiry', () => {
    const { table, job, expire } = fixture();
    expect(counts(table)).toEqual([1, 1, 0, 0, 0, 0]);
    table.transitionQueuedToRunning(job.jobId);
    expect(counts(table)).toEqual([1, 0, 1, 0, 0, 0]);
    table.markOutcomeUnknown(job.jobId, 'reply channel lost');
    expect(counts(table)).toEqual([1, 0, 0, 1, 0, 0]);
    expect(expire()).toBe(0);
    expect(counts(table)).toEqual([1, 0, 0, 1, 0, 0]);
    expect(table.settleOutcomeUnknownRelease(job.jobId)).toBe(true);
    expect(counts(table)).toEqual([0, 0, 0, 1, 0, 0]);
    expect(table.resourceSnapshot().requestFrames).toEqual({ frameReferences: 1, utf8Bytes: 7 });
    expect(expire()).toBe(1);
    expect(table.resourceSnapshot().jobCount).toBe(0);
    expect(counts(table)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it.each([true, false])('counts held terminal ownership until release when ok=%s', (ok) => {
    const { table, job, expire } = fixture();
    table.transitionQueuedToRunning(job.jobId);
    expect(table.finishHeld(job.jobId, ok, ['reply'])).toBe(true);
    expect(counts(table)).toEqual([1, 0, 0, 0, 1, 1]);
    expect(expire()).toBe(0);
    expect(counts(table)).toEqual([1, 0, 0, 0, 1, 1]);
    expect(table.settleHeldTerminalRelease(job.jobId)).toBe(true);
    expect(counts(table)).toEqual([0, 0, 0, 0, 1, 0]);
    expect(table.resourceSnapshot().replyFrames).toEqual({ frameReferences: 1, utf8Bytes: 5 });
    expect(expire()).toBe(1);
    expect(counts(table)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it.each(['done', 'failed', 'cancelled'] as const)('excludes ordinary %s records while retaining their evidence', (state) => {
    const { table, job, expire } = fixture();
    if (state === 'cancelled') table.cancelQueued(job.jobId, ['reply']);
    else {
      table.transitionQueuedToRunning(job.jobId);
      table.finish(job.jobId, state === 'done', ['reply']);
    }
    expect(counts(table)).toEqual([0, 0, 0, 0, 1, 0]);
    expect(table.resourceSnapshot().jobCount).toBe(1);
    expect(expire()).toBe(1);
    expect(table.resourceSnapshot().jobCount).toBe(0);
  });
});
