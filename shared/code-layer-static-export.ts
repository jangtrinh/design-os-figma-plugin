// A Figma code layer (a live React/HTML layer on the Design canvas, node.type
// "CODE_INSTANCE") runs its code only in Figma's own preview. `exportAsync` renders the
// layer's static shell instead: on a live layer whose page was visibly running on the
// canvas, the export was a flat background fill. A PNG of such a node is therefore not
// evidence of what the canvas shows, and every path that hands one out says so.

/** Node types whose PNG export is not a render of what the canvas shows. */
export const STATIC_EXPORT_NODE_TYPES: ReadonlySet<string> = new Set(['CODE_INSTANCE']);

export interface StaticRenderNote {
  nodeType: string;
  reason: string;
}

const REASON = 'Figma exports a code layer as its static shell, not its running code, so this PNG '
  + 'is not a render of what the canvas shows. To check it visually, start the layer\'s preview '
  + 'in Figma and capture the Figma window.';

/** The note for a node of this type, or undefined when its export is a real render. */
export function staticRenderNote(nodeType: unknown): StaticRenderNote | undefined {
  return typeof nodeType === 'string' && STATIC_EXPORT_NODE_TYPES.has(nodeType)
    ? { nodeType, reason: REASON }
    : undefined;
}
