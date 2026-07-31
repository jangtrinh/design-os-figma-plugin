// `ui.figjam.table` / `ui.figjam.codeBlock` (absorption phase-03).
import { describe, it, expect } from 'vitest';
import { installMockFigma, setMockEditorType, setMockFontFailure } from './helpers/mock-figma.ts';
import { table, codeBlock } from '../plugin/src/main/exec-stdlib-figjam-table.ts';

describe('ui.figjam.table', () => {
  it('refuses outside FigJam', async () => {
    installMockFigma();
    setMockEditorType('figma');
    await expect(table(2, 2)).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
  });

  it('rejects a table over the row/column cap', async () => {
    installMockFigma();
    setMockEditorType('figjam');
    await expect(table(101, 2)).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
    await expect(table(2, 51)).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
  });

  it('writes cell data and reports cellsWritten', async () => {
    installMockFigma();
    setMockEditorType('figjam');
    const result = await table(3, 3, { data: [['a', 'b', 'c'], ['d', 'e', 'f']] });
    expect(result.rows).toBe(3);
    expect(result.columns).toBe(3);
    expect(result.cellsWritten).toBe(6);
    expect(result.dataRowsIgnored).toBeUndefined();
  });

  it('clamps extra data rows to the declared row count and REPORTS dataRowsIgnored', async () => {
    installMockFigma();
    setMockEditorType('figjam');
    const result = await table(2, 2, { data: [['a', 'b'], ['c', 'd'], ['e', 'f'], ['g', 'h']] });
    expect(result.cellsWritten).toBe(4); // only the first 2 rows
    expect(result.dataRowsIgnored).toBe(2);
  });
});

describe('ui.figjam.codeBlock', () => {
  it('refuses outside FigJam', async () => {
    installMockFigma();
    setMockEditorType('figma');
    await expect(codeBlock('const x = 1;')).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
  });

  it('rejects code over the char cap', async () => {
    installMockFigma();
    setMockEditorType('figjam');
    await expect(codeBlock('x'.repeat(50_001))).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
  });

  it('sets code and language, reading name back', async () => {
    installMockFigma();
    setMockEditorType('figjam');
    const result = await codeBlock('const x = 1;', { language: 'TYPESCRIPT' });
    expect(result.type).toBe('CODE_BLOCK');
    expect(result.name).toBe('Code block');
  });

  it('falls back to Inter Medium when Source Code Pro fails to load, never throwing', async () => {
    installMockFigma();
    setMockEditorType('figjam');
    setMockFontFailure((font) => font.family === 'Source Code Pro');
    await expect(codeBlock('print(1)')).resolves.toMatchObject({ type: 'CODE_BLOCK' });
  });
});
