export interface FrameResourceUsage {
  readonly frameReferences: number;
  readonly utf8Bytes: number;
}

export interface JobTableResourceSnapshot {
  readonly jobCount: number;
  /** Non-evictable ownership, including held terminal records and excluding released unknown outcomes. */
  readonly liveJobCount: number;
  /** Public-state counts below are independent of retention liveness. */
  readonly queuedJobCount: number;
  readonly runningJobCount: number;
  readonly outcomeUnknownJobCount: number;
  readonly finishedJobCount: number;
  readonly retentionHeldJobCount: number;
  readonly requestFrames: FrameResourceUsage;
  readonly replyFrames: FrameResourceUsage;
}

export interface BrokerResourceSnapshot {
  readonly pendingChunks: FrameResourceUsage & {
    readonly connectionCount: number;
    readonly incompleteIdCount: number;
    readonly perConnection: readonly Readonly<FrameResourceUsage & {
      ordinal: number;
      incompleteIdCount: number;
    }>[];
  };
  readonly parkedRequests: FrameResourceUsage & { readonly requestCount: number };
  readonly jobTable: JobTableResourceSnapshot;
  readonly fileQueues: {
    readonly fileQueueCount: number;
    readonly occupiedSlotReferenceCount: number;
    readonly waitingJobReferenceCount: number;
    readonly perFile: readonly Readonly<{
      ordinal: number;
      occupiedSlotReferenceCount: number;
      waitingJobReferenceCount: number;
    }>[];
  };
  readonly correlations: {
    readonly pendingRequestReferenceCount: number;
    readonly dispatchedRequestReferenceCount: number;
    readonly dispatchReservationReferenceCount: number;
  };
  /** These are references to ownership represented elsewhere, never additional bytes. */
  readonly duplicateOwnershipReferences: {
    readonly jobReferencesFromOccupiedQueueSlots: number;
    readonly jobReferencesFromQueueWaitingLists: number;
    readonly requestReferencesFromPendingCorrelations: number;
    readonly requestReferencesFromDispatchCorrelations: number;
    readonly jobReferencesFromDispatchReservations: number;
  };
}

export type BrokerResourceSnapshotGetter = () => BrokerResourceSnapshot;
export type BrokerResourceObserver = (
  getSnapshot: BrokerResourceSnapshotGetter,
) => void | (() => void);

type PendingChunkBuffers<Connection> = ReadonlyMap<
  Connection,
  ReadonlyMap<string, { readonly frames: readonly string[] }>
>;

type QueueResources = ReadonlyMap<
  string,
  { readonly running: string | null; readonly waiting: readonly string[] }
>;

export function countFrameResources(frames: readonly string[]): FrameResourceUsage {
  let utf8Bytes = 0;
  for (const frame of frames) utf8Bytes += Buffer.byteLength(frame, 'utf8');
  return Object.freeze({ frameReferences: frames.length, utf8Bytes });
}

export function freezeJobTableResourceSnapshot(
  snapshot: JobTableResourceSnapshot,
): JobTableResourceSnapshot {
  return Object.freeze({
    jobCount: snapshot.jobCount,
    liveJobCount: snapshot.liveJobCount,
    queuedJobCount: snapshot.queuedJobCount,
    runningJobCount: snapshot.runningJobCount,
    outcomeUnknownJobCount: snapshot.outcomeUnknownJobCount,
    finishedJobCount: snapshot.finishedJobCount,
    retentionHeldJobCount: snapshot.retentionHeldJobCount,
    requestFrames: Object.freeze({ ...snapshot.requestFrames }),
    replyFrames: Object.freeze({ ...snapshot.replyFrames }),
  });
}

export function collectBrokerResourceSnapshot<Connection>(input: {
  pendingChunks: PendingChunkBuffers<Connection>;
  parkedRequestFrames: readonly string[];
  jobTable: JobTableResourceSnapshot;
  queues: QueueResources;
  pendingRequestReferenceCount: number;
  dispatchedRequestReferenceCount: number;
  dispatchReservationReferenceCount: number;
}): BrokerResourceSnapshot {
  let pendingFrameReferences = 0;
  let pendingUtf8Bytes = 0;
  let incompleteIdCount = 0;
  const perConnection: Array<Readonly<FrameResourceUsage & {
    ordinal: number;
    incompleteIdCount: number;
  }>> = [];
  let ordinal = 0;
  for (const chunks of input.pendingChunks.values()) {
    ordinal += 1;
    let connectionFrameReferences = 0;
    let connectionUtf8Bytes = 0;
    for (const entry of chunks.values()) {
      const usage = countFrameResources(entry.frames);
      connectionFrameReferences += usage.frameReferences;
      connectionUtf8Bytes += usage.utf8Bytes;
    }
    incompleteIdCount += chunks.size;
    pendingFrameReferences += connectionFrameReferences;
    pendingUtf8Bytes += connectionUtf8Bytes;
    perConnection.push(Object.freeze({
      ordinal,
      incompleteIdCount: chunks.size,
      frameReferences: connectionFrameReferences,
      utf8Bytes: connectionUtf8Bytes,
    }));
  }

  let occupiedSlotReferenceCount = 0;
  let waitingJobReferenceCount = 0;
  const perFile: Array<Readonly<{
    ordinal: number;
    occupiedSlotReferenceCount: number;
    waitingJobReferenceCount: number;
  }>> = [];
  let fileOrdinal = 0;
  for (const queue of input.queues.values()) {
    fileOrdinal += 1;
    const occupied = queue.running === null ? 0 : 1;
    occupiedSlotReferenceCount += occupied;
    waitingJobReferenceCount += queue.waiting.length;
    perFile.push(Object.freeze({
      ordinal: fileOrdinal,
      occupiedSlotReferenceCount: occupied,
      waitingJobReferenceCount: queue.waiting.length,
    }));
  }
  const parkedFrames = countFrameResources(input.parkedRequestFrames);
  const correlations = Object.freeze({
    pendingRequestReferenceCount: input.pendingRequestReferenceCount,
    dispatchedRequestReferenceCount: input.dispatchedRequestReferenceCount,
    dispatchReservationReferenceCount: input.dispatchReservationReferenceCount,
  });

  return Object.freeze({
    pendingChunks: Object.freeze({
      connectionCount: input.pendingChunks.size,
      incompleteIdCount,
      frameReferences: pendingFrameReferences,
      utf8Bytes: pendingUtf8Bytes,
      perConnection: Object.freeze(perConnection),
    }),
    parkedRequests: Object.freeze({ requestCount: input.parkedRequestFrames.length, ...parkedFrames }),
    jobTable: freezeJobTableResourceSnapshot(input.jobTable),
    fileQueues: Object.freeze({
      fileQueueCount: input.queues.size,
      occupiedSlotReferenceCount,
      waitingJobReferenceCount,
      perFile: Object.freeze(perFile),
    }),
    correlations,
    duplicateOwnershipReferences: Object.freeze({
      jobReferencesFromOccupiedQueueSlots: occupiedSlotReferenceCount,
      jobReferencesFromQueueWaitingLists: waitingJobReferenceCount,
      requestReferencesFromPendingCorrelations: correlations.pendingRequestReferenceCount,
      requestReferencesFromDispatchCorrelations: correlations.dispatchedRequestReferenceCount,
      jobReferencesFromDispatchReservations: correlations.dispatchReservationReferenceCount,
    }),
  });
}
