import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildDisconnectRecord,
  readDisconnectTail,
  type BuildDisconnectRecordInput,
  type PluginSocketInfo,
} from '../cli/src/transport/disconnect-log.ts';

const baseInfo: PluginSocketInfo = {
  instanceId: 'p_1_test',
  openedAt: 1_000,
};

describe('buildDisconnectRecord — bounded arrays and omitted counts', () => {
  it('caps inFlightJobs and records omitted count when inFlight exceeds cap', () => {
    const jobs = Array.from({ length: 25 }, (_, i) => ({
      jobId: `job_${i}`,
      cmd: 'EXEC_JS',
      activity: `activity_${i}`,
      createdAt: 1_000,
    }));
    const input: BuildDisconnectRecordInput = {
      now: 2_000,
      info: baseInfo,
      liveEntry: null,
      closedBy: 'peer',
      closeCode: 1000,
      closeReason: 'normal',
      inFlightJobs: jobs,
      queueDepthByFile: {},
    };
    const record = buildDisconnectRecord(input);
    expect(record.inFlightJobs.length).toBeLessThanOrEqual(10);
    expect(record.omittedInFlightJobs).toBe(15);
    expect(record.omittedQueueDepthFiles).toBeUndefined();
  });

  it('caps queueDepthByFile and records omitted count when entries exceed cap', () => {
    const queueDepthByFile: Record<string, number> = {};
    for (let i = 0; i < 35; i++) {
      queueDepthByFile[`file_${i}`] = i;
    }
    const input: BuildDisconnectRecordInput = {
      now: 2_000,
      info: baseInfo,
      liveEntry: null,
      closedBy: 'peer',
      closeCode: 1000,
      closeReason: 'normal',
      inFlightJobs: [],
      queueDepthByFile,
    };
    const record = buildDisconnectRecord(input);
    expect(Object.keys(record.queueDepthByFile).length).toBeLessThanOrEqual(20);
    expect(record.omittedQueueDepthFiles).toBe(15);
    expect(record.omittedInFlightJobs).toBeUndefined();
  });

  it('omits counters when collections are within bounds', () => {
    const input: BuildDisconnectRecordInput = {
      now: 2_000,
      info: baseInfo,
      liveEntry: null,
      closedBy: 'peer',
      closeCode: 1000,
      closeReason: 'normal',
      inFlightJobs: [{ jobId: 'j1', cmd: 'EXEC_JS', createdAt: 1_000 }],
      queueDepthByFile: { file_a: 1 },
    };
    const record = buildDisconnectRecord(input);
    expect(record.inFlightJobs).toHaveLength(1);
    expect(record.queueDepthByFile).toEqual({ file_a: 1 });
    expect(record.omittedInFlightJobs).toBeUndefined();
    expect(record.omittedQueueDepthFiles).toBeUndefined();
  });

  it('honors explicitly stamped superseded on socket info', () => {
    const input: BuildDisconnectRecordInput = {
      now: 2_000,
      info: { ...baseInfo, superseded: true },
      liveEntry: { fileName: 'Live', fileKey: 'k', lastSeenAt: 1900, lastAppFrameAt: 1900 },
      closedBy: 'broker-superseded',
      closeCode: 1000,
      closeReason: 'superseded',
      inFlightJobs: [],
      queueDepthByFile: {},
    };
    const record = buildDisconnectRecord(input);
    expect(record.superseded).toBe(true);
    expect(record.closedBy).toBe('broker-superseded');
  });
});

describe('readDisconnectTail — oversized records count as read failures', () => {
  it('increments readFailures when newest record is larger than tail window', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fa-disconnect-tail-'));
    const path = join(dir, 'figma-disconnects.jsonl');
    try {
      // 70 KiB record (larger than 64 KiB tail window)
      const hugePadding = 'x'.repeat(70 * 1024);
      const hugeRecord = JSON.stringify({
        at: new Date().toISOString(),
        instanceId: 'huge_inst',
        padding: hugePadding,
      });
      writeFileSync(path, `${hugeRecord}\n`);
      const res = readDisconnectTail(path);
      expect(res.records).toEqual([]);
      expect(res.readFailures).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('increments readFailures when newest record is completely unparseable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fa-disconnect-tail-'));
    const path = join(dir, 'figma-disconnects.jsonl');
    try {
      writeFileSync(path, 'completely corrupt tail line that cannot be parsed as json\n');
      const res = readDisconnectTail(path);
      expect(res.records).toEqual([]);
      expect(res.readFailures).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
