import { beforeEach, describe, expect, it, vi } from 'vitest';

const effects = vi.hoisted(() => ({
  resetWarnings: vi.fn(),
  resetKeyedVariables: vi.fn(),
  createColorStyles: vi.fn(async () => new Map()),
  createTextStyles: vi.fn(async () => undefined),
  createEffectStyles: vi.fn(async () => undefined),
  resolveTokenVars: vi.fn(async () => new Map()),
  createFigmaNode: vi.fn(async () => ({ id: '2:1', name: 'Card', width: 100, height: 50, x: 0, y: 0 })),
}));

vi.mock('../plugin/src/main/executor-styles.ts', () => ({
  resetImportWarnings: effects.resetWarnings,
  getImportWarnings: () => [],
  createColorStyles: effects.createColorStyles,
  createTextStyles: effects.createTextStyles,
  createEffectStyles: effects.createEffectStyles,
}));
vi.mock('../plugin/src/main/executor-keyed-vars.ts', () => ({
  resetKeyedVariableCache: effects.resetKeyedVariables,
}));
vi.mock('../plugin/src/main/executor-token-var-resolve.ts', () => ({
  resolveTokenVars: effects.resolveTokenVars,
}));
vi.mock('../plugin/src/main/executor-frame.ts', () => ({ createFigmaNode: effects.createFigmaNode }));

import { importPayload } from '../plugin/src/main/import-payload-admission.ts';

const valid = () => ({
  version: 1 as const,
  name: 'Card',
  width: 100,
  height: 50,
  tokens: { colors: [], typography: [], spacing: [], radii: [], shadows: [] },
  rootNode: { type: 'FRAME', name: 'Card' },
});

function mutationSpies() {
  return [
    effects.resetWarnings,
    effects.resetKeyedVariables,
    effects.createColorStyles,
    effects.createTextStyles,
    effects.createEffectStyles,
    effects.resolveTokenVars,
    effects.createFigmaNode,
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  const currentPage = { appendChild: vi.fn(), selection: [] };
  vi.stubGlobal('figma', {
    currentPage,
    viewport: { center: { x: 200, y: 100 }, scrollAndZoomIntoView: vi.fn() },
    getNodeByIdAsync: vi.fn(async () => null),
    notify: vi.fn(),
  });
});

describe('main IMPORT_PAYLOAD owning boundary', () => {
  it.each([
    ['direct', () => ({ ...valid(), rootNode: { type: 'FRAME', name: 'bad', layoutMode: 'NOT_A_LAYOUT' } })],
    ['wrapped', () => ({ payload: { ...valid(), rootNode: { type: 'FRAME', name: 'bad', counterAxisSpacing: {} } } })],
  ])('refuses malformed %s input before every import side effect', async (_label, makeParams) => {
    await expect(importPayload(makeParams())).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
    for (const spy of mutationSpies()) expect(spy).not.toHaveBeenCalled();
    expect(figma.currentPage.appendChild).not.toHaveBeenCalled();
    expect(figma.getNodeByIdAsync).not.toHaveBeenCalled();
    expect(figma.notify).not.toHaveBeenCalled();
  });

  it('normalizes partial tokens and preserves placement through the production importer', async () => {
    const input = valid();
    input.tokens = { colors: [] } as typeof input.tokens;
    await expect(importPayload({ payload: input, x: 17, y: 23 })).resolves.toMatchObject({ id: '2:1', name: 'Card' });
    expect(effects.createTextStyles).toHaveBeenCalledWith([]);
    expect(effects.createEffectStyles).toHaveBeenCalledWith([]);
    expect(effects.createFigmaNode).toHaveBeenCalledOnce();
    expect(figma.currentPage.appendChild).toHaveBeenCalledOnce();
    expect(effects.createFigmaNode.mock.results[0].value).resolves.toMatchObject({ x: 17, y: 23 });
  });

  it('keeps legacy null token input canonical before invoking import consumers', async () => {
    for (const tokens of [null, { colors: null, typography: null, shadows: null }]) {
      await expect(importPayload({ payload: { ...valid(), tokens } })).resolves.toMatchObject({ id: '2:1' });
      expect(effects.createColorStyles).toHaveBeenLastCalledWith([]);
      expect(effects.createTextStyles).toHaveBeenLastCalledWith([]);
      expect(effects.createEffectStyles).toHaveBeenLastCalledWith([]);
      expect(effects.resolveTokenVars).toHaveBeenLastCalledWith({ colors: [], typography: [], spacing: [], radii: [], shadows: [] });
    }
  });
});
