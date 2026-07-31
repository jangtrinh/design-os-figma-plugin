// `ui.figjam.arrange` (absorption phase-03). Absorbed fact 9: PURE geometry over
// x/y/width/height — port the math (code.js:482-520), not the fork's delivery
// mechanism (they build a JS string and ship it through executeCodeViaUI; we are
// already inside the sandbox and need none of that).
import { requireEditor } from './exec-stdlib-editor';
import { withCode } from './executor-styles';
import { MAX_ARRANGE_NODES, type ArrangeOpts, type ArrangeResult } from './exec-stdlib-figjam-types';

interface Positionable { x: number; y: number; width: number; height: number }

/** Pure — no figma access, unit-tested directly. Mutates each node's x/y in place,
 * in the given layout. Grid columns default to `ceil(sqrt(n))` when not given. */
export function computeArrangement(
  nodes: readonly Positionable[], layout: 'grid' | 'horizontal' | 'vertical', spacing: number, columns?: number,
): void {
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  let col = 0;
  const cols = layout === 'grid' ? (columns ?? Math.ceil(Math.sqrt(nodes.length))) : nodes.length;
  for (const node of nodes) {
    if (layout === 'horizontal') {
      node.x = x;
      node.y = 0;
      x += node.width + spacing;
    } else if (layout === 'vertical') {
      node.x = 0;
      node.y = y;
      y += node.height + spacing;
    } else {
      node.x = x;
      node.y = y;
      rowHeight = Math.max(rowHeight, node.height);
      col += 1;
      x += node.width + spacing;
      if (col >= cols) {
        col = 0;
        x = 0;
        y += rowHeight + spacing;
        rowHeight = 0;
      }
    }
  }
}

export async function arrange(nodeIds: readonly string[], opts: ArrangeOpts = {}): Promise<ArrangeResult> {
  requireEditor('ui.figjam.arrange', ['figjam']);
  if (nodeIds.length > MAX_ARRANGE_NODES) {
    throw withCode(new Error(`${nodeIds.length} nodes requested — capped at ${MAX_ARRANGE_NODES} per arrange`), 'E_INVALID_ARGS');
  }
  const layout = opts.layout ?? 'grid';
  const spacing = opts.spacing ?? 20;
  const resolved: SceneNode[] = [];
  // Absorbed fact 9 (their bug, fixed): report `skipped` ids for nodes that did not
  // resolve — the fork throws only when ALL ids fail, which loses the partial truth.
  const skipped: string[] = [];
  for (const id of nodeIds) {
    const node = await figma.getNodeByIdAsync(id);
    if (!node || !('x' in node) || !('width' in node)) { skipped.push(id); continue; }
    resolved.push(node as SceneNode);
  }
  computeArrangement(resolved, layout, spacing, opts.columns);
  return { arranged: resolved.length, layout, skipped };
}
