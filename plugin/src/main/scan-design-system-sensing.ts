// The two additive sensing fields of SCAN_DESIGN_SYSTEM: the variables bound inside each
// component (`components[].boundVariables`) and, per page, the component instances each
// top-level frame is built from (`frames[]`). The plugin only SENSES; judging which
// variable is a design-system token or which page holds screens belongs to the kernel.
//
// Dynamic-page rules this module obeys (the manifest is `documentAccess: dynamic-page`):
//   - the sync `InstanceNode.mainComponent` getter THROWS, so every instance's main
//     component is reached through `getMainComponentAsync()` and never the sync getter;
//   - a page must be loaded before it is searched (the caller awaits loadAllPagesAsync);
//   - `getMainComponentAsync()` may resolve to null (a deleted or unreachable library
//     component) or to a component with no parent (remote / soft-deleted) — both are
//     counted as `unresolvedInstances`, never dropped and never guessed.
import { r2, safe } from './scan-node-utils';

interface AliasLike { type?: unknown; id?: unknown }

/** Every `VARIABLE_ALIAS` id found anywhere inside a boundVariables-shaped value. */
function collectAliasIds(value: unknown, into: Set<string>, depth = 0): void {
  if (!value || typeof value !== 'object' || depth > 4) return;
  if (Array.isArray(value)) {
    for (const v of value) collectAliasIds(v, into, depth + 1);
    return;
  }
  const alias = value as AliasLike;
  if (alias.type === 'VARIABLE_ALIAS' && typeof alias.id === 'string' && alias.id) {
    into.add(alias.id);
    return;
  }
  for (const v of Object.values(value)) collectAliasIds(v, into, depth + 1);
}

/** Variable ids bound on ONE node: its own fields plus the paints/effects/grids it carries. */
function collectOwnBindings(n: Record<string, unknown>, into: Set<string>): void {
  collectAliasIds(safe(() => n.boundVariables), into);
  for (const field of ['fills', 'strokes', 'effects', 'layoutGrids'] as const) {
    const list = safe(() => n[field]);
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      collectAliasIds(safe(() => (item as { boundVariables?: unknown }).boundVariables), into);
    }
  }
}

/**
 * Every variable id bound anywhere inside a component or component set (a set's variants
 * included), sorted for a stable payload. The walk does not descend into a nested
 * INSTANCE: its children belong to another component, which carries its own entry.
 */
export function boundVariableIdsOf(root: SceneNode): string[] {
  const ids = new Set<string>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const n = stack.pop() as Record<string, unknown>;
    collectOwnBindings(n, ids);
    if (n.type === 'INSTANCE') continue;
    const kids = safe(() => n.children) as unknown[] | undefined;
    if (Array.isArray(kids)) for (const k of kids) stack.push(k);
  }
  return [...ids].sort();
}

/** The identity a frame's instance list names: id for a local component, key for a library one. */
function componentRefOf(main: ComponentNode): string | null {
  // Variants fold into their set, exactly as `components[]` does.
  const set = main.parent && main.parent.type === 'COMPONENT_SET' ? (main.parent as ComponentSetNode) : null;
  const target = set ?? main;
  if (target.remote === true) return target.key || null;
  return target.id || null;
}

export interface FrameInstanceCount { component: string; count: number }
export interface ScannedFrame {
  id: string;
  name: string;
  page: { id: string; name: string };
  w: number;
  h: number;
  instances: FrameInstanceCount[];
  /** Present only when > 0: instances whose main component could not be resolved. */
  unresolvedInstances?: number;
}

async function instancesOf(frame: FrameNode): Promise<{ instances: FrameInstanceCount[]; unresolved: number }> {
  const counts = new Map<string, number>();
  let unresolved = 0;
  const found = frame.findAllWithCriteria({ types: ['INSTANCE'] });
  const mains = await Promise.all(found.map(async (inst) => {
    try {
      return await inst.getMainComponentAsync();
    } catch {
      return null;
    }
  }));
  for (const main of mains) {
    const ref = main ? componentRefOf(main) : null;
    if (!ref) { unresolved++; continue; }
    counts.set(ref, (counts.get(ref) ?? 0) + 1);
  }
  const instances = [...counts].map(([component, count]) => ({ component, count }))
    .sort((a, b) => (a.component < b.component ? -1 : a.component > b.component ? 1 : 0));
  return { instances, unresolved };
}

/**
 * The top-level FRAMEs of every page with the components instantiated inside them. Pages
 * must already be loaded (a failing search on an unloaded page propagates: a scan that
 * silently skipped a page would assert a screen list it never saw).
 */
export async function serializeFrames(pages: readonly PageNode[]): Promise<ScannedFrame[]> {
  const out: ScannedFrame[] = [];
  for (const page of pages) {
    for (const child of page.children) {
      if (child.type !== 'FRAME') continue;
      const { instances, unresolved } = await instancesOf(child);
      const frame: ScannedFrame = {
        id: child.id, name: child.name, page: { id: page.id, name: page.name },
        w: r2(child.width), h: r2(child.height), instances,
      };
      if (unresolved > 0) frame.unresolvedInstances = unresolved;
      out.push(frame);
    }
  }
  return out;
}
