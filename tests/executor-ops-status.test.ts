// `opStatus()` — editorType (absorption phase-02) + bootSkipped (absorption phase-03).
// bootSkipped follows the broker's own senderMismatchCount/legacyMigrationDeferred
// contract (issue #15/#19): present only once it's actually non-empty, so the common
// case (nothing skipped) keeps the STATUS payload byte-identical to before this field
// existed.
import { describe, it, expect } from 'vitest';
import { installMockFigma, setMockEditorType } from './helpers/mock-figma.ts';
import { opStatus } from '../plugin/src/main/executor-ops.ts';
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
    expect(gapfill).toEqual({ pagesDiffed: 0, pagesTruncated: 0, baselineWrittenAt: null, baselineBytes: 0 });
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
      baselineWrittenAt: '2026-09-03T00:00:00.000Z',
      baselineBytes: 1234,
      legacyCleared: 2,
      baselineEvicted: ['figma-edit-baseline-v2:other'],
      errors: ['first failure'], // the FIRST message — the cause, not the cascade
      errorCount: 2,
    });
  });
});
