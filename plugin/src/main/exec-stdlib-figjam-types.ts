// `ui.figjam.*` — pure types + shared constants (absorption phase-03). Split out so
// the content/read/arrange files can all import without a circular dependency, same
// pattern as exec-stdlib-slot-types.ts.
//
// Batch caps (absorbed fact 12) — timeout/DoS guards, not real Figma API limits.
// Ours-by-adoption from the fork (figjam-tools.ts:47-59); `[re-verify]` any a real
// run contradicts (knowledge/figjam.md).
export const MAX_STICKIES_PER_BATCH = 200;
export const MAX_TABLE_ROWS = 100;
export const MAX_TABLE_COLUMNS = 50;
export const MAX_TEXT_CHARS = 5_000;
export const MAX_CODE_BLOCK_CHARS = 50_000;
export const MAX_ARRANGE_NODES = 500;
export const MAX_BOARD_READ_NODES = 1_000;

/** Absorbed fact 2 — sticky colour is a FILL, not an enum property. The fork's own
 * `__stickyColors` map (code.js:78-88), labelled a WORKAROUND, not the API: `[re-verify]`
 * whether Figma now exposes a first-class sticky-colour API (knowledge/figjam.md). */
export const STICKY_COLORS: Record<string, { r: number; g: number; b: number }> = {
  YELLOW: { r: 1, g: 0.85, b: 0.4 },
  BLUE: { r: 0.53, g: 0.78, b: 1 },
  GREEN: { r: 0.55, g: 0.87, b: 0.53 },
  PINK: { r: 1, g: 0.6, b: 0.78 },
  ORANGE: { r: 1, g: 0.71, b: 0.42 },
  PURPLE: { r: 0.78, g: 0.65, b: 1 },
  RED: { r: 1, g: 0.55, b: 0.55 },
  LIGHT_GRAY: { r: 0.9, g: 0.9, b: 0.9 },
  GRAY: { r: 0.7, g: 0.7, b: 0.7 },
};

export interface StickySpec { text: string; color?: string; x?: number; y?: number }
export interface StickyResult { id: string; type: 'STICKY'; name: string; x: number; y: number }

export interface ShapeOpts {
  text?: string; shapeType?: string; x?: number; y?: number; width?: number; height?: number;
  fillColor?: string; strokeColor?: string; fontSize?: number; strokeDashPattern?: number[];
}

export interface SectionOpts { name?: string; x?: number; y?: number; width?: number; height?: number; fillColor?: string }

export interface ArrangeOpts { layout?: 'grid' | 'horizontal' | 'vertical'; spacing?: number; columns?: number }
export interface ArrangeResult { arranged: number; layout: string; skipped: string[] }

export interface BoardOpts { nodeTypes?: string[]; maxNodes?: number }
