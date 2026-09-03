// The plugin half of the session coverage statement: everything the main thread already
// measures, folded into ONE bounded answer to "what can this session not account for".
//
// It exists because those measurements were already there and still had to be assembled
// by hand: an agent had to know that `gapfill.baselineWrittenAt: null` means the window
// while the plugin was closed was never diffed, that `pageFallbacks` means a page name was
// guessed, and that `perf.propertyReadErrors` means nodes fell out of the walk. Each fact
// was honest and separately reported; together they were a puzzle nobody solved on
// connect. This states them once, in one shape, with a pointer to the detail.
//
// Pure and caller-fed — it re-derives nothing and measures nothing itself.
import type { GapfillStatus, PerfStatus, SessionCoverage } from '../../../shared/protocol';
import { coverageRow, sessionCoverage } from '../../../shared/session-coverage';
import type { DocumentChangeCaptureStats } from './document-change-capture';

export interface PluginCoverageInput {
  gapfill?: GapfillStatus;
  capture?: DocumentChangeCaptureStats;
  /** Boot's own marker. `perf` is withheld (perf-stats.ts) until `markBootComplete`, and
   *  it is the ONLY feeder here that is: main.ts hands `gapfill` in from the very first
   *  STATUS, so gap-fill's presence says nothing about whether boot finished. */
  perf?: PerfStatus;
}

/**
 * Build the plugin-side statement. `complete` can only become `true` once boot has
 * finished (`perf` present) AND a baseline actually landed AND every count is zero — a
 * session that has not finished booting answers `null`, because "not yet known" and
 * "nothing to report" are different facts and only one of them is health.
 */
export function buildPluginCoverage({ gapfill, capture, perf }: PluginCoverageInput): SessionCoverage {
  const booted = perf !== undefined;
  return sessionCoverage([
    // The window while the plugin was closed was never diffed against anything — the one
    // failure that used to look identical to a healthy session. TWO ways to get here, and
    // the second is why `baselineWrittenAt` alone is not the test: no baseline was written
    // at all, OR this boot found none to diff and STARTED one (`baselineFirstRun`), which
    // sets `baselineWrittenAt` on the way out and would otherwise read as full health.
    coverageRow(
      'baseline-missing',
      gapfill && (gapfill.baselineWrittenAt === null || gapfill.baselineFirstRun === true) ? 1 : 0,
      'status.gapfill',
    ),
    // Pages that reported WITHOUT a per-node diff. The two counters behind this overlap by
    // an amount the walk does not record (`pagesTopLevelOnly` covers pages with a previous
    // fingerprint whichever side was over the cap; `pagesTruncated` covers pages over it
    // this session, fingerprint or not), so their sum would double-count and either alone
    // can be too small. The larger is the biggest number both counters support — a lower
    // bound, deliberately, with the exact pair one hop away in `status.gapfill`.
    coverageRow(
      'pages-top-level-only',
      gapfill ? Math.max(gapfill.pagesTopLevelOnly, gapfill.pagesTruncated) : 0,
      'status.gapfill',
    ),
    coverageRow('pages-read-errors', gapfill?.pagesWithReadErrors ?? 0, 'status.gapfill'),
    // An eviction is a deletion of another file's stored baseline: that file's next
    // session has nothing to diff against, and this is the only place it is ever said.
    coverageRow('baseline-evicted', gapfill?.baselineEvicted?.length ?? 0, 'status.gapfill'),
    // Gap-fill failures include "page walk failed on <page>" — that page's edits went
    // unreported, so a session with one cannot claim to account for everything even when
    // a baseline later landed. The messages themselves stay in `status.gapfill.errors`.
    coverageRow('gapfill-errors', gapfill?.errorCount ?? 0, 'status.gapfill'),
    // A changed node with no resolvable page was filed under the current one — the feed
    // carries those frames under a guessed page name.
    coverageRow('page-fallbacks', capture?.pageFallbacks ?? 0, 'changes'),
    coverageRow('capture-errors', capture?.errorCount ?? 0, 'status.captureErrors'),
    // `capture.pluginDataChangesDropped` deliberately gets NO row: those entries are the
    // plugin's own bookkeeping echo (a property change whose every property is
    // `pluginData`), not a designer edit this session failed to see — it stays readable
    // on STATUS as its own counter.
    // Nodes dropped mid-walk because their properties threw: absent from the walk, so
    // absent from what any diff built on it could report.
    coverageRow('property-read-errors', perf?.propertyReadErrors ?? 0, 'status.perf'),
  ], { booted });
}
