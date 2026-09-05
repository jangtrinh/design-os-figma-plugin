// Ported from EaseUI app/src/lib/figma-export.ts:923-983 (extractFromLiveIframe),
// 1082-1139 (waitForStylesReady), 1145-1215 (prepareDocForExtraction).
// Adapted: page width is a parameter (source hardcoded 1512); payload assembly
// lives here so render-host.ts stays a thin iframe lifecycle wrapper.

import type { FigmaExportNode, FigmaExportPayload } from '../../../../shared/figma-payload-types';
import { parseCssColor } from './color-utils';
import { computedElementToNode } from './computed-walk';
import { captureMotionOntoElements } from './extract-motion';
import { annotateTokenRefs, extractFigmaTokens } from './tokens';
export { waitForStylesReady, waitForStylesReadyInDocument } from './style-readiness';

/**
 * Prepare the document for extraction by making ALL visual content visible.
 * A designer expects to see everything — not just what's in the viewport.
 */
export function prepareDocForExtraction(doc: Document): void {
  const win = doc.defaultView;
  if (!win) return;

  // 0. MOTION PRODUCER: capture each element's @keyframes animation and stash it
  //    as data-fa-motion BEFORE the kill below — build-frame reads it into
  //    node.motion so animations flow into Figma Motion end-to-end.
  try { captureMotionOntoElements(doc, win); } catch { /* non-fatal */ }

  // 1. KILL all CSS transitions/animations so state changes are instant —
  //    otherwise reveal animations leak opacity:0 into the payload.
  const killMotion = doc.createElement('style');
  killMotion.textContent = `
    *, *::before, *::after {
      transition: none !important;
      transition-duration: 0s !important;
      transition-delay: 0s !important;
      animation: none !important;
      animation-duration: 0s !important;
      animation-delay: 0s !important;
    }
  `;
  doc.head.appendChild(killMotion);
  void doc.body.offsetHeight; // force reflow so the kill-style takes effect

  // 2. Remove viewport constraints from body (h-screen clips to viewport)
  doc.body.classList.remove('h-screen', 'min-h-screen', 'max-h-screen');
  doc.body.style.height = 'auto';
  doc.body.style.maxHeight = 'none';
  doc.body.style.overflow = 'visible';
  doc.body.style.overflowX = 'visible';
  doc.body.style.overflowY = 'visible';

  // 3. Activate all reveal animations (instant, since transitions are dead)
  const revealSelectors = ['.reveal', '.reveal-left', '.reveal-right', '.reveal-scale', '.reveal-hero', '.reveal-stagger'];
  for (const selector of revealSelectors) {
    doc.querySelectorAll(selector).forEach((el) => el.classList.add('active'));
  }
  void doc.body.offsetHeight; // reflow so .active styles apply before reading

  // 4. Force ALL elements visible and remove overflow clipping
  doc.querySelectorAll('*').forEach((el) => {
    const htmlEl = el as HTMLElement;
    if (!htmlEl.style) return;
    const cs = win.getComputedStyle(htmlEl);

    if (cs.opacity === '0') htmlEl.style.opacity = '1';

    if (cs.overflow === 'hidden' || cs.overflow === 'auto' || cs.overflow === 'scroll') htmlEl.style.overflow = 'visible';
    if (cs.overflowX === 'hidden' || cs.overflowX === 'auto' || cs.overflowX === 'scroll') htmlEl.style.overflowX = 'visible';
    if (cs.overflowY === 'hidden' || cs.overflowY === 'auto' || cs.overflowY === 'scroll') htmlEl.style.overflowY = 'visible';

    if (cs.maxHeight !== 'none' && parseFloat(cs.maxHeight) < 10000) htmlEl.style.maxHeight = 'none';

    htmlEl.classList.remove('h-screen', 'max-h-screen');
  });
}

/**
 * Extract a Figma node tree from a rendered iframe (styles fully applied).
 * Preps the document, reads body layout/background, walks children.
 */
export function extractFromDocument(doc: Document, win: Window, width: number): FigmaExportNode {
  const body = doc.body;
  if (!body || body.children.length === 0) {
    return { type: 'FRAME', name: 'Page', width, height: 900 };
  }

  prepareDocForExtraction(doc);

  // Page background: body → html → white; transparent falls back to white
  const bodyStyle = win.getComputedStyle(body);
  const htmlStyle = win.getComputedStyle(doc.documentElement);
  let pageBgColor = parseCssColor(bodyStyle.backgroundColor)
    || parseCssColor(htmlStyle.backgroundColor)
    || { r: 1, g: 1, b: 1, a: 1 };
  if (pageBgColor.a === 0) pageBgColor = { r: 1, g: 1, b: 1, a: 1 };

  // Detect body layout direction
  let bodyLayoutMode: 'HORIZONTAL' | 'VERTICAL' = 'VERTICAL';
  if (bodyStyle.display.includes('flex')) {
    const dir = bodyStyle.flexDirection;
    bodyLayoutMode = (dir === 'row' || dir === 'row-reverse') ? 'HORIZONTAL' : 'VERTICAL';
  }

  const pageFrame: FigmaExportNode = {
    type: 'FRAME',
    name: 'Page',
    width,
    height: Math.round(body.scrollHeight) || 900,
    layoutMode: bodyLayoutMode,
    primaryAxisSizingMode: 'AUTO',
    counterAxisSizingMode: 'FIXED',
    fills: [{ type: 'SOLID', color: pageBgColor }],
    children: [],
  };

  // Body padding/gap
  const bodyGap = parseFloat(bodyStyle.gap) || 0;
  if (bodyGap > 0) pageFrame.itemSpacing = Math.round(bodyGap);
  const bpt = parseFloat(bodyStyle.paddingTop) || 0;
  const bpr = parseFloat(bodyStyle.paddingRight) || 0;
  const bpb = parseFloat(bodyStyle.paddingBottom) || 0;
  const bpl = parseFloat(bodyStyle.paddingLeft) || 0;
  if (bpt > 0) pageFrame.paddingTop = Math.round(bpt);
  if (bpr > 0) pageFrame.paddingRight = Math.round(bpr);
  if (bpb > 0) pageFrame.paddingBottom = Math.round(bpb);
  if (bpl > 0) pageFrame.paddingLeft = Math.round(bpl);

  for (const child of Array.from(body.children)) {
    if (child.nodeType === 1) { // ELEMENT_NODE — cross-iframe safe
      const node = computedElementToNode(child as HTMLElement, win, 0);
      if (node) pageFrame.children!.push(node);
    }
  }

  return pageFrame;
}

export function extractFromIframe(iframe: HTMLIFrameElement, width: number): FigmaExportNode {
  const doc = iframe.contentDocument;
  const win = iframe.contentWindow;
  return doc && win ? extractFromDocument(doc, win, width) : { type: 'FRAME', name: 'Page', width, height: 900 };
}

/** Extract node tree + tokens from a rendered iframe and assemble the payload. */
export function buildPayloadFromIframe(iframe: HTMLIFrameElement, name: string, width: number): FigmaExportPayload {
  const doc = iframe.contentDocument;
  const win = iframe.contentWindow;
  const rootNode = doc && win
    ? extractFromDocument(doc, win, width)
    : { type: 'FRAME' as const, name: 'Page', width, height: 900 };
  return buildPayloadFromRoot(rootNode, name, width);
}

export function buildPayloadFromDocument(doc: Document, win: Window, name: string, width: number): FigmaExportPayload {
  return buildPayloadFromRoot(extractFromDocument(doc, win, width), name, width);
}

function buildPayloadFromRoot(rootNode: FigmaExportNode, name: string, width: number): FigmaExportPayload {
  const tokens = extractFigmaTokens(rootNode);
  annotateTokenRefs(rootNode, tokens); // P3 leg B: exact-match token bindings
  return {
    version: 1,
    name,
    width: rootNode.width || width,
    height: rootNode.height || 900,
    tokens,
    rootNode,
  };
}
