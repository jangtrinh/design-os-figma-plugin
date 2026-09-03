import { describe, expect, it } from 'vitest';
import { lintExecJs } from '../cli/src/commands/exec-js-lint.ts';

const hardCases = [
  ['sync-get-node-by-id', 'const node = figma.getNodeById("1:2")'],
  ['sync-local-text-styles', 'const styles = figma.getLocalTextStyles()'],
  ['sync-local-paint-styles', 'const styles = figma.getLocalPaintStyles()'],
  ['sync-local-effect-styles', 'const styles = figma.getLocalEffectStyles()'],
  ['sync-current-page-assignment', 'figma.currentPage = page'],
  ['unsupported-import', 'import { value } from "./module"'],
] as const;

const maskedHardCases = hardCases.flatMap(([id, code]) => [
  [`${id} in line comment`, `// ${code}`],
  [`${id} in block comment`, `/* ${code} */\nreturn 1`],
  [`${id} in string`, `const sample = ${JSON.stringify(code)}`],
  [`${id} in template`, `const sample = \`${code}\``],
] as const);

describe('lintExecJs — deterministic errors', () => {
  it.each(hardCases)('%s rejects the proven failing signature', (id, code) => {
    expect(lintExecJs(code)).toContainEqual(expect.objectContaining({ id, severity: 'error' }));
  });

  it.each([
    'const node = await figma.getNodeByIdAsync("1:2")',
    'const styles = await figma.getLocalTextStylesAsync()',
    'const styles = await figma.getLocalPaintStylesAsync()',
    'const styles = await figma.getLocalEffectStylesAsync()',
    'const same = figma.currentPage == page',
    'const exact = figma.currentPage === page',
  ])('does not reject the safe sibling: %s', (code) => {
    expect(lintExecJs(code).filter((f) => f.severity === 'error')).toEqual([]);
  });

  it.each(maskedHardCases)('does not reject a masked signature: %s', (_label, code) => {
    expect(lintExecJs(code).filter((f) => f.severity === 'error')).toEqual([]);
  });

  it.each([
    'const matcher = /https?:\\/\\/[^\"]+/',
    'const matcher = /figma\\.getNodeById\\(/',
    'const matcher = /figma.getNodeById("1:2")/',
    'const matcher = /figma.getLocalTextStyles()\\/\\/quoted/',
    'return /figma.currentPage=/.test(value)',
    'throw /figma.currentPage=/',
    'if (ok) /figma.currentPage=/.test(value)',
    'return /foo.mainComponent/.test(value)',
  ])('does not reject regex-shaped source: %s', (code) => {
    expect(lintExecJs(code)).toEqual([]);
  });

  it.each([
    'const ratio = a / b; // figma.getNodeById("1:2")',
    'const ratio = a / b; /* figma.currentPage = page */',
  ])('does not let a later comment close a division as though it were regex: %s', (code) => {
    expect(lintExecJs(code)).toEqual([]);
  });

  it.each([
    'const modulePromise = import("./module.js")',
    'const location = import.meta.url',
  ])('does not classify a non-declaration import form as a hard error: %s', (code) => {
    expect(lintExecJs(code).filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('keeps the masker linear on slash-heavy input', () => {
    const code = '/['.repeat(40_000);
    const started = performance.now();
    lintExecJs(code);
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe('lintExecJs — warnings and ordering', () => {
  it.each([
    ['sync-main-component-property', 'return instance.mainComponent'],
    ['unsupported-require', 'const lib = require("x")'],
    ['sync-text-style-assignment', 'node.textStyleId = style.id'],
    ['sync-effect-style-assignment', 'node.effectStyleId = style.id'],
    ['unloaded-font-assignment', 'node.fontName = { family: "Inter", style: "Regular" }'],
  ] as const)('%s warns without classifying the signature as an error', (id, code) => {
    expect(lintExecJs(code)).toContainEqual(expect.objectContaining({ id, severity: 'warning' }));
  });

  it('does not warn for font assignment when the script loads a font first', () => {
    const code = 'await figma.loadFontAsync(font); node.fontName = font';
    expect(lintExecJs(code).map((f) => f.id)).not.toContain('unloaded-font-assignment');
  });

  it.each([
    'return await instance.getMainComponentAsync()',
    'const sample = "require(\\"x\\")"',
    'const same = node.textStyleId === style.id',
    'const same = node.effectStyleId == style.id',
  ])('does not warn for a safe or masked heuristic sibling: %s', (code) => {
    expect(lintExecJs(code).filter((f) => f.severity === 'warning')).toEqual([]);
  });

  it('reports the source line for an actionable finding', () => {
    expect(lintExecJs('return 1\nfigma.getNodeById("1:2")')[0]?.line).toBe(2);
  });

  it('returns findings in canonical rule-table order', () => {
    const ids = lintExecJs('node.mainComponent; figma.getNodeById("1:2"); require("x")').map((f) => f.id);
    expect(ids).toEqual(['sync-get-node-by-id', 'sync-main-component-property', 'unsupported-require']);
  });

  it('returns no findings for a clean script', () => {
    expect(lintExecJs('(async () => { return await figma.getNodeByIdAsync("1:2") })()')).toEqual([]);
  });
});

// Backlog group 6 — the three craft-skill footguns the VSF-PCP campaigns paid for:
// findAll() sweeping hidden nodes, componentProperties on a COMPONENT_SET (throws), and
// the sync mainComponent getter (already a rule above; re-asserted here so the trio is
// visible in one place). Each rule: positive, negative, and a false-positive guard.
describe('lintExecJs — craft footguns (findAll visibility, componentProperties on a set, mainComponent)', () => {
  const warningIds = (code: string): string[] =>
    lintExecJs(code).filter((f) => f.severity === 'warning').map((f) => f.id);

  it('positive: findAll() with a predicate that never checks visibility warns', () => {
    expect(warningIds('const cells = frame.findAll(n => n.type === "INSTANCE")')).toContain('find-all-without-visible-filter');
    expect(warningIds('const all = page.findAll()')).toContain('find-all-without-visible-filter');
  });

  it('negative: a findAll whose script filters on visible (in the predicate or after) does not warn', () => {
    expect(warningIds('frame.findAll(n => n.visible && n.type === "INSTANCE")')).not.toContain('find-all-without-visible-filter');
    expect(warningIds('frame.findAll(n => n.type === "INSTANCE").filter(n => n.visible)')).not.toContain('find-all-without-visible-filter');
  });

  it('false-positive guard: findAllWithCriteria, findOne and a masked "findAll(" never trigger the rule', () => {
    expect(warningIds('figma.root.findAllWithCriteria({ types: ["COMPONENT_SET"] })')).not.toContain('find-all-without-visible-filter');
    expect(warningIds('const hit = frame.findOne(n => n.name === "Body")')).not.toContain('find-all-without-visible-filter');
    expect(warningIds('const note = "frame.findAll(n => n)"; // page.findAll()')).not.toContain('find-all-without-visible-filter');
  });

  it('positive: reading componentProperties in a script that handles a COMPONENT_SET warns', () => {
    const code = 'const set = await figma.getNodeByIdAsync(id); if (set.type === "COMPONENT_SET") return set.componentProperties';
    expect(warningIds(code)).toContain('component-properties-on-set');
  });

  it('negative: componentProperties on an instance, with no set in sight, is the correct API and does not warn', () => {
    expect(warningIds('const inst = await figma.getNodeByIdAsync(id); return inst.componentProperties')).not.toContain('component-properties-on-set');
  });

  it('false-positive guard: componentPropertyDefinitions (the set API) next to COMPONENT_SET does not warn', () => {
    const code = 'if (node.type === "COMPONENT_SET") return node.componentPropertyDefinitions';
    expect(warningIds(code)).not.toContain('component-properties-on-set');
  });

  it('positive/negative/guard: the sync mainComponent getter warns, the async twin and a masked mention do not', () => {
    expect(warningIds('return inst.mainComponent.name')).toContain('sync-main-component-property');
    expect(warningIds('return (await inst.getMainComponentAsync()).name')).not.toContain('sync-main-component-property');
    expect(warningIds('const label = "inst.mainComponent"')).not.toContain('sync-main-component-property');
  });

  it('each new rule carries a fix an agent can apply verbatim', () => {
    const findings = lintExecJs('page.findAll(); if (n.type === "COMPONENT_SET") n.componentProperties');
    const byId = new Map(findings.map((f) => [f.id, f]));
    expect(byId.get('find-all-without-visible-filter')?.fix).toMatch(/visible/);
    expect(byId.get('component-properties-on-set')?.fix).toMatch(/componentPropertyDefinitions/);
  });
});
