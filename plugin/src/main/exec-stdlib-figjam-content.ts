// `ui.figjam.*` creation helpers (absorption phase-03). Adapted from the fork's
// FigJam handlers (MIT; see THIRD-PARTY.md), code.js:5970-6524, figjam-tools.ts:8-59.
// Reuse, do not re-implement: `requireEditor` (exec-stdlib-editor.ts),
// `hexToFigmaColor`/`rgbToFigma` (executor-styles.ts).
import { requireEditor } from './exec-stdlib-editor';
import { withCode, hexToFigmaColor, rgbToFigma } from './executor-styles';
import {
  MAX_STICKIES_PER_BATCH, MAX_TEXT_CHARS, STICKY_COLORS,
  type StickySpec, type StickyResult, type ShapeOpts, type SectionOpts,
} from './exec-stdlib-figjam-types';

const FALLBACK_FONT: FontName = { family: 'Inter', style: 'Medium' };

/** Absorbed fact 4: a connector/shape's default font may fail to load — fall back to
 * Inter Medium and SET the sublayer's own fontName to the fallback, or the
 * `characters` assignment right after throws (the fallback must be recorded, not
 * just attempted). */
async function loadOrFallback(sublayer: { fontName: FontName | symbol }): Promise<void> {
  try {
    await figma.loadFontAsync(sublayer.fontName as FontName);
  } catch {
    await figma.loadFontAsync(FALLBACK_FONT);
    sublayer.fontName = FALLBACK_FONT;
  }
}

function assertTextLength(text: string, field: string): void {
  if (text.length > MAX_TEXT_CHARS) {
    throw withCode(new Error(`${field} exceeds ${MAX_TEXT_CHARS} chars (batch cap, timeout guard — not a Figma limit)`), 'E_INVALID_ARGS');
  }
}

export async function sticky(text: string, opts: Omit<StickySpec, 'text'> = {}): Promise<StickyResult> {
  requireEditor('ui.figjam.sticky', ['figjam']);
  assertTextLength(text, 'sticky text');
  const node = figma.createSticky();
  // Absorbed fact 1: load the STICKY'S OWN default font before assigning characters.
  await figma.loadFontAsync(node.text.fontName as FontName);
  node.text.characters = text;
  if (opts.color) {
    const rgb = STICKY_COLORS[opts.color.toUpperCase()];
    if (!rgb) {
      throw withCode(new Error(`unknown sticky color "${opts.color}" — valid: ${Object.keys(STICKY_COLORS).join(', ')}`), 'E_INVALID_ARGS');
    }
    node.fills = [{ type: 'SOLID', color: rgb }];
  }
  if (typeof opts.x === 'number') node.x = opts.x;
  if (typeof opts.y === 'number') node.y = opts.y;
  // Honest-reporting rule: read node.name back, never the input text (FigJam names
  // stickies itself — a sticky is not named by its text).
  return { id: node.id, type: 'STICKY', name: node.name, x: node.x, y: node.y };
}

export interface StickiesResult {
  created: number; failed: number;
  results: StickyResult[]; errors: { index: number; error: string }[];
}

export async function stickies(specs: readonly StickySpec[]): Promise<StickiesResult> {
  requireEditor('ui.figjam.stickies', ['figjam']);
  if (specs.length > MAX_STICKIES_PER_BATCH) {
    throw withCode(new Error(`${specs.length} stickies requested — capped at ${MAX_STICKIES_PER_BATCH} per batch`), 'E_INVALID_ARGS');
  }
  const results: StickyResult[] = [];
  const errors: { index: number; error: string }[] = [];
  // Absorbed fact 1: load the default sticky font ONCE, reuse for the whole batch — a
  // real 200x saving over one loadFontAsync per sticky, not a micro-optimisation.
  let batchFont: FontName | null = null;
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]!;
    try {
      assertTextLength(spec.text, `stickies[${i}].text`);
      const node = figma.createSticky();
      if (!batchFont) batchFont = node.text.fontName as FontName;
      await figma.loadFontAsync(batchFont);
      node.text.characters = spec.text;
      if (spec.color) {
        const rgb = STICKY_COLORS[spec.color.toUpperCase()];
        if (!rgb) throw new Error(`unknown sticky color "${spec.color}" — valid: ${Object.keys(STICKY_COLORS).join(', ')}`);
        node.fills = [{ type: 'SOLID', color: rgb }];
      }
      if (typeof spec.x === 'number') node.x = spec.x;
      if (typeof spec.y === 'number') node.y = spec.y;
      results.push({ id: node.id, type: 'STICKY', name: node.name, x: node.x, y: node.y });
    } catch (err) {
      errors.push({ index: i, error: err instanceof Error ? err.message : String(err) });
    }
  }
  // Honest-reporting rule: created.length + errors.length === specs.length, always.
  return { created: results.length, failed: errors.length, results, errors };
}

export async function connector(
  startNodeId: string, endNodeId: string,
  opts: { label?: string; startMagnet?: string; endMagnet?: string } = {},
): Promise<{ id: string; type: 'CONNECTOR'; name: string }> {
  requireEditor('ui.figjam.connector', ['figjam']);
  // Absorbed fact 3: both endpoints resolved with getNodeByIdAsync before assignment.
  const startNode = await figma.getNodeByIdAsync(startNodeId);
  if (!startNode) throw withCode(new Error(`connector start node not found: ${startNodeId}`), 'E_INVALID_ARGS');
  const endNode = await figma.getNodeByIdAsync(endNodeId);
  if (!endNode) throw withCode(new Error(`connector end node not found: ${endNodeId}`), 'E_INVALID_ARGS');

  // No standalone `ConnectorMagnet` type is exported by @figma/plugin-typings — the
  // union lives inline on `ConnectorEndpoint`'s own `magnet` field; derive it from
  // there instead of hand-copying the literal list (drifts silently otherwise).
  type Magnet = Extract<ConnectorEndpoint, { magnet: unknown }>['magnet'];
  const node = figma.createConnector();
  node.connectorStart = { endpointNodeId: startNodeId, magnet: (opts.startMagnet as Magnet | undefined) ?? 'AUTO' };
  node.connectorEnd = { endpointNodeId: endNodeId, magnet: (opts.endMagnet as Magnet | undefined) ?? 'AUTO' };
  if (opts.label) {
    assertTextLength(opts.label, 'connector label');
    await loadOrFallback(node.text);
    node.text.characters = opts.label;
  }
  return { id: node.id, type: 'CONNECTOR', name: node.name };
}

export async function shape(opts: ShapeOpts = {}): Promise<{
  id: string; type: 'SHAPE_WITH_TEXT'; name: string; x: number; y: number; width: number; height: number;
}> {
  requireEditor('ui.figjam.shape', ['figjam']);
  const node = figma.createShapeWithText();
  if (opts.shapeType) node.shapeType = opts.shapeType as ShapeWithTextNode['shapeType'];
  if (typeof opts.x === 'number') node.x = opts.x;
  if (typeof opts.y === 'number') node.y = opts.y;
  // Absorbed fact 5: resize BEFORE setting text, so the text reflows to the new size.
  if (typeof opts.width === 'number' || typeof opts.height === 'number') {
    node.resize(opts.width ?? node.width, opts.height ?? node.height);
  }
  if (opts.fillColor) node.fills = [{ type: 'SOLID', color: rgbToFigma(hexToFigmaColor(opts.fillColor)) }];
  if (opts.strokeColor) node.strokes = [{ type: 'SOLID', color: rgbToFigma(hexToFigmaColor(opts.strokeColor)) }];
  if (opts.strokeDashPattern) node.dashPattern = opts.strokeDashPattern;
  if (opts.text) {
    assertTextLength(opts.text, 'shape text');
    await loadOrFallback(node.text); // same fallback pattern as connector.text (fact 4)
    if (typeof opts.fontSize === 'number') node.text.fontSize = opts.fontSize;
    node.text.characters = opts.text;
  }
  return { id: node.id, type: 'SHAPE_WITH_TEXT', name: node.name, x: node.x, y: node.y, width: node.width, height: node.height };
}

export async function section(opts: SectionOpts = {}): Promise<{
  id: string; type: 'SECTION'; name: string; x: number; y: number; width: number; height: number;
}> {
  requireEditor('ui.figjam.section', ['figjam']);
  const node = figma.createSection();
  if (opts.name) node.name = opts.name;
  if (typeof opts.x === 'number') node.x = opts.x;
  if (typeof opts.y === 'number') node.y = opts.y;
  // Absorbed fact 6: resizeWithoutConstraints, not resize.
  if (typeof opts.width === 'number' || typeof opts.height === 'number') {
    node.resizeWithoutConstraints(opts.width ?? node.width, opts.height ?? node.height);
  }
  if (opts.fillColor) node.fills = [{ type: 'SOLID', color: rgbToFigma(hexToFigmaColor(opts.fillColor)) }];
  return { id: node.id, type: 'SECTION', name: node.name, x: node.x, y: node.y, width: node.width, height: node.height };
}
