// `ui.slides.*` — pure types + shared constants (absorption phase-04). Split out so
// the crud/view/content files can all import without a circular dependency, same
// pattern as exec-stdlib-figjam-types.ts.
//
// Size/length caps — timeout/DoS guards, not real Figma API limits. Adopted from the
// fork's own guards (slides-tools.ts:7-12); `[re-verify]` any a real run contradicts
// (knowledge/slides.md).
export const MAX_TEXT_CHARS = 10_000;
export const MAX_FONT_SIZE = 1_000;
export const MAX_DIMENSION = 10_000;

/**
 * SlideTransition's `style` union — verified directly against the current Plugin API
 * docs (developers.figma.com/docs/plugins/api/SlideTransition/, re-fetched with a
 * targeted query after a looser summary of a different page suggested a value —
 * "EASE_IN_AND_OUT_BACK" — this exact list does NOT contain; see knowledge/slides.md
 * for that resolution), cross-checked against the fork's own zod enum
 * (slides-tools.ts:19-43): the two agree exactly, 23 values, nothing to flag.
 */
export const TRANSITION_STYLES = [
  'NONE', 'DISSOLVE',
  'SLIDE_FROM_LEFT', 'SLIDE_FROM_RIGHT', 'SLIDE_FROM_TOP', 'SLIDE_FROM_BOTTOM',
  'PUSH_FROM_LEFT', 'PUSH_FROM_RIGHT', 'PUSH_FROM_TOP', 'PUSH_FROM_BOTTOM',
  'MOVE_FROM_LEFT', 'MOVE_FROM_RIGHT', 'MOVE_FROM_TOP', 'MOVE_FROM_BOTTOM',
  'SLIDE_OUT_TO_LEFT', 'SLIDE_OUT_TO_RIGHT', 'SLIDE_OUT_TO_TOP', 'SLIDE_OUT_TO_BOTTOM',
  'MOVE_OUT_TO_LEFT', 'MOVE_OUT_TO_RIGHT', 'MOVE_OUT_TO_TOP', 'MOVE_OUT_TO_BOTTOM',
  'SMART_ANIMATE',
] as const;

/** SlideTransition's `curve` union — same source + cross-check as `TRANSITION_STYLES`. */
export const TRANSITION_CURVES = [
  'LINEAR', 'EASE_IN', 'EASE_OUT', 'EASE_IN_AND_OUT', 'GENTLE', 'QUICK', 'BOUNCY', 'SLOW',
] as const;

export const TIMING_TYPES = ['ON_CLICK', 'AFTER_DELAY'] as const;

export interface TransitionConfig {
  style: typeof TRANSITION_STYLES[number];
  duration: number;
  curve: typeof TRANSITION_CURVES[number];
  timing?: { type: typeof TIMING_TYPES[number]; delay?: number };
}

export interface SlideSummary {
  id: string; name: string; row: number; col: number; isSkippedSlide: boolean; childCount: number;
}

export interface GridRowSummary {
  rowIndex: number;
  slides: Array<{ id: string; name: string; col: number; isSkippedSlide: boolean }>;
}

export interface AddTextOpts {
  text: string; x?: number; y?: number;
  fontFamily?: string; fontStyle?: string; fontSize?: number;
  color?: string; textAlign?: string; width?: number;
  lineHeight?: number; letterSpacing?: number; textCase?: string;
}

export interface AddShapeOpts {
  shapeType?: 'RECTANGLE' | 'ELLIPSE'; x?: number; y?: number;
  width?: number; height?: number; color?: string;
}
