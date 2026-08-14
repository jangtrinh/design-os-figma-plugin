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
