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
  /** Pages over the node cap AS OF this session's walk. A page that was over it only in the
   *  PREVIOUS session is suppressed the same way but counted nowhere here: this number backs
   *  a sentence about the page's CURRENT size. */
  pagesTruncated: number;
  /** Pages whose closed-window signal came from the TOP-LEVEL fingerprint alone — every
   *  page whose per-node diff was suppressed and whose previous session stored a
   *  fingerprint, whichever side was over the cap. Reported so the coverage a session
   *  actually delivered is readable rather than inferred. */
  pagesTopLevelOnly: number;
  /** Pages whose diff was skipped because their walk could not read every node. Their
   *  missing nodes would otherwise have been reported as deletions. */
  pagesWithReadErrors: number;
  /** Nodes the diff would have called deleted, which the host could still find — the walk
   *  spans yields, so a node reparented mid-walk goes missing without being gone. Left for
   *  the next session's diff rather than reported as a deletion that did not happen. */
  deletedRechecked: number;
  baselineWrittenAt: string | null;
  baselineBytes: number;
  legacyCleared: number;
  /** Superseded previous-shape baseline values deleted after a successful write. */
  staleBaselinesCleared: number;
  evicted: string[];
  errorCount: number;
  firstError: string | null;
  /** True when THIS boot found no usable baseline at all and started one (the `!prev`
   *  path in edit-gapfill.ts): it walked, wrote, and diffed nothing. `baselineWrittenAt`
   *  is set by that same path, so without this flag a first-ever session is
   *  indistinguishable from one that diffed a full history. */
  baselineFirstRun: boolean;
  /** True once this session's boot found a stored baseline it could NOT read. Every later
   *  write in the session is withheld: the stored value is the only record of the window
   *  the plugin was closed, and the unreadable notice promised it would be diffed on the
   *  next successful boot — a write from this session would make that promise false. */
  bootBaselineUnreadable: boolean;
  /** The exact message (if any) this session's BOOT read of the stored baseline recorded —
   *  set once, by the boot's own read, and never by any later one. Every later read of the
   *  SAME key (a write's own read-back, at boot or idle) compares against this and skips
   *  `recordGapfillError` when it is the identical refusal: the boot verdict is
   *  authoritative for the whole session, so the one cause is stated once no matter how
   *  many times something in this session re-reads the same unreadable/foreign value. A
   *  DIFFERENT message (a store that only starts rejecting later, or the WRITE itself
   *  refusing) is a genuinely separate fact and is always recorded, no matter how many
   *  times that keeps happening. */
  bootReadError: string | null;
}

export function createGapfillStats(): GapfillStats {
  return {
    pagesDiffed: 0, pagesTruncated: 0, pagesTopLevelOnly: 0, pagesWithReadErrors: 0, deletedRechecked: 0,
    baselineWrittenAt: null, baselineBytes: 0,
    legacyCleared: 0, staleBaselinesCleared: 0,
    evicted: [], errorCount: 0, firstError: null,
    baselineFirstRun: false, bootBaselineUnreadable: false, bootReadError: null,
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
    pagesTopLevelOnly: stats.pagesTopLevelOnly,
    baselineWrittenAt: stats.baselineWrittenAt,
    baselineBytes: stats.baselineBytes,
    ...(stats.pagesWithReadErrors > 0 && { pagesWithReadErrors: stats.pagesWithReadErrors }),
    ...(stats.deletedRechecked > 0 && { deletedRechecked: stats.deletedRechecked }),
    ...(stats.legacyCleared > 0 && { legacyCleared: stats.legacyCleared }),
    ...(stats.staleBaselinesCleared > 0 && { staleBaselinesCleared: stats.staleBaselinesCleared }),
    ...(stats.baselineFirstRun && { baselineFirstRun: true as const }),
    ...(stats.evicted.length > 0 && { baselineEvicted: [...stats.evicted] }),
    ...(stats.firstError !== null && { errors: [stats.firstError], errorCount: stats.errorCount }),
  };
}
