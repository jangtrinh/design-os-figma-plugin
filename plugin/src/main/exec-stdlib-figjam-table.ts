// `ui.figjam.table` / `ui.figjam.codeBlock` — split out of exec-stdlib-figjam-content.ts
// to stay under the 200-line cap (absorption phase-03). Adapted from the fork's
// handlers (MIT; see THIRD-PARTY.md), code.js:6275-6317.
import { requireEditor } from './exec-stdlib-editor';
import { withCode } from './executor-styles';
import { MAX_TABLE_ROWS, MAX_TABLE_COLUMNS, MAX_CODE_BLOCK_CHARS } from './exec-stdlib-figjam-types';

const FALLBACK_FONT: FontName = { family: 'Inter', style: 'Medium' };

export async function table(
  rows: number, columns: number, opts: { data?: string[][]; x?: number; y?: number } = {},
): Promise<{ id: string; type: 'TABLE'; name: string; rows: number; columns: number; cellsWritten: number; dataRowsIgnored?: number }> {
  requireEditor('ui.figjam.table', ['figjam']);
  if (rows > MAX_TABLE_ROWS || columns > MAX_TABLE_COLUMNS) {
    throw withCode(new Error(`table ${rows}x${columns} exceeds the cap of ${MAX_TABLE_ROWS}x${MAX_TABLE_COLUMNS}`), 'E_INVALID_ARGS');
  }
  const node = figma.createTable(rows, columns);
  if (typeof opts.x === 'number') node.x = opts.x;
  if (typeof opts.y === 'number') node.y = opts.y;

  let cellsWritten = 0;
  let dataRowsIgnored = 0;
  if (opts.data) {
    // Absorbed fact 7: hoist the font load — every cell shares the default font
    // `[re-verify]` — the fork's loop loads per cell; loading once from the FIRST
    // cell touched and reusing is the same 200x-class saving as the sticky batch.
    let cellFont: FontName | null = null;
    for (let r = 0; r < opts.data.length; r++) {
      if (r >= rows) { dataRowsIgnored++; continue; } // clamp to declared rows, report it
      const row = opts.data[r]!;
      for (let c = 0; c < row.length && c < columns; c++) {
        const cell = node.cellAt(r, c);
        if (!cellFont) cellFont = cell.text.fontName as FontName;
        await figma.loadFontAsync(cellFont);
        cell.text.characters = row[c] ?? '';
        cellsWritten++;
      }
    }
  }
  return {
    id: node.id, type: 'TABLE', name: node.name, rows: node.numRows, columns: node.numColumns,
    cellsWritten, ...(dataRowsIgnored > 0 && { dataRowsIgnored }),
  };
}

export async function codeBlock(
  code: string, opts: { language?: string; x?: number; y?: number } = {},
): Promise<{ id: string; type: 'CODE_BLOCK'; name: string; x: number; y: number }> {
  requireEditor('ui.figjam.codeBlock', ['figjam']);
  if (code.length > MAX_CODE_BLOCK_CHARS) {
    throw withCode(new Error(`code block exceeds ${MAX_CODE_BLOCK_CHARS} chars (batch cap)`), 'E_INVALID_ARGS');
  }
  const node = figma.createCodeBlock();
  // Absorbed fact 8: Source Code Pro Medium, falling back to Inter Medium. CodeBlockNode
  // has no `fontName` property of its own to set — this only loads the font Figma
  // needs to render `.code`, never assigns anything back onto the node.
  try {
    await figma.loadFontAsync({ family: 'Source Code Pro', style: 'Medium' });
  } catch {
    await figma.loadFontAsync(FALLBACK_FONT);
  }
  node.code = code;
  if (opts.language) {
    // `codeLanguage` is a string on the wire, not a validated enum on the fork's side
    // either (absorbed fact 9) — pass through; an unknown value degrades silently on
    // Figma's own side `[re-verify]` (knowledge/figjam.md), not something this helper
    // can detect without a canvas-confirmed language list.
    node.codeLanguage = opts.language as CodeBlockNode['codeLanguage'];
  }
  if (typeof opts.x === 'number') node.x = opts.x;
  if (typeof opts.y === 'number') node.y = opts.y;
  return { id: node.id, type: 'CODE_BLOCK', name: node.name, x: node.x, y: node.y };
}
