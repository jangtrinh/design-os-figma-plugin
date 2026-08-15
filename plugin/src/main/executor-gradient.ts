// IMPORT_GRADIENT executor: turn rendered PNG bytes into an image fill on a target node,
// and store the config that produced them so the bake stays re-editable.
//
// The pixel path is the same one createImageNodeWithFetch already uses
// (figma.createImage(bytes) -> ImagePaint), reused rather than duplicated: a second image
// path would be a second place for scaleMode and hash handling to drift.
//
// Re-editability is the reason this writes plugin data at all. A baked gradient is
// otherwise a flat picture — nobody can tell which preset made it, at what size, from
// which renderer revision. Storing the query string means a later command can re-bake the
// same field at a new size instead of asking the user to remember what they chose.

/** Namespace key for the stored config. Read by any later re-bake. */
export const GRADIENT_DATA_KEY = 'shaderGradientConfig';

export interface ImportGradientParams {
  /** PNG bytes from the UI render host. Arrives as a plain object across postMessage. */
  bytes?: unknown;
  /** Target node id, or absent to use the current selection. */
  nodeId?: string;
  /** Upstream-format query string describing the field that was baked. */
  config?: string;
  /** Preset slug when one was named; null for a hand-configured field. */
  slug?: string | null;
  /** Renderer revision the bake came from, recorded so a stale bake is identifiable. */
  renderer?: string;
}

export interface ImportGradientResult {
  nodeId: string;
  name: string;
  slug: string | null;
  bytes: number;
}

/**
 * postMessage does not preserve Uint8Array — a typed array crosses the boundary as a
 * plain object with numeric keys. Reconstructing it is mandatory; handing that object to
 * figma.createImage throws a type error far from its cause.
 */
export function toBytes(raw: unknown): Uint8Array {
  if (raw instanceof Uint8Array) return raw;
  if (Array.isArray(raw)) return new Uint8Array(raw as number[]);
  if (raw !== null && typeof raw === 'object') {
    const values = Object.values(raw as Record<string, unknown>).filter((v): v is number => typeof v === 'number');
    if (values.length > 0) return new Uint8Array(values);
  }
  throw new Error('IMPORT_GRADIENT: params.bytes did not carry image data');
}

/**
 * Replace a node's fills with the baked gradient image.
 *
 * Every existing paint is dropped, not layered under the image: a gradient field is an
 * opaque ambient surface, so leaving a previous solid beneath it would only matter if the
 * image failed to cover — and an image that does not cover is a bug we want visible.
 */
export async function importGradient(params: ImportGradientParams): Promise<ImportGradientResult> {
  const bytes = toBytes(params.bytes);
  if (bytes.length === 0) throw new Error('IMPORT_GRADIENT: refusing to bake an empty image');

  let target: SceneNode | null = null;
  if (typeof params.nodeId === 'string' && params.nodeId !== '') {
    const node = await figma.getNodeByIdAsync(params.nodeId);
    if (!node) throw new Error(`IMPORT_GRADIENT: no node with id '${params.nodeId}'`);
    if (node.type === 'DOCUMENT' || node.type === 'PAGE') {
      throw new Error(`IMPORT_GRADIENT: '${params.nodeId}' is a ${node.type}, which carries no fills`);
    }
    target = node as SceneNode;
  } else {
    const selection = figma.currentPage.selection;
    if (selection.length === 0) {
      throw new Error('IMPORT_GRADIENT: nothing selected — pass --node, or select a node to bake onto');
    }
    if (selection.length > 1) {
      // Baking onto several nodes at once would produce N identical images and N undo
      // entries under one command. Refuse rather than guess which one was meant.
      throw new Error(`IMPORT_GRADIENT: ${selection.length} nodes selected — select exactly one, or pass --node`);
    }
    target = selection[0] as SceneNode;
  }

  if (!('fills' in target)) {
    throw new Error(`IMPORT_GRADIENT: a ${target.type} carries no fills`);
  }

  const image = figma.createImage(bytes);
  const paint: ImagePaint = { type: 'IMAGE', scaleMode: 'FILL', imageHash: image.hash };
  (target as GeometryMixin).fills = [paint];

  // Stored AFTER the fill lands, so a node never claims a config whose paint failed.
  if (typeof params.config === 'string' && params.config !== '') {
    target.setPluginData(
      GRADIENT_DATA_KEY,
      JSON.stringify({
        config: params.config,
        slug: params.slug ?? null,
        renderer: params.renderer ?? null,
      }),
    );
  }

  return {
    nodeId: target.id,
    name: target.name,
    slug: params.slug ?? null,
    bytes: bytes.length,
  };
}
