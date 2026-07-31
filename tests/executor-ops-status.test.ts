// `opStatus()` — editorType (absorption phase-02) + bootSkipped (absorption phase-03).
// bootSkipped follows the broker's own senderMismatchCount/legacyMigrationDeferred
// contract (issue #15/#19): present only once it's actually non-empty, so the common
// case (nothing skipped) keeps the STATUS payload byte-identical to before this field
// existed.
import { describe, it, expect } from 'vitest';
import { installMockFigma, setMockEditorType } from './helpers/mock-figma.ts';
import { opStatus } from '../plugin/src/main/executor-ops.ts';

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
