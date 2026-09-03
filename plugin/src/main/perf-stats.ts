// The session-lifetime timings behind STATUS's `perf` block.
//
// It exists because "the plugin freezes on a big file" was, for the whole life of this
// bug, an anecdote: nothing anywhere said how long the boot walk took, how large its worst
// synchronous chunk was, or whether the wait was Figma's own page load rather than our
// walk. Those three numbers are also the DECISION RULE for the progressive-load phase:
// `bootLoadAllPagesMs` over ~2 s (or a stall that persists while `bootWalkMaxSliceMs` is
// small) means the cost is Figma's load, not this plugin's traversal.
//
// Same reporting contract as the gap-fill block: numbers appear once boot has actually
// completed, so "0" always means measured-zero rather than never-ran, and
// `propertyReadErrors` is present ONLY when non-zero — a node dropped mid-walk is a real
// loss and must leave a trace, while a clean session keeps the payload unchanged.
import type { PerfStatus } from '../../../shared/protocol';

/** Which walk a measurement belongs to. Boot and idle are budgeted differently: boot walks
 *  every page once, idle walks only the pages an edit actually touched. */
export type WalkPhase = 'boot' | 'idle';

export interface PerfStats {
  /** `figma.loadAllPagesAsync()` — the dynamic-page precondition for document-wide capture,
   *  and the one boot cost this plugin cannot slice. */
  bootLoadAllPagesMs: number;
  /** The WORST `page.loadAsync()` seen before a page's walk. Expected ≈ 0 (the pages are
   *  already resident after `loadAllPagesAsync`); a large value would mean the load can be
   *  split per page instead of paid in one block. 0 also when no host offered `loadAsync`. */
  pageLoadAsyncMaxMs: number;
  bootWalkMs: number;
  bootWalkMaxSliceMs: number;
  bootSlices: number;
  idleWalkMs: number;
  idleWalkMaxSliceMs: number;
  propertyReadErrors: number;
  /** Until boot finishes, every number above is a partial measurement of a walk still in
   *  progress; reporting them would invite reading a mid-walk total as a final one. */
  bootCompleted: boolean;
}

export function createPerfStats(): PerfStats {
  return {
    bootLoadAllPagesMs: 0, pageLoadAsyncMaxMs: 0,
    bootWalkMs: 0, bootWalkMaxSliceMs: 0, bootSlices: 0,
    idleWalkMs: 0, idleWalkMaxSliceMs: 0,
    propertyReadErrors: 0, bootCompleted: false,
  };
}

export function recordLoadAllPages(perf: PerfStats, ms: number): void {
  perf.bootLoadAllPagesMs = ms;
}

export function recordPageLoadAsync(perf: PerfStats, ms: number): void {
  if (ms > perf.pageLoadAsyncMaxMs) perf.pageLoadAsyncMaxMs = ms;
}

/** One page's walk. Totals accumulate across the pages of a phase; the slice maximum is a
 *  MAXIMUM, not a mean: the visible stall is the worst chunk, and an average would hide it
 *  behind twenty fast pages. */
export function recordWalk(
  perf: PerfStats,
  phase: WalkPhase,
  walk: { walkMs: number; slices: number; maxSliceMs: number; propertyReadErrors: number },
): void {
  perf.propertyReadErrors += walk.propertyReadErrors;
  if (phase === 'boot') {
    perf.bootWalkMs += walk.walkMs;
    perf.bootSlices += walk.slices;
    if (walk.maxSliceMs > perf.bootWalkMaxSliceMs) perf.bootWalkMaxSliceMs = walk.maxSliceMs;
    return;
  }
  perf.idleWalkMs += walk.walkMs;
  if (walk.maxSliceMs > perf.idleWalkMaxSliceMs) perf.idleWalkMaxSliceMs = walk.maxSliceMs;
}

/** Boot reached its end — including the paths that walked nothing (an unreadable baseline
 *  skips the walk deliberately), where zeros are the honest reading. */
export function markBootComplete(perf: PerfStats): void {
  perf.bootCompleted = true;
}

export function toPerfStatus(perf: PerfStats): PerfStatus | undefined {
  if (!perf.bootCompleted) return undefined;
  return {
    bootLoadAllPagesMs: perf.bootLoadAllPagesMs,
    pageLoadAsyncMaxMs: perf.pageLoadAsyncMaxMs,
    bootWalkMs: perf.bootWalkMs,
    bootWalkMaxSliceMs: perf.bootWalkMaxSliceMs,
    bootSlices: perf.bootSlices,
    idleWalkMs: perf.idleWalkMs,
    idleWalkMaxSliceMs: perf.idleWalkMaxSliceMs,
    ...(perf.propertyReadErrors > 0 && { propertyReadErrors: perf.propertyReadErrors }),
  };
}
