// The session coverage statement: ONE bounded answer to "what can this session NOT
// account for", carried on STATUS and on `figma-agent status`'s `plugin` object.
//
// Two rules make it worth trusting, and both are asserted here:
//   · a row is one KIND with a count, never one row per event — an unbounded log in a
//     status payload is exactly the thing agents stop reading;
//   · `complete: true` is only ever claimed when every count is zero AND boot has
//     actually finished AND a baseline landed. A coverage claim that overstates is worse
//     than no coverage claim at all, so "boot has not finished" reads as `null`
//     (unknown), never as health.
import { describe, expect, it } from 'vitest';
import { COVERAGE_GAP_KINDS, type CoverageGap, type GapfillStatus, type PerfStatus } from '../shared/protocol.ts';
import {
  COVERAGE_SEE_TARGETS, coverageRow, mergeCoverage, readSessionCoverage, sessionCoverage,
} from '../shared/session-coverage.ts';
import { brokerCoverageRows } from '../cli/src/transport/broker-coverage-rows.ts';
import { buildPluginCoverage } from '../plugin/src/main/session-coverage.ts';
import type { DocumentChangeCaptureStats } from '../plugin/src/main/document-change-capture.ts';

const gapfill = (over: Partial<GapfillStatus> = {}): GapfillStatus => ({
  pagesDiffed: 3, pagesTruncated: 0, pagesTopLevelOnly: 0,
  baselineWrittenAt: '2026-09-04T00:00:00.000Z', baselineBytes: 100, ...over,
});

const perf = (over: Partial<PerfStatus> = {}): PerfStatus => ({
  bootLoadAllPagesMs: 1, pageLoadAsyncMaxMs: 0, bootWalkMs: 2, bootWalkMaxSliceMs: 1,
  bootSlices: 1, idleWalkMs: 0, idleWalkMaxSliceMs: 0, ...over,
});

const capture = (over: Partial<DocumentChangeCaptureStats> = {}): DocumentChangeCaptureStats => ({
  pluginDataChangesDropped: 0, pageFallbacks: 0, errorCount: 0, firstError: null, ...over,
});

const kindsOf = (coverage: { gaps: readonly CoverageGap[] }): string[] => coverage.gaps.map((g) => g.kind);

describe('coverageRow — the closed kind list is the whole vocabulary', () => {
  it('a kind outside the enum is REFUSED, not quietly emitted', () => {
    expect(() => coverageRow('pages-vanished' as never, 2, 'changes'))
      .toThrow(/unknown coverage gap kind/i);
  });

  it('a zero (or negative) count is not a row — `gaps` holds only what actually happened', () => {
    expect(coverageRow('page-fallbacks', 0, 'changes')).toBeNull();
    expect(coverageRow('page-fallbacks', -1, 'changes')).toBeNull();
    expect(coverageRow('page-fallbacks', 3, 'changes')).toEqual({ kind: 'page-fallbacks', count: 3, see: 'changes' });
  });

  it('a fractional count is refused — a count is a whole number of things', () => {
    expect(() => coverageRow('page-fallbacks', 1.5, 'changes')).toThrow(/count/i);
  });
});

describe('sessionCoverage — `complete` is a claim, not a default', () => {
  it('boot not finished → null, with the rows that ARE known', () => {
    const coverage = sessionCoverage([coverageRow('page-fallbacks', 2, 'changes')], { booted: false });
    expect(coverage).toEqual({ complete: null, gaps: [{ kind: 'page-fallbacks', count: 2, see: 'changes' }] });
  });

  it('booted with no rows → true; booted with any row → false', () => {
    expect(sessionCoverage([], { booted: true })).toEqual({ complete: true, gaps: [] });
    expect(sessionCoverage([coverageRow('capture-errors', 1, 'status.plugin.captureErrors')], { booted: true }).complete)
      .toBe(false);
  });
});

describe('buildPluginCoverage — what the plugin main thread alone can state', () => {
  it('a clean, booted session with a written baseline claims completeness and lists nothing', () => {
    expect(buildPluginCoverage({ gapfill: gapfill(), capture: capture(), perf: perf() }))
      .toEqual({ complete: true, gaps: [] });
  });

  it('before boot completes (no perf block) the answer is null — never a default true', () => {
    // main.ts hands `gapfill` in from the first STATUS onward, so gap-fill's presence is
    // NOT a boot marker; `perf` is (perf-stats.ts withholds it until markBootComplete).
    const coverage = buildPluginCoverage({ gapfill: gapfill(), capture: capture({ pageFallbacks: 1 }) });
    expect(coverage.complete).toBeNull();
    expect(coverage.gaps).toEqual([{ kind: 'page-fallbacks', count: 1, see: 'changes' }]);
  });

  it('a session that wrote no baseline says so, and cannot be complete', () => {
    const coverage = buildPluginCoverage({ gapfill: gapfill({ baselineWrittenAt: null }), perf: perf() });
    expect(coverage.complete).toBe(false);
    expect(coverage.gaps).toContainEqual({ kind: 'baseline-missing', count: 1, see: 'status.plugin.gapfill' });
  });

  it('a first-ever session on a file is a gap, even though it wrote a baseline', () => {
    // The `!prev` boot path walks, writes, and returns the baseline-missing notice — so
    // `baselineWrittenAt` is set and only this flag records that NOTHING was diffed.
    const coverage = buildPluginCoverage({ gapfill: gapfill({ baselineFirstRun: true }), perf: perf() });
    expect(coverage.complete).toBe(false);
    expect(coverage.gaps).toEqual([{ kind: 'baseline-missing', count: 1, see: 'status.plugin.gapfill' }]);
  });

  it('a caller that supplies nothing claims nothing', () => {
    expect(buildPluginCoverage({})).toEqual({ complete: null, gaps: [] });
  });

  it('every feeder lands on its own kind, with its own count and where the detail is', () => {
    const coverage = buildPluginCoverage({
      gapfill: gapfill({
        pagesTopLevelOnly: 2, pagesTruncated: 1, pagesWithReadErrors: 4,
        baselineEvicted: ['a', 'b'], errors: ['page walk failed on "Home"'], errorCount: 3,
      }),
      capture: capture({ pageFallbacks: 5, errorCount: 6, firstError: 'store write failed' }),
      perf: perf({ propertyReadErrors: 7 }),
    });
    expect(coverage.complete).toBe(false);
    expect(coverage.gaps).toEqual([
      { kind: 'pages-top-level-only', count: 2, see: 'status.plugin.gapfill' },
      { kind: 'pages-read-errors', count: 4, see: 'status.plugin.gapfill' },
      { kind: 'baseline-evicted', count: 2, see: 'status.plugin.gapfill' },
      { kind: 'gapfill-errors', count: 3, see: 'status.plugin.gapfill' },
      { kind: 'page-fallbacks', count: 5, see: 'changes' },
      { kind: 'capture-errors', count: 6, see: 'status.plugin.captureErrors' },
      { kind: 'property-read-errors', count: 7, see: 'status.plugin.perf' },
    ]);
  });

  it('pages that reported without a per-node diff count the larger of the two overlapping counters', () => {
    // `pagesTruncated` (over the cap this session) and `pagesTopLevelOnly` (reported by
    // fingerprint alone) overlap by an amount the walk does not record, so neither their
    // sum nor either alone is the true number of pages. The larger of the two is the
    // biggest number both counters support; `status.gapfill` carries the exact pair.
    const coverage = buildPluginCoverage({ gapfill: gapfill({ pagesTruncated: 9, pagesTopLevelOnly: 2 }), perf: perf() });
    expect(coverage.gaps).toEqual([{ kind: 'pages-top-level-only', count: 9, see: 'status.plugin.gapfill' }]);
  });

});

// `see` is a POINTER. A row aiming at a field or command that does not exist is worse than
// no pointer at all, so every value both builders can emit is held to a closed list — and
// that list is checked against a real `status` reply in
// tests/session-coverage-status-command.test.ts, which is the half this file cannot see.
describe('every `see` a builder can emit is in the closed target list', () => {
  const everyPluginRow = (): { gaps: readonly CoverageGap[] } => buildPluginCoverage({
    gapfill: gapfill({
      baselineWrittenAt: null, pagesTopLevelOnly: 1, pagesWithReadErrors: 1,
      baselineEvicted: ['x'], errorCount: 1, errors: ['boom'],
    }),
    capture: capture({ pageFallbacks: 1, errorCount: 1, firstError: 'x' }),
    perf: perf({ propertyReadErrors: 1 }),
  });

  it('the plugin builder fires every row it has, and every kind and see is known', () => {
    const coverage = everyPluginRow();
    // All eight plugin-known kinds at once — a row that silently stopped firing would drop
    // out of this count.
    expect(coverage.gaps).toHaveLength(8);
    for (const kind of kindsOf(coverage)) expect(COVERAGE_GAP_KINDS).toContain(kind);
    for (const gap of coverage.gaps) expect(COVERAGE_SEE_TARGETS).toContain(gap.see);
  });

  it('the broker builder does too, under both list spellings', () => {
    for (const pluginsField of ['plugins', 'pluginsAll'] as const) {
      const rows = brokerCoverageRows({
        fileRows: [{ relayDroppedFrames: 1, replayedBatches: 1 }], otherFiles: 1, pluginsField,
      }).filter((row): row is CoverageGap => row !== null);
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(COVERAGE_GAP_KINDS).toContain(row.kind);
        expect(COVERAGE_SEE_TARGETS).toContain(row.see);
      }
    }
  });
});

describe('mergeCoverage — the broker appends what only it can see', () => {
  const brokerRow = (count: number): CoverageGap | null => coverageRow('other-files-connected', count, 'status.plugins');

  it('a plugin that reported no coverage at all leaves the answer unknown, rows kept', () => {
    const merged = mergeCoverage(null, [brokerRow(1)]);
    expect(merged).toEqual({ complete: null, gaps: [{ kind: 'other-files-connected', count: 1, see: 'status.plugins' }] });
  });

  it('a complete plugin session plus a broker-side gap is NOT complete', () => {
    expect(mergeCoverage({ complete: true, gaps: [] }, [brokerRow(2)]).complete).toBe(false);
  });

  it('complete stays true only when both sides are empty', () => {
    expect(mergeCoverage({ complete: true, gaps: [] }, [brokerRow(0)])).toEqual({ complete: true, gaps: [] });
  });

  it('a pre-boot plugin session stays null even with no broker rows', () => {
    expect(mergeCoverage({ complete: null, gaps: [] }, []).complete).toBeNull();
  });
});

describe('readSessionCoverage — the STATUS reply is untrusted input', () => {
  it('an absent or malformed block reads as "no coverage reported", never as health', () => {
    expect(readSessionCoverage(undefined)).toBeNull();
    expect(readSessionCoverage({ complete: true })).toBeNull();
    expect(readSessionCoverage({ complete: 'yes', gaps: [] })).toBeNull();
  });

  it('a row from a NEWER plugin whose kind this build does not know is KEPT, not dropped', () => {
    const read = readSessionCoverage({ complete: false, gaps: [{ kind: 'kind-from-the-future', count: 2, see: 'changes' }] });
    expect(read).toEqual({ complete: false, gaps: [{ kind: 'kind-from-the-future', count: 2, see: 'changes' }] });
  });

  it('a malformed row is dropped and the session can no longer claim completeness', () => {
    const read = readSessionCoverage({ complete: true, gaps: [{ kind: 'page-fallbacks', count: 'many', see: 'changes' }] });
    expect(read).toEqual({ complete: null, gaps: [] });
  });
});
