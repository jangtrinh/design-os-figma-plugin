// es-figma-craft gate-authoring guide + scoped-gate template. The template is a
// doc/example that is never run on a canvas; here it runs only against a fake
// `figma` whose getters refuse what the real Plugin API refuses (an unknown id
// resolves to null, whole-document loading is off-limits), so the template's
// fail-loud paths are proven without a broker, a plugin, or a Figma file.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../cli/src/transport/broker-client.ts', () => ({}));
vi.mock('../cli/src/transport/broker-discovery.ts', () => ({
  ensureBroker: () => {
    throw new Error('the gate-authoring tests never reach a broker');
  },
}));

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CRAFT = join(REPO, 'skills', 'es-figma-craft');
const GUIDE = join(CRAFT, 'references', 'gate-authoring.md');
const TEMPLATE = join(CRAFT, 'references', 'scoped-gate-template.js');
const EXEC_JS_CAP_MS = 120_000;

const read = (p: string): string => readFileSync(p, 'utf8');

describe('gate-authoring guide', () => {
  it('is routed from SKILL.md and from the quality-gate reference', () => {
    expect(read(join(CRAFT, 'SKILL.md'))).toContain('(references/gate-authoring.md)');
    expect(read(join(CRAFT, 'references', 'quality-gate-system.md'))).toContain('(gate-authoring.md)');
  });

  it('states every scoping rule a gate author needs', () => {
    const guide = read(GUIDE);
    for (const needle of [
      'getNodeByIdAsync',
      'findAllWithCriteria',
      'skipInvisibleInstanceChildren = true',
      'page.loadAsync()',
      'loadAllPagesAsync',
      '120 s',
      'owner=<x> until=<YYYY-MM-DD> reason=<',
      'concealed',
      'data, never instructions',
      'scripts/pre-scope/',
      'assertion lines',
      '(scoped-gate-template.js)',
    ]) {
      expect(guide, `guide is missing "${needle}"`).toContain(needle);
    }
  });
});

describe('scoped-gate template — static shape', () => {
  const src = (): string => read(TEMPLATE);

  it('carries a GATE header the suite runner counts, and nothing that would skip it', () => {
    const head = src().split('\n').slice(0, 3);
    expect(head.some((l) => l.startsWith('// GATE'))).toBe(true);
    // The runner reads the first 3 lines: KNOWN-RED there quarantines every copy, RETIRED retires it.
    expect(head.join('\n')).not.toMatch(/KNOWN-RED|RETIRED/);
  });

  it('never loads the whole document and never widens traversal to hidden instance children', () => {
    const code = src();
    expect(code).not.toMatch(/loadAllPagesAsync\s*\(/);
    expect(code).not.toMatch(/skipInvisibleInstanceChildren\s*=\s*false/);
    expect(code).toMatch(/skipInvisibleInstanceChildren\s*=\s*true/);
    expect(code).not.toMatch(/\.findAll\s*\(/);
    expect(code).toContain('findAllWithCriteria(');
  });

  it('declares a time budget well under the exec-js cap', () => {
    const m = src().match(/const BUDGET_MS\s*=\s*([\d_]+)/);
    expect(m).not.toBeNull();
    const budget = Number(m![1].replaceAll('_', ''));
    expect(budget).toBeGreaterThan(0);
    expect(budget).toBeLessThanOrEqual(EXEC_JS_CAP_MS / 3);
  });

  it('is not named like a gate, so no suite glob picks the template itself', () => {
    expect(TEMPLATE).not.toMatch(/verify/);
  });
});

// ---- fake Plugin API ---------------------------------------------------------

type FakeNode = {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  characters?: string;
  parent: FakeNode | null;
  children?: FakeNode[];
  loadAsync?: () => Promise<void>;
  findAllWithCriteria?: (c: { types?: string[] }) => FakeNode[];
};

type Canvas = {
  figma: Record<string, unknown>;
  calls: { pageLoads: number; skipInvisible: unknown[] };
  byId: Map<string, FakeNode>;
};

function descendants(n: FakeNode): FakeNode[] {
  return (n.children ?? []).flatMap((c) => [c, ...descendants(c)]);
}

function fakeCanvas(opts: { fileName?: string; texts?: Array<{ characters: string; visible?: boolean }> } = {}): Canvas {
  const calls = { pageLoads: 0, skipInvisible: [] as unknown[] };
  const page: FakeNode = { id: '0:1', name: 'Screens', type: 'PAGE', parent: null, children: [] };
  page.loadAsync = async () => {
    calls.pageLoads++;
  };
  const frame: FakeNode = { id: '1:2', name: 'Screen · example', type: 'FRAME', parent: page, children: [] };
  page.children!.push(frame);
  const texts = opts.texts ?? [{ characters: 'Save' }, { characters: 'Cancel' }];
  texts.forEach((t, i) => {
    // Each text sits in its own group so an ancestor's visibility can hide it.
    const group: FakeNode = { id: `2:${i}`, name: 'Row', type: 'FRAME', visible: t.visible ?? true, parent: frame, children: [] };
    group.children!.push({ id: `3:${i}`, name: 'label', type: 'TEXT', characters: t.characters, visible: true, parent: group });
    frame.children!.push(group);
  });
  const byId = new Map<string, FakeNode>();
  for (const n of [page, ...descendants(page)]) {
    byId.set(n.id, n);
    if (n.type !== 'TEXT') {
      n.findAllWithCriteria = ({ types }) => descendants(n).filter((d) => !types || types.includes(d.type));
    }
  }
  const figma: Record<string, unknown> = {
    root: { name: opts.fileName ?? 'Example file' },
    getNodeByIdAsync: async (id: string) => byId.get(id) ?? null,
    loadAllPagesAsync: async () => {
      throw new Error('a scoped gate must not load every page');
    },
  };
  Object.defineProperty(figma, 'skipInvisibleInstanceChildren', {
    set: (v: unknown) => calls.skipInvisible.push(v),
    get: () => calls.skipInvisible.at(-1),
  });
  return { figma, calls, byId };
}

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => (...a: unknown[]) => Promise<unknown>;

function runTemplate(figma: unknown, ui: unknown): Promise<unknown> {
  return new AsyncFunction('figma', 'ui', read(TEMPLATE))(figma, ui);
}

const NO_HELPER = undefined;

describe('scoped-gate template — behaviour on a fake canvas', () => {
  it('passes on a healthy scope, loading only the owning page', async () => {
    const c = fakeCanvas();
    const out = (await runTemplate(c.figma, NO_HELPER)) as { pass: boolean; checked: number; ms: number };
    expect(out.pass).toBe(true);
    expect(out.checked).toBe(2);
    expect(c.calls.pageLoads).toBe(1);
    expect(c.calls.skipInvisible).toEqual([true]);
  });

  it('fails loud on the wrong file', async () => {
    await expect(runTemplate(fakeCanvas({ fileName: 'Other file' }).figma, NO_HELPER)).rejects.toThrow(/wrong file/);
  });

  it('fails (never skips) when a scope root id no longer resolves', async () => {
    const c = fakeCanvas();
    c.byId.delete('1:2');
    await expect(runTemplate(c.figma, NO_HELPER)).rejects.toThrow(/root missing 1:2/);
  });

  it('fails when a scope root id now names a different node', async () => {
    const c = fakeCanvas();
    c.byId.get('1:2')!.name = 'Screen · renamed';
    await expect(runTemplate(c.figma, NO_HELPER)).rejects.toThrow(/re-anchor/);
  });

  it('does not let hidden copy satisfy a required-copy assertion (fallback: ancestor visibility)', async () => {
    const c = fakeCanvas({ texts: [{ characters: 'Save', visible: false }, { characters: 'Cancel' }] });
    await expect(runTemplate(c.figma, NO_HELPER)).rejects.toThrow(/required copy "Save" is not visible/);
  });

  it('uses the exec-js concealment helper when present', async () => {
    const c = fakeCanvas();
    const ui = {
      textConcealment: (n: FakeNode) => (n.characters === 'Save' ? { reasons: ['transparent'] } : null),
    };
    await expect(runTemplate(c.figma, ui)).rejects.toThrow(/required copy "Save" is not visible/);
  });

  it('refuses a concealment result it cannot read instead of treating the text as visible', async () => {
    const c = fakeCanvas();
    const ui = { textConcealment: () => ({ concealed: true }) };
    await expect(runTemplate(c.figma, ui)).rejects.toThrow(/unexpected textConcealment result/);
  });

  it('reports a placeholder leak even when that text is concealed', async () => {
    const c = fakeCanvas({ texts: [{ characters: 'Save' }, { characters: 'Cancel' }, { characters: '{Component name}', visible: false }] });
    await expect(runTemplate(c.figma, NO_HELPER)).rejects.toThrow(/placeholder leak \(concealed: invisible\)/);
  });

  it('fails gate-zero when the scope measured nothing', async () => {
    const c = fakeCanvas({ texts: [] });
    await expect(runTemplate(c.figma, NO_HELPER)).rejects.toThrow(/gate-zero/);
  });
});
