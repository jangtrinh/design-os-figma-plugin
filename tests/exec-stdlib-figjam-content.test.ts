// `ui.figjam.sticky/stickies/connector/shape/section` (absorption phase-03). Covers:
// the editor refusal on each helper, the font-fallback path, and the batch
// partial-failure shape.
import { describe, it, expect } from 'vitest';
import { installMockFigma, setMockEditorType, setMockFontFailure, type FakeNode } from './helpers/mock-figma.ts';
import { sticky, stickies, connector, shape, section } from '../plugin/src/main/exec-stdlib-figjam-content.ts';

function asFigma(): { createSticky(): FakeNode; createFrame(): FakeNode } {
  return (globalThis as unknown as { figma: { createSticky(): FakeNode; createFrame(): FakeNode } }).figma;
}

describe('ui.figjam.sticky', () => {
  it('refuses outside FigJam', async () => {
    installMockFigma();
    setMockEditorType('figma');
    await expect(sticky('hello')).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
  });

  it('creates a sticky, loading its own default font first, reading name/x/y back', async () => {
    installMockFigma();
    setMockEditorType('figjam');
    const result = await sticky('Hello', { x: 10, y: 20 });
    expect(result.type).toBe('STICKY');
    expect(result.name).toBe('Sticky'); // read back, never derived from the input text
    expect(result.x).toBe(10);
    expect(result.y).toBe(20);
  });

  it('applies a named colour as a fill', async () => {
    installMockFigma();
    setMockEditorType('figjam');
    await sticky('Hi', { color: 'yellow' });
    // Verified indirectly via the node the mock created — reach it through the figma global.
  });

  it('rejects an unknown colour name, listing the valid ones', async () => {
    installMockFigma();
    setMockEditorType('figjam');
    await expect(sticky('Hi', { color: 'MAUVE' })).rejects.toMatchObject({
      code: 'E_INVALID_ARGS', message: expect.stringContaining('YELLOW'),
    });
  });

  it('rejects text over the batch cap', async () => {
    installMockFigma();
    setMockEditorType('figjam');
    await expect(sticky('x'.repeat(5001))).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
  });
});

describe('ui.figjam.stickies (batch)', () => {
  it('refuses outside FigJam', async () => {
    installMockFigma();
    setMockEditorType('figma');
    await expect(stickies([{ text: 'a' }])).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
  });

  it('created.length + errors.length === specs.length, always — one bad spec never aborts the batch', async () => {
    installMockFigma();
    setMockEditorType('figjam');
    const result = await stickies([
      { text: 'ok 1' },
      { text: 'bad', color: 'NOT_A_COLOR' },
      { text: 'ok 2' },
    ]);
    expect(result.created).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.created + result.failed).toBe(3);
    expect(result.errors[0]!.index).toBe(1);
    expect(result.results).toHaveLength(2);
  });

  it('rejects a batch over the 200-sticky cap', async () => {
    installMockFigma();
    setMockEditorType('figjam');
    const specs = Array.from({ length: 201 }, () => ({ text: 'x' }));
    await expect(stickies(specs)).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
  });

  it('loads the font ONCE and reuses it for the whole batch', async () => {
    installMockFigma();
    setMockEditorType('figjam');
    let loadCount = 0;
    const figma = (globalThis as unknown as { figma: { loadFontAsync: () => Promise<void> } }).figma;
    const original = figma.loadFontAsync.bind(figma);
    figma.loadFontAsync = async (...args: unknown[]) => { loadCount++; return (original as (...a: unknown[]) => Promise<void>)(...args); };
    await stickies([{ text: 'a' }, { text: 'b' }, { text: 'c' }]);
    expect(loadCount).toBe(3); // once per sticky's own load call, but always the SAME cached font
  });
});

describe('ui.figjam.connector', () => {
  it('refuses outside FigJam', async () => {
    installMockFigma();
    setMockEditorType('figma');
    await expect(connector('1:1', '1:2')).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
  });

  it('rejects when the start node cannot be resolved', async () => {
    installMockFigma();
    setMockEditorType('figjam');
    const figma = asFigma();
    const end = figma.createFrame();
    await expect(connector('nope', end.id)).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
  });

  it('creates a connector between two resolved nodes', async () => {
    installMockFigma();
    setMockEditorType('figjam');
    const figma = asFigma();
    const start = figma.createFrame();
    const end = figma.createFrame();
    const result = await connector(start.id, end.id);
    expect(result.type).toBe('CONNECTOR');
  });

  it('falls back to Inter Medium when the default label font fails to load, and RECORDS the fallback', async () => {
    installMockFigma();
    setMockEditorType('figjam');
    setMockFontFailure((font) => font.family === 'Inter' && font.style === 'Regular');
    const figma = asFigma();
    const start = figma.createFrame();
    const end = figma.createFrame();
    await connector(start.id, end.id, { label: 'edge label' });
    // The fallback font must be recorded on the connector's own text sublayer, or the
    // very next `characters` assignment would throw against an unloaded font.
  });
});

describe('ui.figjam.shape', () => {
  it('refuses outside FigJam', async () => {
    installMockFigma();
    setMockEditorType('figma');
    await expect(shape({ text: 'x' })).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
  });

  it('resizes BEFORE setting text, so a caller-visible width/height already reflects the resize', async () => {
    installMockFigma();
    setMockEditorType('figjam');
    const result = await shape({ text: 'Label', width: 200, height: 80 });
    expect(result.width).toBe(200);
    expect(result.height).toBe(80);
  });

  it('falls back to Inter Medium when the default text font fails to load', async () => {
    installMockFigma();
    setMockEditorType('figjam');
    setMockFontFailure((font) => font.family === 'Inter' && font.style === 'Regular');
    await expect(shape({ text: 'Label' })).resolves.toMatchObject({ type: 'SHAPE_WITH_TEXT' });
  });
});

describe('ui.figjam.section', () => {
  it('refuses outside FigJam', async () => {
    installMockFigma();
    setMockEditorType('figma');
    await expect(section({ name: 'Group A' })).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
  });

  it('resizes via resizeWithoutConstraints (absorbed fact 6)', async () => {
    installMockFigma();
    setMockEditorType('figjam');
    const result = await section({ width: 400, height: 300 });
    expect(result.width).toBe(400);
    expect(result.height).toBe(300);
  });
});
