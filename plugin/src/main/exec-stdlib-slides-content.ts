// `ui.slides.*` content helpers (absorption phase-04): background, addText,
// addShape, content. Adapted from the fork's Slides handlers (MIT; see
// THIRD-PARTY.md), code.js:7103-7220 — `background` REWRITTEN, not ported (below).
import { requireEditor } from './exec-stdlib-editor';
import { withCode, hexToFigmaColor, rgbToFigma } from './executor-styles';
import { serializeNode, jsonSafe, type SerializedNode } from './serialize-node';
import { resolveSlide } from './exec-stdlib-slides-resolve';
import {
  MAX_TEXT_CHARS, MAX_FONT_SIZE, MAX_DIMENSION, type AddTextOpts, type AddShapeOpts,
} from './exec-stdlib-slides-types';

const FALLBACK_FONT: FontName = { family: 'Inter', style: 'Medium' };

/**
 * Background — REWRITTEN, not ported. The fork creates/updates a hardcoded-1920x1080
 * `RECTANGLE` named 'Background' inserted at index 0 (code.js:7060-7083): a
 * workaround for an API that did not exist when it was written. Re-anchor finding for
 * this phase (checked directly against developers.figma.com/docs/plugins/api/
 * SlideNode/, not assumed): `SlideNode` itself carries `fills`/`setFillsAsync` via
 * GeometryMixin, the same as any other geometry node — a REAL background API exists
 * now. No rectangle, no hardcoded size, no redundant appendChild+insertChild(0,…).
 * `method: 'slide-fill'` names it so no caller believes a `Background` rectangle now
 * exists on the slide. `hadPriorFill` reports PRIOR STATE only ("a fill existed
 * before this call") — not "the fill changed": the write itself is already honest
 * via the awaited `setFillsAsync`, so this field must never be misread as a
 * change-happened signal (stage-4 review finding).
 */
export async function background(
  slideId: string, color: string,
): Promise<{ slideId: string; color: string; hadPriorFill: boolean; method: 'slide-fill' }> {
  requireEditor('ui.slides.background', ['slides']);
  const slide = await resolveSlide(slideId, 'ui.slides.background');
  const hadPriorFill = Array.isArray(slide.fills) && slide.fills.length > 0;
  await slide.setFillsAsync([{ type: 'SOLID', color: rgbToFigma(hexToFigmaColor(color)) }]);
  return { slideId, color, hadPriorFill, method: 'slide-fill' };
}

async function loadTextFont(fontFamily?: string, fontStyle?: string): Promise<FontName> {
  const requested: FontName = { family: fontFamily ?? 'Inter', style: fontStyle ?? 'Regular' };
  try {
    await figma.loadFontAsync(requested);
    return requested;
  } catch {
    await figma.loadFontAsync(FALLBACK_FONT);
    return FALLBACK_FONT;
  }
}

/**
 * Team-lead ruling (phase-04 re-anchor, first-class correctness finding): in
 * single-slide view, Figma's own create methods (`figma.createText()`/
 * `createRectangle()`/`createEllipse()`) append to the FOCUSED slide by default, not
 * wherever the caller intends. Trusting default parenting would silently
 * misattribute content to the wrong slide — the exact silent-misattribution class
 * this whole absorption track exists to close. Every create-into-slide helper
 * explicitly re-parents AND verifies the result, regardless of view mode.
 */
function appendAndVerify(slide: SlideNode, node: SceneNode, capability: string): void {
  slide.appendChild(node);
  if (node.parent !== slide) {
    throw withCode(
      new Error(`${capability}: node ${node.id} landed on the wrong slide (parent is ${node.parent?.id ?? 'none'}, expected ${slide.id})`),
      'E_EVAL',
    );
  }
}

/** Absorbed fact 10: font loaded BEFORE `characters` is assigned, and
 * `textAutoResize = 'HEIGHT'` accompanies an explicit width. `lineHeight`/
 * `letterSpacing` take `{value, unit:'PIXELS'}` (code.js:7115-7137). */
export async function addText(slideId: string, opts: AddTextOpts): Promise<{ id: string; characters: string }> {
  requireEditor('ui.slides.addText', ['slides']);
  if (opts.text.length > MAX_TEXT_CHARS) {
    throw withCode(new Error(`ui.slides.addText: text exceeds ${MAX_TEXT_CHARS} chars`), 'E_INVALID_ARGS');
  }
  if (typeof opts.fontSize === 'number' && opts.fontSize > MAX_FONT_SIZE) {
    throw withCode(new Error(`ui.slides.addText: fontSize exceeds ${MAX_FONT_SIZE}`), 'E_INVALID_ARGS');
  }
  const slide = await resolveSlide(slideId, 'ui.slides.addText');
  const node = figma.createText();
  node.fontName = await loadTextFont(opts.fontFamily, opts.fontStyle);
  node.characters = opts.text;
  if (typeof opts.fontSize === 'number') node.fontSize = opts.fontSize;
  node.x = typeof opts.x === 'number' ? opts.x : 100;
  node.y = typeof opts.y === 'number' ? opts.y : 100;
  if (opts.color) node.fills = [{ type: 'SOLID', color: rgbToFigma(hexToFigmaColor(opts.color)) }];
  if (opts.textAlign) node.textAlignHorizontal = opts.textAlign as TextNode['textAlignHorizontal'];
  if (typeof opts.width === 'number') {
    node.resize(opts.width, node.height);
    node.textAutoResize = 'HEIGHT';
  }
  if (typeof opts.lineHeight === 'number') node.lineHeight = { value: opts.lineHeight, unit: 'PIXELS' };
  if (typeof opts.letterSpacing === 'number') node.letterSpacing = { value: opts.letterSpacing, unit: 'PIXELS' };
  if (opts.textCase) node.textCase = opts.textCase as TextNode['textCase'];
  appendAndVerify(slide, node, 'ui.slides.addText');
  return { id: node.id, characters: node.characters };
}

/** Absorbed fact 11: supports only RECTANGLE/ELLIPSE (fork's own narrow set,
 * code.js:7180-7201) — a caller wanting more writes raw Plugin API in the same
 * exec-js script, the point of a stdlib being helpers rather than a wall. */
export async function addShape(slideId: string, opts: AddShapeOpts = {}): Promise<{ id: string; type: string }> {
  requireEditor('ui.slides.addShape', ['slides']);
  const shapeType = opts.shapeType ?? 'RECTANGLE';
  if (shapeType !== 'RECTANGLE' && shapeType !== 'ELLIPSE') {
    throw withCode(new Error(`ui.slides.addShape: unknown shapeType "${shapeType}" — valid: RECTANGLE, ELLIPSE`), 'E_INVALID_ARGS');
  }
  if ((typeof opts.width === 'number' && opts.width > MAX_DIMENSION)
    || (typeof opts.height === 'number' && opts.height > MAX_DIMENSION)) {
    throw withCode(new Error(`ui.slides.addShape: dimension exceeds ${MAX_DIMENSION}`), 'E_INVALID_ARGS');
  }
  const slide = await resolveSlide(slideId, 'ui.slides.addShape');
  const node = shapeType === 'ELLIPSE' ? figma.createEllipse() : figma.createRectangle();
  node.x = typeof opts.x === 'number' ? opts.x : 100;
  node.y = typeof opts.y === 'number' ? opts.y : 100;
  node.resize(typeof opts.width === 'number' ? opts.width : 200, typeof opts.height === 'number' ? opts.height : 200);
  if (opts.color) {
    if (!/^#?[0-9a-fA-F]{6}$/.test(opts.color)) {
      throw withCode(new Error(`ui.slides.addShape: invalid hex color "${opts.color}"`), 'E_INVALID_ARGS');
    }
    node.fills = [{ type: 'SOLID', color: rgbToFigma(hexToFigmaColor(opts.color)) }];
  }
  appendAndVerify(slide, node, 'ui.slides.addShape');
  return { id: node.id, type: node.type };
}

/** Absorbed fact 12: use OUR serializer (serialize-node.ts), not the fork's ad-hoc
 * local one (code.js:6585-6598 — 7 fields, no cycle guard, no depth cap). Same eyes
 * as the rest of the system (exec-stdlib.ts's own rule). Default depth 10: a slide's
 * own content rarely nests deeper, and `content()` means "show me this slide", not a
 * one-level peek. */
export async function content(slideId: string, opts: { depth?: number } = {}): Promise<unknown> {
  requireEditor('ui.slides.content', ['slides']);
  const slide = await resolveSlide(slideId, 'ui.slides.content');
  const serialized: SerializedNode = serializeNode(slide as unknown as SceneNode, opts.depth ?? 10);
  return jsonSafe(serialized);
}
