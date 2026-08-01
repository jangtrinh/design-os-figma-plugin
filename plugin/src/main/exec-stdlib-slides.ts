// `ui.slides.*` — Figma Slides capabilities (absorption phase-04, the last phase of
// the capability-absorption track). Adapted from the fork's Slides handlers (MIT;
// see THIRD-PARTY.md), code.js:6530-7220, slides-tools.ts:8-63. Split across four
// files (this one plus -types/-resolve/-crud/-view/-content) so each concern reads on
// its own — same split-by-shape precedent as exec-stdlib-figjam.ts.
import { list, grid, create, remove, duplicate, reorder } from './exec-stdlib-slides-crud';
import { setTransition, transition, viewMode, focused, focus, skip } from './exec-stdlib-slides-view';
import { background, addText, addShape, content } from './exec-stdlib-slides-content';

export interface ExecStdlibSlides {
  list: typeof list;
  grid: typeof grid;
  content: typeof content;
  create: typeof create;
  remove: typeof remove;
  duplicate: typeof duplicate;
  reorder: typeof reorder;
  setTransition: typeof setTransition;
  transition: typeof transition;
  viewMode: typeof viewMode;
  focused: typeof focused;
  focus: typeof focus;
  skip: typeof skip;
  background: typeof background;
  addText: typeof addText;
  addShape: typeof addShape;
}

export function createExecStdlibSlides(): ExecStdlibSlides {
  return {
    list, grid, content, create, remove, duplicate, reorder,
    setTransition, transition, viewMode, focused, focus, skip,
    background, addText, addShape,
  };
}
