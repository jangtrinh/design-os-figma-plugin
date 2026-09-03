// ONE node → ONE `context` record: the code-relevant facts the Plugin API exposes on a
// Free plan, and nothing invented.
//
// Two rules this module exists to hold:
//   1. `css` is whatever `getCSSAsync()` returned, VERBATIM. A `var(--token, #hex)`
//      fallback is not "normalised" to the hex, declarations are not reordered, nothing is
//      dropped. A rewritten declaration is a wrong fact about the file, and this reader's
//      whole value is that it reports the Inspect panel rather than an interpretation of it.
//   2. No variable VALUE is ever emitted here. A value read off `modes[0]` on a multi-mode
//      collection is a different mode's value wearing the collection's name — the identity
//      table (context-refs.ts) carries `modeCount` instead, and the caller asks for a mode
//      by name when it needs one.
//
// The four FOREIGN-shaped values — `css`, `segments`, `componentProperties`,
// `componentPropertyDefinitions` — pass through `jsonSafe` before they are stored. Their
// shape belongs to the host, not to us, and one value `JSON.stringify` refuses (a circular
// reference) would take the WHOLE reply down at the wire, not just its own node. Verbatim
// still holds: `jsonSafe` is the identity transform for the plain objects these actually
// are, and the alternative to sanitising is losing every node's answer to one node's shape.
//
// Every sync property read goes through `safe()` (scan-node-utils.ts): under
// `documentAccess: "dynamic-page"` the sync `mainComponent` getter throws, `componentProperties`
// throws on a COMPONENT_SET, and style ids / fontName read back `figma.mixed` — a single
// refused read must never abort a whole subtree's record.
import { jsonSafe } from './serialize-node';
import { r2, readBindings, safe } from './scan-node-utils';

/** The only surface this module touches. A real `SceneNode` satisfies it after the one
 *  documented cast in executor-context.ts — the same shape `readBindings` already takes,
 *  so the reader stays drivable from a plain fixture object (no sandbox in tests). */
export type ContextNodeLike = Record<string, unknown>;

export interface ContextRecordOptions {
  /** Depth below the requested root: the root itself is 0. */
  depth: number;
  /** `null` for the requested root — the flat breadth-first list is only re-assemblable
   *  into a tree if every record names its parent. */
  parentId: string | null;
  /** Position among its parent's children. Only ever used to LOCATE a node whose own
   *  identity read refused: "child 2 of 1:1" is something the caller can act on, an id of
   *  `''` is not. */
  childIndex?: number;
  /** `false` for `--no-css`: `getCSSAsync` is then never called at all (it is the whole
   *  cost of this command, ~7-8ms per node), not called-and-discarded. */
  includeCss: boolean;
}

export interface ContextRecordResult {
  record: Record<string, unknown>;
  /** The children the WALKER should enqueue. Empty for a collapsed asset subtree: those
   *  descendants are accounted in `record.collapsed`, never walked and never silent. */
  children: ContextNodeLike[];
  /** A read this node needed refused. The record still SHIPS (carrying `cssError`,
   *  `mainComponentError` or `childrenError`) and still counts as `emitted` — the walk
   *  counts it in `budget.partial` instead, so the reply says "this node is here but its
   *  answer is incomplete" rather than "a node is missing". */
  incomplete: boolean;
}

/** `{fill|text|effect → styleId}` — a `figma.mixed` id is "several", so it is ABSENT
 *  rather than one invented id. */
function readStyles(node: ContextNodeLike): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, field] of [['fill', 'fillStyleId'], ['text', 'textStyleId'], ['effect', 'effectStyleId']] as const) {
    const id = safe(() => node[field]);
    if (typeof id === 'string' && id !== '') out[key] = id;
  }
  return out;
}

function readLayout(node: ContextNodeLike): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const num = (field: string): number | undefined => {
    const v = safe(() => node[field]);
    return typeof v === 'number' ? r2(v) : undefined;
  };
  const str = (field: string): string | undefined => {
    const v = safe(() => node[field]);
    return typeof v === 'string' ? v : undefined;
  };
  const layoutMode = str('layoutMode');
  if (layoutMode !== undefined) out.layoutMode = layoutMode;
  const sizingH = str('layoutSizingHorizontal');
  if (sizingH !== undefined) out.sizingH = sizingH;
  const sizingV = str('layoutSizingVertical');
  if (sizingV !== undefined) out.sizingV = sizingV;
  const gap = num('itemSpacing');
  if (gap !== undefined) out.gap = gap;
  const padding = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].map(num);
  if (padding.some((p) => p !== undefined)) out.padding = padding.map((p) => p ?? 0);
  for (const [key, field] of [['w', 'width'], ['h', 'height'], ['x', 'x'], ['y', 'y']] as const) {
    const v = num(field);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/**
 * Children, and whether the read REFUSED — two answers that must never collapse into one.
 *
 * A node type with no `.children` field is honestly childless. A node whose getter throws
 * is a subtree of unknown size: live, a PAGE refuses with "Cannot access children of an
 * unloaded page" until it is loaded, and boot's `loadAllPagesAsync` is fire-and-forget, so
 * a context call can land inside that window. `safe()` alone maps both to `[]`, which
 * reports a 300-layer page as a leaf with nothing missing — the silent hole this whole
 * module exists to prevent. The `in` test is itself guarded: a fully invalidated reference
 * refuses even that, and "cannot tell" is a refusal, not an absence.
 */
export function childrenOf(node: ContextNodeLike): { children: ContextNodeLike[]; refused: string | null } {
  const has = safe(() => 'children' in node);
  if (has === false) return { children: [], refused: null };
  try {
    const kids = node.children;
    if (Array.isArray(kids)) return { children: kids as ContextNodeLike[], refused: null };
    // Present but not an array (a host that answers with something else): unknown, not empty.
    return { children: [], refused: has === undefined ? 'children could not be read' : 'children is not an array' };
  } catch (err) {
    return { children: [], refused: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * `{descendants, types}` for a subtree that is NOT being walked.
 *
 * This counter is the whole reason an `isAsset` collapse is allowed at all. The minimal
 * code an implementer writes from "collapse assets" is `if (node.isAsset) return {...}` —
 * which silently swallows, among other things, the TEXT child of an icon+label frame, i.e.
 * a string the agent then never renders. A count by TYPE makes that impossible to miss.
 */
export function countCollapsed(
  children: readonly ContextNodeLike[],
): { descendants: number; types: Record<string, number>; readErrors: number } {
  let descendants = 0;
  let readErrors = 0;
  const types: Record<string, number> = {};
  const stack: ContextNodeLike[] = [...children];
  while (stack.length > 0) {
    const node = stack.pop() as ContextNodeLike;
    descendants += 1;
    const type = safe(() => node.type);
    const key = typeof type === 'string' ? type : 'UNKNOWN';
    types[key] = (types[key] ?? 0) + 1;
    // A refusal INSIDE the collapse is the worst case of all: the count IS the record here,
    // so an undercount is not a missing node, it is a wrong number presented as a fact.
    const read = childrenOf(node);
    if (read.refused !== null) readErrors += 1;
    for (const child of read.children) stack.push(child);
  }
  return { descendants, types, readErrors };
}

/** The one error-to-string used by every reader in this command. */
export const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Where a node whose own id refused SITS, so the caller can go back and re-read it.
 *  Deliberately parenthesised prose: no Figma node id looks like this, so it can never be
 *  mistaken for one and passed back as a target. */
function locate(opts: ContextRecordOptions): string {
  return opts.parentId === null
    ? '(unreadable target)'
    : `(unreadable child ${opts.childIndex ?? 0} of ${opts.parentId})`;
}

/**
 * id / name / type, and whether reading them REFUSED — the third refusal in this module,
 * and the one that decides whether a record is addressable at all.
 *
 * `safe()` alone degrades a throwing `id` to `''` and a throwing `type` to `'UNKNOWN'`,
 * which shipped a record the caller cannot re-issue on with no error field, no counter and
 * `complete: true` — and a TEXT whose `type` refused silently skipped its `characters`, so
 * an agent rendered no string. `id` and `type` must therefore READ, not merely not-throw:
 * a non-string answer is as unusable as a refusal. A throwing `name` is a refusal too (an
 * invalidated reference refuses everything), but an ABSENT name costs nothing and is `''`.
 * The FIRST message is kept — the one describing the original cause, not a cascade.
 */
function readIdentity(node: ContextNodeLike): {
  id: string; name: string; type: string; readError: string | null;
} {
  let readError: string | null = null;
  const note = (message: string): void => { if (readError === null) readError = message; };
  let id = '';
  try {
    const raw = node.id;
    if (typeof raw === 'string' && raw !== '') id = raw;
    else note('id could not be read');
  } catch (err) { note(messageOf(err)); }
  let name = '';
  try {
    const raw = node.name;
    if (typeof raw === 'string') name = raw;
  } catch (err) { note(messageOf(err)); }
  let type = '';
  try {
    const raw = node.type;
    if (typeof raw === 'string' && raw !== '') type = raw;
    else note('type could not be read');
  } catch (err) { note(messageOf(err)); }
  return { id, name, type, readError };
}

export async function buildContextRecord(
  node: ContextNodeLike, opts: ContextRecordOptions,
): Promise<ContextRecordResult> {
  const identity = readIdentity(node);
  if (identity.readError !== null) {
    // Minimal and LOCATED: the same shape the walk uses for a record it could not build at
    // all, so a caller has one thing to recognise. Nothing else is read — a reference that
    // refuses its own name refuses everything after it.
    return {
      record: {
        id: identity.id !== '' ? identity.id : locate(opts),
        readError: identity.readError,
      },
      children: [],
      incomplete: true,
    };
  }
  const record: Record<string, unknown> = {
    id: identity.id,
    name: identity.name,
    type: identity.type,
    depth: opts.depth,
    parentId: opts.parentId,
  };
  const visible = safe(() => node.visible);
  if (typeof visible === 'boolean') record.visible = visible;

  const layout = readLayout(node);
  if (Object.keys(layout).length > 0) record.layout = layout;

  const bindings = readBindings(node);
  if (Object.keys(bindings).length > 0) record.bindings = bindings;
  const styles = readStyles(node);
  if (Object.keys(styles).length > 0) record.styles = styles;

  let incomplete = false;
  const type = identity.type;

  if (type === 'TEXT') {
    const characters = safe(() => node.characters);
    if (typeof characters === 'string') record.characters = characters;
    // `fontName` reads back `figma.mixed` on style-linked text even when one font covers
    // every character — `safe()` turns that symbol into undefined, which is exactly the
    // signal that only the segments can answer. Uniform text spends nothing here.
    if (safe(() => node.fontName) === undefined) {
      const read = safe(() => (node.getStyledTextSegments as ((fields: string[]) => unknown[]) | undefined)?.(
        ['characters', 'fontName', 'fontSize', 'fills', 'fontWeight', 'textDecoration'],
      ));
      if (Array.isArray(read) && read.length > 0) record.segments = jsonSafe(read);
    }
  }

  if (type === 'INSTANCE') {
    const getMain = safe(() => node.getMainComponentAsync) as (() => Promise<ContextNodeLike | null>) | undefined;
    if (typeof getMain === 'function') {
      try {
        const main = await (getMain as () => Promise<ContextNodeLike | null>).call(node);
        const key = main ? safe(() => main.key) : undefined;
        const name = main ? safe(() => main.name) : undefined;
        if (typeof key === 'string') record.mainComponent = { key, name: typeof name === 'string' ? name : '' };
      } catch (err) {
        record.mainComponentError = err instanceof Error ? err.message : String(err);
        incomplete = true;
      }
    }
    const props = safe(() => node.componentProperties);
    if (props && typeof props === 'object') record.componentProperties = jsonSafe(props);
  }

  if (type === 'COMPONENT' || type === 'COMPONENT_SET') {
    const defs = safe(() => node.componentPropertyDefinitions);
    if (defs && typeof defs === 'object') record.componentPropertyDefinitions = jsonSafe(defs);
  }

  const read = childrenOf(node);
  if (read.refused !== null) {
    record.childrenError = read.refused;
    // `null`, never 0: a frontier entry (or a record) reading `childCount: 0` is a leaf,
    // and a caller does not re-issue `context` on a leaf.
    record.childCount = null;
    incomplete = true;
  } else {
    record.childCount = read.children.length;
  }

  if (opts.includeCss) {
    const getCss = safe(() => node.getCSSAsync) as (() => Promise<Record<string, string>>) | undefined;
    if (typeof getCss === 'function') {
      try {
        record.css = jsonSafe(await (getCss as () => Promise<Record<string, string>>).call(node));
      } catch (err) {
        record.cssError = err instanceof Error ? err.message : String(err);
        incomplete = true;
      }
    }
  }

  const isAsset = safe(() => node.isAsset);
  if (isAsset === true && read.children.length > 0) {
    const collapsed = countCollapsed(read.children);
    record.collapsed = collapsed;
    if (collapsed.readErrors > 0) incomplete = true;
    return { record, children: [], incomplete };
  }
  return { record, children: read.children, incomplete };
}
