// `ui.slides.*` grid + slide-lifecycle helpers (absorption phase-04). Adapted from
// the fork's Slides handlers (MIT; see THIRD-PARTY.md), code.js:6530-6806.
// Reuse, do not re-implement: `requireEditor` (exec-stdlib-editor.ts), `resolveSlide`
// (exec-stdlib-slides-resolve.ts).
import { requireEditor } from './exec-stdlib-editor';
import { withCode } from './executor-styles';
import { resolveSlide } from './exec-stdlib-slides-resolve';
import type { SlideSummary, GridRowSummary } from './exec-stdlib-slides-types';

/** Absorbed fact 1: `figma.getSlideGrid()` returns rows that are array-like —
 * iterate by numeric index; they are not objects with `.children` (the fork's own
 * comment says so twice, code.js:6541, 6729, because they got it wrong once). */
export async function list(): Promise<{ slides: SlideSummary[]; totalSlides: number; totalRows: number }> {
  requireEditor('ui.slides.list', ['slides']);
  const slideGrid = figma.getSlideGrid();
  const slides: SlideSummary[] = [];
  for (let row = 0; row < slideGrid.length; row++) {
    const cols = slideGrid[row]!;
    for (let col = 0; col < cols.length; col++) {
      const slide = cols[col]!;
      slides.push({
        id: slide.id, name: slide.name, row, col,
        isSkippedSlide: slide.isSkippedSlide, childCount: slide.children.length,
      });
    }
  }
  // Honest-reporting rule: totalSlides/totalRows come from the enumeration, never a
  // cached count.
  return { slides, totalSlides: slides.length, totalRows: slideGrid.length };
}

export async function grid(): Promise<{ grid: GridRowSummary[]; totalRows: number }> {
  requireEditor('ui.slides.grid', ['slides']);
  const slideGrid = figma.getSlideGrid();
  const rows: GridRowSummary[] = [];
  for (let row = 0; row < slideGrid.length; row++) {
    const cols = slideGrid[row]!;
    rows.push({
      rowIndex: row,
      slides: cols.map((s, col) => ({ id: s.id, name: s.name, col, isSkippedSlide: s.isSkippedSlide })),
    });
  }
  return { grid: rows, totalRows: rows.length };
}

/** Absorbed fact 8: `create({row, col})` places a slide at a grid position; with no
 * args it appends (code.js:6626-6631). `[re-verify]` what happens when `row`/`col`
 * collide with an existing slide — the fork's code does not say (knowledge/slides.md). */
export async function create(opts: { row?: number; col?: number } = {}): Promise<{ id: string; name: string }> {
  requireEditor('ui.slides.create', ['slides']);
  const slide = typeof opts.row === 'number' && typeof opts.col === 'number'
    ? figma.createSlide(opts.row, opts.col)
    : figma.createSlide();
  return { id: slide.id, name: slide.name };
}

/** Absorbed fact 3: assert `SLIDE` AFTER resolving — ids go stale across sessions. */
export async function remove(slideId: string): Promise<{ deleted: string; name: string }> {
  requireEditor('ui.slides.remove', ['slides']);
  const slide = await resolveSlide(slideId, 'ui.slides.remove');
  const name = slide.name;
  slide.remove();
  return { deleted: slideId, name };
}

/**
 * Uses `.clone()`, not a distinct `duplicate()` (team-lead ruling, phase-04
 * re-anchor): the full `SlideNode` property list pulled directly from
 * developers.figma.com/docs/plugins/api/SlideNode/ shows only `clone(): SlideNode`.
 * `[re-verify]`: a distinct `duplicate()` may exist in the live typings with
 * different semantics (deep vs shallow, transition-preserving) — unconfirmed against
 * live typings, see knowledge/slides.md; a real one showing up is a follow-up issue,
 * not a blocker on this phase.
 */
export async function duplicate(slideId: string): Promise<{ originalId: string; newId: string; name: string }> {
  requireEditor('ui.slides.duplicate', ['slides']);
  const slide = await resolveSlide(slideId, 'ui.slides.duplicate');
  const clone = slide.clone();
  return { originalId: slideId, newId: clone.id, name: clone.name };
}

/**
 * Absorbed fact 2: `setSlideGrid` takes SlideNode references, not ids — a lookup is
 * built from the CURRENT grid and the caller's id grid mapped through it, throwing on
 * any id absent from the current grid (fork's own check, code.js:6763-6788). THIS
 * REPO'S OWN ADDITION, not the fork's: also refuse a grid that drops or duplicates a
 * slide — the fork accepts a grid missing slides, which would silently reorganise the
 * deck. Counts in vs out and refuses a mismatch, naming the missing/duplicated ids.
 */
export async function reorder(gridOfIds: readonly string[][]): Promise<{ rows: number; grid: string[][] }> {
  requireEditor('ui.slides.reorder', ['slides']);
  const currentGrid = figma.getSlideGrid();
  const slideMap = new Map<string, SlideNode>();
  const currentIds: string[] = [];
  for (const row of currentGrid) {
    for (const slide of row) {
      slideMap.set(slide.id, slide);
      currentIds.push(slide.id);
    }
  }

  const inputIds = gridOfIds.flat();
  const inputSeen = new Set<string>();
  const duplicated = new Set<string>();
  const missing: string[] = [];
  for (const id of inputIds) {
    if (inputSeen.has(id)) duplicated.add(id);
    inputSeen.add(id);
    if (!slideMap.has(id)) missing.push(id);
  }
  const dropped = currentIds.filter((id) => !inputSeen.has(id));

  if (missing.length > 0 || duplicated.size > 0 || dropped.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`unknown ids: ${missing.join(', ')}`);
    if (duplicated.size > 0) parts.push(`duplicated ids: ${[...duplicated].join(', ')}`);
    if (dropped.length > 0) parts.push(`missing ids (would silently reorganise the deck): ${dropped.join(', ')}`);
    throw withCode(
      new Error(`ui.slides.reorder: grid does not match the current deck exactly — ${parts.join('; ')}`),
      'E_INVALID_ARGS',
    );
  }

  const reorderedRows: SlideNode[][] = gridOfIds.map((row) => row.map((id) => slideMap.get(id)!));
  figma.setSlideGrid(reorderedRows);

  // Honest-reporting rule: the grid returned is read back off getSlideGrid(), never
  // the caller's own input.
  const after = figma.getSlideGrid();
  return { rows: after.length, grid: after.map((row) => row.map((s) => s.id)) };
}
