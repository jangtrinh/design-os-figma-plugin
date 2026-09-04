// `opStatus()` — editorType (absorption phase-02) + bootSkipped (absorption phase-03).
// bootSkipped follows the broker's own senderMismatchCount/legacyMigrationDeferred
// contract (issue #15/#19): present only once it's actually non-empty, so the common
// case (nothing skipped) keeps the STATUS payload byte-identical to before this field
// existed.
import { describe, it, expect } from 'vitest';
import { installMockFigma, setMockEditorType } from './helpers/mock-figma.ts';
import { opStatus } from '../plugin/src/main/executor-ops.ts';
import type { DocumentChangeCaptureStats } from '../plugin/src/main/document-change-capture.ts';
import {
  createGapfillStats, recordGapfillError, recordGapfillEviction, toGapfillStatus,
} from '../plugin/src/main/gapfill-status.ts';

describe('opStatus — editorType', () => {
  it('reports figma.editorType directly', () => {
    installMockFigma();
    setMockEditorType('figma');
    expect(opStatus().editorType).toBe('figma');
  });

  it('reports null (never a guessed default) when the host reports nothing', () => {
    installMockFigma();
    setMockEditorType(null);
    expect(opStatus().editorType).toBeNull();
  });
});

describe('opStatus — bootSkipped (issue #3, absorption phase-03)', () => {
  it('no argument → the key is OMITTED, keeping the payload byte-identical to before this field existed', () => {
    installMockFigma();
    expect('bootSkipped' in opStatus()).toBe(false);
  });

  it('an empty array → the key is still OMITTED', () => {
    installMockFigma();
    expect('bootSkipped' in opStatus([])).toBe(false);
  });

  it('a non-empty list surfaces verbatim, as a fresh copy (never the caller\'s own live array)', () => {
    installMockFigma();
    const live = ['variables'];
    const result = opStatus(live);
    expect(result.bootSkipped).toEqual(['variables']);
    live.push('editFeed'); // mutate the caller's array after the call
    expect(result.bootSkipped).toEqual(['variables']); // the reply is unaffected
  });
});

describe('opStatus — readOnlyViolations', () => {
  it('no argument → the key is OMITTED, keeping the payload byte-identical to before this field existed', () => {
    installMockFigma();
    expect('readOnlyViolations' in opStatus()).toBe(false);
  });

  it('zero → the key is still OMITTED, same "present only once meaningful" contract as bootSkipped/senderMismatchCount', () => {
    installMockFigma();
    expect('readOnlyViolations' in opStatus([], 0)).toBe(false);
  });

  it('a non-zero count surfaces verbatim', () => {
    installMockFigma();
    expect(opStatus([], 3).readOnlyViolations).toBe(3);
  });
});

describe('opStatus — the gap-fill block', () => {
  it('no argument → the key is OMITTED (a caller that knows nothing about gap-fill claims nothing)', () => {
    installMockFigma();
    expect('gapfill' in opStatus()).toBe(false);
  });

  it('an all-zero session still reports the block: "no baseline was written" is the fact that must be visible', () => {
    installMockFigma();
    const gapfill = opStatus([], 0, toGapfillStatus(createGapfillStats())).gapfill as Record<string, unknown>;
    expect(gapfill).toEqual({
      pagesDiffed: 0, pagesTruncated: 0, pagesTopLevelOnly: 0, baselineWrittenAt: null, baselineBytes: 0,
    });
  });

  it('the optional counters appear only once they mean something', () => {
    installMockFigma();
    const stats = createGapfillStats();
    stats.pagesDiffed = 21;
    stats.pagesTruncated = 16;
    stats.baselineWrittenAt = '2026-09-03T00:00:00.000Z';
    stats.baselineBytes = 1234;
    stats.legacyCleared = 2;
    recordGapfillEviction(stats, 'figma-edit-baseline-v2:other');
    recordGapfillError(stats, 'first failure');
    recordGapfillError(stats, 'a later, derived failure');

    const gapfill = opStatus([], 0, toGapfillStatus(stats)).gapfill as Record<string, unknown>;

    expect(gapfill).toEqual({
      pagesDiffed: 21,
      pagesTruncated: 16,
      pagesTopLevelOnly: 0, // always present: 0 covered pages is a reading, not an absence
      baselineWrittenAt: '2026-09-03T00:00:00.000Z',
      baselineBytes: 1234,
      legacyCleared: 2,
      baselineEvicted: ['figma-edit-baseline-v2:other'],
      errors: ['first failure'], // the FIRST message — the cause, not the cascade
      errorCount: 2,
    });
  });
});

// The self-emitted-noise counter: how many `documentchange` entries this session dropped as
// the plugin's own bookkeeping echo (a root/DOCUMENT change, or a pluginData-only property
// change). Same present-only-when-meaningful contract as bootSkipped/readOnlyViolations — a
// session that never filtered anything keeps the payload byte-identical to before the field
// existed — but a session that did filter says so, because a dropped change still happened.
describe('opStatus — live-capture counters', () => {
  const captureStats = (over: Partial<DocumentChangeCaptureStats> = {}): DocumentChangeCaptureStats => ({
    pluginDataChangesDropped: 0, sentinelChangesDropped: 0, pageFallbacks: 0, errorCount: 0, firstError: null, ...over,
  });

  it('no argument → every capture key is OMITTED, keeping the payload byte-identical to before they existed', () => {
    installMockFigma();
    const status = opStatus();
    expect('pluginDataChangesDropped' in status).toBe(false);
    expect('sentinelChangesDropped' in status).toBe(false);
    expect('pageFallbacks' in status).toBe(false);
    expect('captureErrors' in status).toBe(false);
  });

  it('an all-zero session → the keys are still OMITTED', () => {
    installMockFigma();
    const status = opStatus([], 0, undefined, captureStats());
    expect('pluginDataChangesDropped' in status).toBe(false);
    expect('sentinelChangesDropped' in status).toBe(false);
    expect('pageFallbacks' in status).toBe(false);
    expect('captureErrors' in status).toBe(false);
  });

  it('a non-zero drop count surfaces verbatim — filtering is never silent', () => {
    installMockFigma();
    expect(opStatus([], 0, undefined, captureStats({ pluginDataChangesDropped: 7 })).pluginDataChangesDropped)
      .toBe(7);
  });

  it('a non-zero sentinel drop count surfaces verbatim, next to pluginDataChangesDropped', () => {
    installMockFigma();
    expect(opStatus([], 0, undefined, captureStats({ sentinelChangesDropped: 3 })).sentinelChangesDropped)
      .toBe(3);
  });

  it('a substituted page surfaces as its own count — a guessed page is never silent', () => {
    installMockFigma();
    expect(opStatus([], 0, undefined, captureStats({ pageFallbacks: 3 })).pageFallbacks).toBe(3);
  });

  it('a correction-store failure surfaces as first message + count, same shape as gapfill errors', () => {
    installMockFigma();
    const status = opStatus([], 0, undefined, captureStats({ errorCount: 4, firstError: 'read refused' }));
    expect(status.captureErrors).toEqual(['read refused']);
    expect(status.captureErrorCount).toBe(4);
  });
});

describe('opStatus — the perf block', () => {
  const perf = {
    bootLoadAllPagesMs: 120, pageLoadAsyncMaxMs: 0, bootWalkMs: 900,
    bootWalkMaxSliceMs: 31, bootSlices: 42, idleWalkMs: 0, idleWalkMaxSliceMs: 0,
  };

  it('no argument → the key is OMITTED, so a boot still in progress never reports a partial total', () => {
    installMockFigma();
    expect('perf' in opStatus([], 0, undefined, undefined, undefined)).toBe(false);
  });

  it('surfaces the walk numbers verbatim once boot has completed, zeros included', () => {
    installMockFigma();
    const result = opStatus([], 0, undefined, undefined, perf);
    expect(result.perf).toEqual(perf); // an idle walk that never ran reads 0, not absent
  });
});

describe('toGapfillStatus — the coverage a session actually delivered', () => {
  it('reports how many oversized pages still reported, next to how many lost their node diff', () => {
    const stats = createGapfillStats();
    stats.pagesTruncated = 16;
    stats.pagesTopLevelOnly = 15;
    const status = toGapfillStatus(stats);
    expect(status.pagesTruncated).toBe(16);
    // The gap between the two is the coverage this session did NOT have — readable rather
    // than inferred from a silence.
    expect(status.pagesTopLevelOnly).toBe(15);
  });

  it('a superseded baseline value deleted is reported; none deleted keeps the payload unchanged', () => {
    const stats = createGapfillStats();
    expect(toGapfillStatus(stats).staleBaselinesCleared).toBeUndefined();
    stats.staleBaselinesCleared = 1;
    expect(toGapfillStatus(stats).staleBaselinesCleared).toBe(1);
  });
});

// The session coverage statement (session-coverage.ts) rides STATUS. Unlike every
// present-only-when-meaningful counter above it is ALWAYS present: an agent is told to
// read `coverage` FIRST on connect, and an absent block there would read as "nothing to
// report" when it actually means "this build could not say". `complete: null` is that
// second sentence, said out loud.
describe('opStatus — the session coverage statement', () => {
  const captureStats = (over: Partial<DocumentChangeCaptureStats> = {}): DocumentChangeCaptureStats => ({
    pluginDataChangesDropped: 0, sentinelChangesDropped: 0, pageFallbacks: 0, errorCount: 0, firstError: null, ...over,
  });
  const perf = {
    bootLoadAllPagesMs: 120, pageLoadAsyncMaxMs: 0, bootWalkMs: 900,
    bootWalkMaxSliceMs: 31, bootSlices: 42, idleWalkMs: 0, idleWalkMaxSliceMs: 0,
  };

  it('is always present — a caller that supplies no feeders claims nothing, out loud', () => {
    installMockFigma();
    expect(opStatus().coverage).toEqual({ complete: null, gaps: [] });
  });

  it('boot still running (no perf block) → null, even with a written baseline and zero gaps', () => {
    installMockFigma();
    const stats = createGapfillStats();
    stats.baselineWrittenAt = '2026-09-04T00:00:00.000Z';
    expect(opStatus([], 0, toGapfillStatus(stats), captureStats()).coverage)
      .toEqual({ complete: null, gaps: [] });
  });

  it('a booted session that DIFFED a prior baseline and lost nothing claims completeness', () => {
    installMockFigma();
    const stats = createGapfillStats();
    stats.pagesDiffed = 4;                                   // a prior baseline was there
    stats.baselineWrittenAt = '2026-09-04T00:00:00.000Z';    // and this session refreshed it
    expect(opStatus([], 0, toGapfillStatus(stats), captureStats(), perf).coverage)
      .toEqual({ complete: true, gaps: [] });
  });

  it('a FIRST-EVER session on a file cannot be complete — it wrote a baseline but diffed none', () => {
    installMockFigma();
    const stats = createGapfillStats();
    stats.baselineFirstRun = true;                           // the `!prev` boot path
    stats.baselineWrittenAt = '2026-09-04T00:00:00.000Z';    // written by that same path
    const coverage = opStatus([], 0, toGapfillStatus(stats), captureStats(), perf).coverage;
    expect(coverage).toEqual({
      complete: false,
      gaps: [{ kind: 'baseline-missing', count: 1, see: 'status.plugin.gapfill' }],
    });
  });

  it('the same session with no baseline written can never be complete, and says which kind', () => {
    installMockFigma();
    const stats = createGapfillStats();
    recordGapfillError(stats, 'page walk failed on "Home"');
    const coverage = opStatus([], 0, toGapfillStatus(stats), captureStats({ pageFallbacks: 2 }), perf)
      .coverage as { complete: boolean | null; gaps: { kind: string; count: number }[] };
    expect(coverage.complete).toBe(false);
    expect(coverage.gaps).toEqual([
      { kind: 'baseline-missing', count: 1, see: 'status.plugin.gapfill' },
      { kind: 'gapfill-errors', count: 1, see: 'status.plugin.gapfill' },
      { kind: 'page-fallbacks', count: 2, see: 'changes' },
    ]);
  });
});
