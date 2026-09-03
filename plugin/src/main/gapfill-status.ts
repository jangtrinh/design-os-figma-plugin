// The session-lifetime tally behind STATUS's `gapfill` block.
//
// It exists because the failure this phase fixes was invisible: the baseline write threw on
// every file since the feature shipped and nothing anywhere said so. A counter that only
// appears once it is non-zero is the repo's standing answer to that — a session that wrote
// no baseline now reports `baselineWrittenAt: null` instead of looking identical to one
// that did.
import type { GapfillStatus } from '../../../shared/protocol';

export interface GapfillStats {
  pagesDiffed: number;
  pagesTruncated: number;
  baselineWrittenAt: string | null;
  baselineBytes: number;
  legacyCleared: number;
  evicted: string[];
  errorCount: number;
  firstError: string | null;
}

export function createGapfillStats(): GapfillStats {
  return {
    pagesDiffed: 0, pagesTruncated: 0, baselineWrittenAt: null, baselineBytes: 0,
    legacyCleared: 0, evicted: [], errorCount: 0, firstError: null,
  };
}

/** Every failure counts; the FIRST message is the one kept, because it is the one that
 *  describes the original cause rather than a cascade from it. */
export function recordGapfillError(stats: GapfillStats, message: string): void {
  stats.errorCount += 1;
  if (stats.firstError === null) stats.firstError = message;
}

/** Each evicted key recorded once — a file evicted twice in one session is still one
 *  file whose baseline is gone. */
export function recordGapfillEviction(stats: GapfillStats, key: string): void {
  if (!stats.evicted.includes(key)) stats.evicted.push(key);
}

export function toGapfillStatus(stats: GapfillStats): GapfillStatus {
  return {
    pagesDiffed: stats.pagesDiffed,
    pagesTruncated: stats.pagesTruncated,
    baselineWrittenAt: stats.baselineWrittenAt,
    baselineBytes: stats.baselineBytes,
    ...(stats.legacyCleared > 0 && { legacyCleared: stats.legacyCleared }),
    ...(stats.evicted.length > 0 && { baselineEvicted: [...stats.evicted] }),
    ...(stats.firstError !== null && { errors: [stats.firstError], errorCount: stats.errorCount }),
  };
}
