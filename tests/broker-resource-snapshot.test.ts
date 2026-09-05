import { describe, expect, it } from 'vitest';
import { JobTable } from '../cli/src/transport/job-table.ts';
import {
  collectBrokerResourceSnapshot,
  type BrokerResourceSnapshot,
} from '../cli/src/transport/broker-resource-snapshot.ts';

describe('broker retained-resource snapshot', () => {
  it('counts exact UTF-8 frame ownership without claiming a unique-memory total', () => {
    const duplicateFrame = JSON.stringify({ id: 'duplicate', text: '🧪' });
    const pendingFrame = JSON.stringify({ id: 'pending', text: '你好' });
    const parkedFrame = JSON.stringify({ id: 'parked', text: 'café' });
    const connectionA = {};
    const connectionB = {};
    const pendingChunks = new Map([
      [connectionA, new Map([
        ['incomplete-a', { frames: [duplicateFrame, duplicateFrame], lastFrameAt: 1 }],
      ])],
      [connectionB, new Map([
        ['incomplete-b', { frames: [pendingFrame], lastFrameAt: 2 }],
      ])],
    ]);

    const jobs = new JobTable(() => 100, (() => {
      let id = 0;
      return () => `job-${++id}`;
    })());
    const queued = jobs.create({
      requestId: 'request-queued', cmd: 'SET_TEXT', fileSlug: 'secret-a', readOnly: false,
      requestFrames: [duplicateFrame, duplicateFrame], from: null, targetInstanceId: 'instance-a',
    });
    const running = jobs.create({
      requestId: 'request-running', cmd: 'GET_SELECTION', fileSlug: 'secret-b', readOnly: true,
      requestFrames: [pendingFrame], from: null, targetInstanceId: 'instance-b',
    });
    jobs.transitionQueuedToRunning(running.jobId);
    const finished = jobs.create({
      requestId: 'request-finished', cmd: 'GET_SELECTION', fileSlug: 'secret-c', readOnly: true,
      requestFrames: [parkedFrame], from: null, targetInstanceId: 'instance-c',
    });
    jobs.transitionQueuedToRunning(finished.jobId);
    jobs.finish(finished.jobId, true, [duplicateFrame]);

    const snapshot = collectBrokerResourceSnapshot({
      pendingChunks,
      parkedRequestFrames: [parkedFrame],
      jobTable: jobs.resourceSnapshot(),
      queues: new Map([
        ['secret-a', { running: queued.jobId, waiting: [running.jobId] }],
        ['secret-b', { running: null, waiting: [] }],
      ]),
      pendingRequestReferenceCount: 2,
      dispatchedRequestReferenceCount: 1,
      dispatchReservationReferenceCount: 1,
    });

    expect(snapshot).toEqual({
      pendingChunks: {
        connectionCount: 2,
        incompleteIdCount: 2,
        frameReferences: 3,
        utf8Bytes: Buffer.byteLength(duplicateFrame) * 2 + Buffer.byteLength(pendingFrame),
        perConnection: [
          { ordinal: 1, incompleteIdCount: 1, frameReferences: 2, utf8Bytes: Buffer.byteLength(duplicateFrame) * 2 },
          { ordinal: 2, incompleteIdCount: 1, frameReferences: 1, utf8Bytes: Buffer.byteLength(pendingFrame) },
        ],
      },
      parkedRequests: { requestCount: 1, frameReferences: 1, utf8Bytes: Buffer.byteLength(parkedFrame) },
      jobTable: {
        jobCount: 3, liveJobCount: 2, queuedJobCount: 1, runningJobCount: 1,
        outcomeUnknownJobCount: 0, finishedJobCount: 1, retentionHeldJobCount: 0,
        requestFrames: {
          frameReferences: 4,
          utf8Bytes: Buffer.byteLength(duplicateFrame) * 2 + Buffer.byteLength(pendingFrame) + Buffer.byteLength(parkedFrame),
        },
        replyFrames: { frameReferences: 1, utf8Bytes: Buffer.byteLength(duplicateFrame) },
      },
      fileQueues: {
        fileQueueCount: 2, occupiedSlotReferenceCount: 1, waitingJobReferenceCount: 1,
        perFile: [
          { ordinal: 1, occupiedSlotReferenceCount: 1, waitingJobReferenceCount: 1 },
          { ordinal: 2, occupiedSlotReferenceCount: 0, waitingJobReferenceCount: 0 },
        ],
      },
      correlations: {
        pendingRequestReferenceCount: 2,
        dispatchedRequestReferenceCount: 1,
        dispatchReservationReferenceCount: 1,
      },
      duplicateOwnershipReferences: {
        jobReferencesFromOccupiedQueueSlots: 1,
        jobReferencesFromQueueWaitingLists: 1,
        requestReferencesFromPendingCorrelations: 2,
        requestReferencesFromDispatchCorrelations: 1,
        jobReferencesFromDispatchReservations: 1,
      },
    });
    expect(snapshot).not.toHaveProperty('totalBytes');
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('secret-');
    expect(serialized).not.toContain('request-');
    expect(serialized).not.toContain('instance-');
    expect(serialized).not.toContain('"id":"duplicate"');
  });

  it('returns deeply frozen copies that cannot mutate owner state', () => {
    const ownerFrames = ['{"id":"x","text":"🧊"}'];
    const jobs = new JobTable(() => 1, () => 'job-1');
    jobs.create({
      requestId: 'request-1', cmd: 'GET_SELECTION', fileSlug: 'private-file', readOnly: true,
      requestFrames: ownerFrames, from: null, targetInstanceId: 'private-instance',
    });
    const makeSnapshot = (): BrokerResourceSnapshot => collectBrokerResourceSnapshot({
      pendingChunks: new Map([[{}, new Map([['private-id', { frames: ownerFrames, lastFrameAt: 1 }]])]]),
      parkedRequestFrames: [], jobTable: jobs.resourceSnapshot(), queues: new Map(),
      pendingRequestReferenceCount: 0, dispatchedRequestReferenceCount: 0,
      dispatchReservationReferenceCount: 0,
    });

    const snapshot = makeSnapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.pendingChunks)).toBe(true);
    expect(Object.isFrozen(snapshot.pendingChunks.perConnection)).toBe(true);
    expect(() => (snapshot.pendingChunks.perConnection as unknown[]).push({})).toThrow(TypeError);
    expect(() => ((snapshot.jobTable as { jobCount: number }).jobCount = 99)).toThrow(TypeError);
    expect(makeSnapshot().jobTable.jobCount).toBe(1);
    expect(ownerFrames).toEqual(['{"id":"x","text":"🧊"}']);
  });
});
