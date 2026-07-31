// `ui.slides.*` view + slide-state helpers (absorption phase-04): transitions, grid/
// single-slide view, focus, skip. Adapted from the fork's Slides handlers (MIT; see
// THIRD-PARTY.md), code.js:6808-6999.
import { requireEditor } from './exec-stdlib-editor';
import { withCode } from './executor-styles';
import { resolveSlide } from './exec-stdlib-slides-resolve';
import {
  TRANSITION_STYLES, TRANSITION_CURVES, TIMING_TYPES, type TransitionConfig,
} from './exec-stdlib-slides-types';

/** Absorbed fact 5: the valid style/curve/timing vocabularies are not in the fork's
 * plugin code — validate against them and refuse an unknown value naming the valid
 * set, rather than trusting Figma to silently ignore an invented one. */
function assertTransition(t: TransitionConfig, capability: string): void {
  if (!(TRANSITION_STYLES as readonly string[]).includes(t.style)) {
    throw withCode(new Error(`${capability}: unknown style "${t.style}" — valid: ${TRANSITION_STYLES.join(', ')}`), 'E_INVALID_ARGS');
  }
  if (!(TRANSITION_CURVES as readonly string[]).includes(t.curve)) {
    throw withCode(new Error(`${capability}: unknown curve "${t.curve}" — valid: ${TRANSITION_CURVES.join(', ')}`), 'E_INVALID_ARGS');
  }
  if (t.timing && !(TIMING_TYPES as readonly string[]).includes(t.timing.type)) {
    throw withCode(new Error(`${capability}: unknown timing.type "${t.timing.type}" — valid: ${TIMING_TYPES.join(', ')}`), 'E_INVALID_ARGS');
  }
}

export async function setTransition(
  slideId: string,
  opts: { style: string; duration: number; curve: string; timing?: { type: string; delay?: number } },
): Promise<{ id: string; transition: SlideTransition }> {
  requireEditor('ui.slides.setTransition', ['slides']);
  const slide = await resolveSlide(slideId, 'ui.slides.setTransition');
  // Absorbed fact 5: default timing is {type:'ON_CLICK'} (code.js:6820-6829).
  const config = { ...opts, timing: opts.timing ?? { type: 'ON_CLICK' as const } } as TransitionConfig;
  assertTransition(config, 'ui.slides.setTransition');
  slide.setSlideTransition(config as SlideTransition);
  // Honest-reporting rule: read back via getSlideTransition(), never the input.
  return { id: slideId, transition: slide.getSlideTransition() };
}

export async function transition(slideId: string): Promise<{ id: string; transition: SlideTransition }> {
  requireEditor('ui.slides.transition', ['slides']);
  const slide = await resolveSlide(slideId, 'ui.slides.transition');
  return { id: slideId, transition: slide.getSlideTransition() };
}

const VIEW_MODES = ['grid', 'single-slide'] as const;

export async function viewMode(mode: 'grid' | 'single-slide'): Promise<{ mode: string }> {
  requireEditor('ui.slides.viewMode', ['slides']);
  if (!(VIEW_MODES as readonly string[]).includes(mode)) {
    throw withCode(new Error(`ui.slides.viewMode: unknown mode "${mode}" — valid: ${VIEW_MODES.join(', ')}`), 'E_INVALID_ARGS');
  }
  figma.viewport.slidesView = mode;
  // Honest-reporting rule: read back, never echo the input.
  return { mode: figma.viewport.slidesView };
}

/** Absorbed fact 7: `focusedSlide` may be null — report `{focused: null}` rather
 * than inventing the first slide (code.js:6915-6916). */
export async function focused(): Promise<{ id: string; name: string } | { focused: null }> {
  requireEditor('ui.slides.focused', ['slides']);
  const slide = figma.currentPage.focusedSlide;
  return slide ? { id: slide.id, name: slide.name } : { focused: null };
}

/** Absorbed fact 6: focusing a slide requires single-slide view FIRST — the fork sets
 * the view mode and THEN assigns `focusedSlide` (code.js:6948-6949); preserved here in
 * the same order, and the reply reports the `viewMode` it caused as a side effect —
 * per §2's own classification, this navigation is NOT undoable by `--undo-group`. */
export async function focus(slideId: string): Promise<{ focused: string; name: string; viewMode: string }> {
  requireEditor('ui.slides.focus', ['slides']);
  const slide = await resolveSlide(slideId, 'ui.slides.focus');
  figma.viewport.slidesView = 'single-slide';
  figma.currentPage.focusedSlide = slide;
  return { focused: slide.id, name: slide.name, viewMode: figma.viewport.slidesView };
}

/** Absorbed fact 4: `isSkippedSlide` is a plain assignable boolean (code.js:6981). */
export async function skip(slideId: string, doSkip: boolean): Promise<{ id: string; isSkippedSlide: boolean }> {
  requireEditor('ui.slides.skip', ['slides']);
  const slide = await resolveSlide(slideId, 'ui.slides.skip');
  slide.isSkippedSlide = !!doSkip;
  return { id: slide.id, isSkippedSlide: slide.isSkippedSlide };
}
