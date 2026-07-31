// `ui.annotate.*` — Figma Annotations (absorption phase-02). Adapted from the fork's
// GET/SET_ANNOTATIONS handlers (MIT; see THIRD-PARTY.md), code.js:2454-2692, and the
// property-type vocabulary in annotation-tools.ts:22-56.
import { withCode } from './executor-styles';

/** The closed `AnnotationPropertyType` vocabulary — copied as VALUES (an API fact,
 * cited not attributed) from @figma/plugin-typings, per annotation-tools.ts:22-56.
 * https://developers.figma.com/docs/plugins/api/AnnotationProperty */
const ANNOTATION_PROPERTY_TYPES = [
  'width', 'height', 'maxWidth', 'minWidth', 'maxHeight', 'minHeight', 'fills', 'strokes',
  'effects', 'strokeWeight', 'cornerRadius', 'textStyleId', 'textAlignHorizontal',
  'fontFamily', 'fontStyle', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing',
  'itemSpacing', 'padding', 'layoutMode', 'alignItems', 'opacity', 'mainComponent',
  'gridRowGap', 'gridColumnGap', 'gridRowCount', 'gridColumnCount', 'gridRowAnchorIndex',
  'gridColumnAnchorIndex', 'gridRowSpan', 'gridColumnSpan',
] as const;
const TYPE_SET = new Set<string>(ANNOTATION_PROPERTY_TYPES);

function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i]![0] = i;
  for (let j = 0; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
    }
  }
  return dp[a.length]![b.length]!;
}

/** Fact 3: an invalid type throws naming the value AND the nearest valid ones —
 * never a silent drop. */
function validatePropertyType(type: string): void {
  if (TYPE_SET.has(type)) return;
  const nearest = [...ANNOTATION_PROPERTY_TYPES].sort((a, b) => levenshtein(type, a) - levenshtein(type, b)).slice(0, 3);
  throw withCode(new Error(`invalid annotation property type "${type}" — nearest valid: ${nearest.join(', ')}`), 'E_INVALID_ARGS');
}

export interface AnnotationPropertyInput { type: string }
export interface AnnotationInput {
  label?: string; labelMarkdown?: string; properties?: AnnotationPropertyInput[]; categoryId?: string;
}
export interface AnnotationOutput {
  label: string | null; labelMarkdown: string | null; properties: { type: string }[] | null;
  categoryId: string | null; categoryName: string | null;
}
/** The shape `node.annotations` carries live — cast target, not the ambient type
 * (which this repo's installed typings do expose correctly here, unlike SLOT's
 * `slotContentId`; kept local so the cast sites read the same way regardless). */
interface RawAnnotation {
  label?: string; labelMarkdown?: string; properties?: { type: string }[]; categoryId?: string;
}

async function getCategories(): Promise<{ id: string; name: string }[]> {
  try {
    const cats = await figma.annotations.getAnnotationCategoriesAsync();
    return cats.map((c) => ({ id: c.id, name: c.label }));
  } catch { return []; }
}

function toOutput(a: RawAnnotation, categoryMap: Map<string, string>): AnnotationOutput {
  return {
    label: a.label ?? null,
    labelMarkdown: a.labelMarkdown ?? null,
    properties: a.properties?.length ? a.properties.map((p) => ({ type: p.type })) : null,
    categoryId: a.categoryId ?? null,
    // Fact 4: an unmatched category id reports categoryName:null, never the id echoed.
    categoryName: a.categoryId ? (categoryMap.get(a.categoryId) ?? null) : null,
  };
}

async function requireAnnotatable(nodeId: string): Promise<BaseNode & { annotations?: RawAnnotation[] }> {
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw withCode(new Error(`node not found: ${nodeId}`), 'E_INVALID_ARGS');
  // Fact 1: 'annotations' in node IS the capability test.
  if (!('annotations' in node)) {
    throw withCode(new Error(`node type ${node.type} does not support annotations`), 'E_INVALID_ARGS');
  }
  return node as BaseNode & { annotations?: RawAnnotation[] };
}

async function get(nodeId: string, opts: { includeChildren?: boolean; depth?: number } = {}): Promise<{
  nodeId: string; nodeName: string; nodeType: string; annotations: AnnotationOutput[]; annotationCount: number;
  children?: { nodeId: string; nodeName: string; nodeType: string; annotations: AnnotationOutput[] }[];
  childAnnotationCount?: number; skippedChildren?: number; availableCategories: { id: string; name: string }[];
}> {
  const node = await requireAnnotatable(nodeId);
  const categories = await getCategories();
  const categoryMap = new Map(categories.map((c) => [c.id, c.name]));
  const nodeAnnotations = (node.annotations ?? []).map((a) => toOutput(a, categoryMap));

  const includeChildren = opts.includeChildren ?? false;
  const maxDepth = opts.depth ?? 1;
  const childResults: { nodeId: string; nodeName: string; nodeType: string; annotations: AnnotationOutput[] }[] = [];
  let skippedChildren = 0;
  if (includeChildren && 'children' in node) {
    const walk = (parent: BaseNode & ChildrenMixin, depth: number): void => {
      if (depth > maxDepth) return;
      for (const child of parent.children) {
        try {
          const anns = 'annotations' in child ? ((child as { annotations?: readonly RawAnnotation[] }).annotations ?? []).map((a) => toOutput(a, categoryMap)) : [];
          if (anns.length > 0) childResults.push({ nodeId: child.id, nodeName: child.name, nodeType: child.type, annotations: anns });
          if ('children' in child) walk(child as SceneNode & ChildrenMixin, depth + 1);
        } catch {
          // Fact 5: slot sublayers / table cells throw on property access — skip,
          // but COUNT it. A silent skip is how "no annotations" becomes a lie.
          skippedChildren += 1;
        }
      }
    };
    walk(node as BaseNode & ChildrenMixin, 1);
  }

  return {
    nodeId: node.id, nodeName: (node as SceneNode).name, nodeType: node.type,
    annotations: nodeAnnotations, annotationCount: nodeAnnotations.length,
    ...(includeChildren ? {
      children: childResults,
      childAnnotationCount: childResults.reduce((sum, c) => sum + c.annotations.length, 0),
      skippedChildren,
    } : {}),
    availableCategories: categories,
  };
}

async function set(
  nodeId: string,
  annotations: AnnotationInput[],
  opts: { mode?: 'replace' | 'append' } = {},
): Promise<{ nodeId: string; nodeName: string; annotationCount: number; mode: 'replace' | 'append'; annotations: AnnotationOutput[] }> {
  const node = await requireAnnotatable(nodeId);
  for (const input of annotations) for (const p of input.properties ?? []) validatePropertyType(p.type);

  const built: RawAnnotation[] = annotations.map((input) => {
    const ann: RawAnnotation = {};
    if (input.label) ann.label = input.label;
    if (input.labelMarkdown) ann.labelMarkdown = input.labelMarkdown;
    if (input.properties?.length) ann.properties = input.properties.map((p) => ({ type: p.type }));
    if (input.categoryId) ann.categoryId = input.categoryId;
    return ann;
  });

  const mode = opts.mode ?? 'replace';
  let finalAnnotations = built;
  if (mode === 'append') {
    const existing = node.annotations ?? [];
    const merged: RawAnnotation[] = existing.map((ex) => {
      const copy: RawAnnotation = {};
      // Fact 2: Figma auto-populates BOTH label and labelMarkdown on read but
      // rejects writing both — prefer labelMarkdown, drop label when both exist.
      if (ex.labelMarkdown) copy.labelMarkdown = ex.labelMarkdown;
      else if (ex.label) copy.label = ex.label;
      if (ex.properties) copy.properties = ex.properties;
      if (ex.categoryId) copy.categoryId = ex.categoryId;
      return copy;
    });
    finalAnnotations = [...merged, ...built];
  }

  (node as unknown as { annotations: RawAnnotation[] }).annotations = finalAnnotations;

  // Verify: re-read, never trust the input we just built.
  const categories = await getCategories();
  const categoryMap = new Map(categories.map((c) => [c.id, c.name]));
  const readBack = (node.annotations ?? []).map((a) => toOutput(a, categoryMap));
  if (readBack.length !== finalAnnotations.length) {
    throw withCode(new Error(`set applied but read back ${readBack.length} annotations, expected ${finalAnnotations.length}`), 'E_EVAL');
  }
  return { nodeId: node.id, nodeName: (node as SceneNode).name, annotationCount: readBack.length, mode, annotations: readBack };
}

async function categories(): Promise<{ categories: { id: string; name: string }[] }> {
  return { categories: await getCategories() };
}

export interface ExecStdlibAnnotate {
  get(nodeId: string, opts?: { includeChildren?: boolean; depth?: number }): ReturnType<typeof get>;
  set(nodeId: string, annotations: AnnotationInput[], opts?: { mode?: 'replace' | 'append' }): ReturnType<typeof set>;
  categories(): ReturnType<typeof categories>;
}

export function createExecStdlibAnnotate(): ExecStdlibAnnotate {
  return { get, set, categories };
}
