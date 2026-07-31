// `ui.slides.*` (absorption phase-04). Covers: editor refusal on every helper, the
// array-like grid iteration (fact 1), reorder's grid-integrity refusals (this repo's
// own addition, not the fork's), the SLIDE type assertion refusing a non-SLIDE node,
// transition-enum validation, focus()'s view-mode-first ordering, background()'s
// real setFillsAsync (not a rectangle workaround), and the single-slide-view
// default-parenting trap addText/addShape must not fall into.
import { describe, it, expect } from 'vitest';
import { installMockFigma, setMockEditorType, type FakeNode } from './helpers/mock-figma.ts';
import { list, grid, create, remove, duplicate, reorder } from '../plugin/src/main/exec-stdlib-slides-crud.ts';
import {
  setTransition, transition, viewMode, focused, focus, skip,
} from '../plugin/src/main/exec-stdlib-slides-view.ts';
import { background, addText, addShape, content } from '../plugin/src/main/exec-stdlib-slides-content.ts';

function asFigma(): {
  createSlide(row?: number, col?: number): FakeNode;
  createFrame(): FakeNode;
  currentPage: FakeNode;
  viewport: { slidesView: 'grid' | 'single-slide' };
} {
  return (globalThis as unknown as {
    figma: {
      createSlide(row?: number, col?: number): FakeNode; createFrame(): FakeNode;
      currentPage: FakeNode; viewport: { slidesView: 'grid' | 'single-slide' };
    };
  }).figma;
}

describe('ui.slides.* — editor refusal', () => {
  it('every helper refuses outside Slides', async () => {
    installMockFigma();
    setMockEditorType('figma');
    await expect(list()).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
    await expect(grid()).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
    await expect(create()).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
    await expect(remove('x')).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
    await expect(duplicate('x')).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
    await expect(reorder([])).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
    await expect(setTransition('x', { style: 'NONE', duration: 0.3, curve: 'LINEAR' }))
      .rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
    await expect(transition('x')).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
    await expect(viewMode('grid')).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
    await expect(focused()).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
    await expect(focus('x')).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
    await expect(skip('x', true)).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
    await expect(background('x', '#ffffff')).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
    await expect(addText('x', { text: 'hi' })).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
    await expect(addShape('x')).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
    await expect(content('x')).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
  });
});

describe('ui.slides.list / grid — fact 1: array-like grid iteration', () => {
  it('reports row/col from getSlideGrid()\'s own array-like rows, not `.children`', async () => {
    installMockFigma();
    setMockEditorType('slides');
    const figma = asFigma();
    figma.createSlide(0, 0);
    figma.createSlide(0, 1);
    figma.createSlide(1, 0);
    const result = await list();
    expect(result.totalSlides).toBe(3);
    expect(result.totalRows).toBe(2);
    expect(result.slides).toContainEqual(expect.objectContaining({ row: 0, col: 0 }));
    expect(result.slides).toContainEqual(expect.objectContaining({ row: 0, col: 1 }));
    expect(result.slides).toContainEqual(expect.objectContaining({ row: 1, col: 0 }));

    const g = await grid();
    expect(g.totalRows).toBe(2);
    expect(g.grid[0]!.slides).toHaveLength(2);
    expect(g.grid[1]!.slides).toHaveLength(1);
  });
});

describe('ui.slides.create', () => {
  it('appends to the last row with no args', async () => {
    installMockFigma();
    setMockEditorType('slides');
    const figma = asFigma();
    figma.createSlide();
    figma.createSlide();
    const g = await grid();
    expect(g.totalRows).toBe(1);
    expect(g.grid[0]!.slides).toHaveLength(2);
  });

  it('places a slide at an explicit row/col', async () => {
    installMockFigma();
    setMockEditorType('slides');
    await create({ row: 2, col: 0 });
    const g = await grid();
    expect(g.totalRows).toBe(3);
    expect(g.grid[2]!.slides).toHaveLength(1);
  });
});

describe('ui.slides.remove / duplicate — SLIDE type assertion', () => {
  it('refuses a non-SLIDE node, naming the type found', async () => {
    installMockFigma();
    setMockEditorType('slides');
    const figma = asFigma();
    const frame = figma.createFrame();
    await expect(remove(frame.id)).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
    await expect(remove(frame.id)).rejects.toThrow(/is a FRAME, not a SLIDE/);
    await expect(duplicate(frame.id)).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
  });

  it('remove() deletes the slide from the grid', async () => {
    installMockFigma();
    setMockEditorType('slides');
    const figma = asFigma();
    const slide = figma.createSlide();
    const result = await remove(slide.id);
    expect(result).toEqual({ deleted: slide.id, name: slide.name });
  });

  it('duplicate() uses clone() — a new id, same shape, original untouched', async () => {
    installMockFigma();
    setMockEditorType('slides');
    const figma = asFigma();
    const slide = figma.createSlide();
    const result = await duplicate(slide.id);
    expect(result.originalId).toBe(slide.id);
    expect(result.newId).not.toBe(slide.id);
    expect(result.name).toBe(slide.name);
  });
});

describe('ui.slides.reorder — grid-integrity refusals (this repo\'s own addition)', () => {
  it('refuses an unknown id', async () => {
    installMockFigma();
    setMockEditorType('slides');
    const figma = asFigma();
    figma.createSlide();
    await expect(reorder([['nonexistent']])).rejects.toThrow(/unknown ids: nonexistent/);
  });

  it('refuses a duplicated id', async () => {
    installMockFigma();
    setMockEditorType('slides');
    const figma = asFigma();
    const a = figma.createSlide();
    const b = figma.createSlide();
    await expect(reorder([[a.id, a.id], [b.id]])).rejects.toThrow(/duplicated ids/);
  });

  it('refuses a grid that DROPS a slide — the fork accepts this silently, we do not', async () => {
    installMockFigma();
    setMockEditorType('slides');
    const figma = asFigma();
    const a = figma.createSlide();
    figma.createSlide();
    await expect(reorder([[a.id]])).rejects.toThrow(/missing ids \(would silently reorganise the deck\)/);
  });

  it('accepts a full, exact reorder and reads the new grid back off getSlideGrid()', async () => {
    installMockFigma();
    setMockEditorType('slides');
    const figma = asFigma();
    const a = figma.createSlide();
    const b = figma.createSlide();
    const result = await reorder([[b.id], [a.id]]);
    expect(result.rows).toBe(2);
    expect(result.grid).toEqual([[b.id], [a.id]]);
  });
});

describe('ui.slides.setTransition / transition — enum validation', () => {
  it('refuses an unknown style, naming the valid set', async () => {
    installMockFigma();
    setMockEditorType('slides');
    const figma = asFigma();
    const slide = figma.createSlide();
    await expect(setTransition(slide.id, { style: 'TELEPORT', duration: 0.3, curve: 'LINEAR' }))
      .rejects.toThrow(/unknown style "TELEPORT" — valid: NONE, DISSOLVE/);
  });

  it('refuses an unknown curve', async () => {
    installMockFigma();
    setMockEditorType('slides');
    const figma = asFigma();
    const slide = figma.createSlide();
    await expect(setTransition(slide.id, { style: 'NONE', duration: 0.3, curve: 'BOUNCE_HOUSE' }))
      .rejects.toThrow(/unknown curve/);
  });

  it('sets a valid transition, defaults timing to ON_CLICK, reads back via getSlideTransition()', async () => {
    installMockFigma();
    setMockEditorType('slides');
    const figma = asFigma();
    const slide = figma.createSlide();
    const result = await setTransition(slide.id, { style: 'DISSOLVE', duration: 0.5, curve: 'EASE_IN' });
    expect(result.transition).toMatchObject({ style: 'DISSOLVE', duration: 0.5, curve: 'EASE_IN', timing: { type: 'ON_CLICK' } });
    const read = await transition(slide.id);
    expect(read.transition).toEqual(result.transition);
  });
});

describe('ui.slides.viewMode / focused / focus / skip', () => {
  it('viewMode refuses an unknown mode and reads back', async () => {
    installMockFigma();
    setMockEditorType('slides');
    await expect(viewMode('carousel' as never)).rejects.toThrow(/unknown mode/);
    const result = await viewMode('single-slide');
    expect(result.mode).toBe('single-slide');
  });

  it('focused() reports {focused: null} rather than inventing the first slide', async () => {
    installMockFigma();
    setMockEditorType('slides');
    const figma = asFigma();
    figma.createSlide();
    const result = await focused();
    expect(result).toEqual({ focused: null });
  });

  it('focus() sets single-slide view FIRST, then focusedSlide, and reports the viewMode it caused', async () => {
    installMockFigma();
    setMockEditorType('slides');
    const figma = asFigma();
    figma.viewport.slidesView = 'grid';
    const slide = figma.createSlide();
    const result = await focus(slide.id);
    expect(result).toEqual({ focused: slide.id, name: slide.name, viewMode: 'single-slide' });
    expect(figma.viewport.slidesView).toBe('single-slide');
    const nowFocused = await focused();
    expect(nowFocused).toEqual({ id: slide.id, name: slide.name });
  });

  it('skip() toggles isSkippedSlide and reads back', async () => {
    installMockFigma();
    setMockEditorType('slides');
    const figma = asFigma();
    const slide = figma.createSlide();
    const result = await skip(slide.id, true);
    expect(result).toEqual({ id: slide.id, isSkippedSlide: true });
  });
});

describe('ui.slides.background — real setFillsAsync, not a rectangle workaround', () => {
  it('sets the fill directly on the slide — no RECTANGLE child created', async () => {
    installMockFigma();
    setMockEditorType('slides');
    const figma = asFigma();
    const slide = figma.createSlide();
    const result = await background(slide.id, '#112233');
    expect(result.method).toBe('slide-fill');
    expect(result.updated).toBe(false); // no prior fill
    expect(slide.children).toHaveLength(0); // no Background rectangle, ever
    expect(slide.fills).toEqual([{ type: 'SOLID', color: { r: 17 / 255, g: 34 / 255, b: 51 / 255 } }]);
  });

  it('reports updated:true when a fill already existed', async () => {
    installMockFigma();
    setMockEditorType('slides');
    const figma = asFigma();
    const slide = figma.createSlide();
    await background(slide.id, '#000000');
    const second = await background(slide.id, '#ffffff');
    expect(second.updated).toBe(true);
  });
});

describe('ui.slides.addText / addShape — the single-slide-view default-parenting trap', () => {
  it('addText lands on the TARGET slide, not the default-parented FOCUSED slide', async () => {
    installMockFigma();
    setMockEditorType('slides');
    const figma = asFigma();
    const target = figma.createSlide();
    const focusedElsewhere = figma.createSlide();
    figma.viewport.slidesView = 'single-slide';
    figma.currentPage.focusedSlide = focusedElsewhere;
    // Real Figma would default-parent a fresh createText() under `focusedElsewhere` —
    // the mock reproduces that. addText must still land the node on `target`.
    const result = await addText(target.id, { text: 'Hello' });
    expect(target.children.map((c) => c.id)).toContain(result.id);
    expect(focusedElsewhere.children).toHaveLength(0);
  });

  it('addShape lands on the TARGET slide under the same trap', async () => {
    installMockFigma();
    setMockEditorType('slides');
    const figma = asFigma();
    const target = figma.createSlide();
    const focusedElsewhere = figma.createSlide();
    figma.viewport.slidesView = 'single-slide';
    figma.currentPage.focusedSlide = focusedElsewhere;
    const result = await addShape(target.id, { shapeType: 'ELLIPSE' });
    expect(target.children.map((c) => c.id)).toContain(result.id);
    expect(focusedElsewhere.children).toHaveLength(0);
  });

  it('addShape refuses an unknown shapeType', async () => {
    installMockFigma();
    setMockEditorType('slides');
    const figma = asFigma();
    const slide = figma.createSlide();
    await expect(addShape(slide.id, { shapeType: 'TRIANGLE' as never })).rejects.toThrow(/unknown shapeType/);
  });

  it('addText refuses text over the char cap', async () => {
    installMockFigma();
    setMockEditorType('slides');
    const figma = asFigma();
    const slide = figma.createSlide();
    await expect(addText(slide.id, { text: 'x'.repeat(10_001) })).rejects.toThrow(/exceeds 10000 chars/);
  });
});

describe('ui.slides.content — our serializer, not the fork\'s 7-field flat one', () => {
  it('serializes a slide\'s content, children included', async () => {
    installMockFigma();
    setMockEditorType('slides');
    const figma = asFigma();
    const slide = figma.createSlide();
    await addText(slide.id, { text: 'On this slide' });
    const result = await content(slide.id) as { id: string; type: string; children?: unknown[] };
    expect(result.type).toBe('SLIDE');
    expect(result.children).toHaveLength(1);
  });
});
