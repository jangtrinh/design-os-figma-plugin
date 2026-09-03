// Who a changed node IS — the identity helpers `documentchange` capture runs per change,
// lifted out of main.ts so they can be tested without a sandbox (main.ts calls
// `figma.showUI` at module load, so it cannot be imported outside a live plugin).
//
// Everything here is an UPWARD walk from the changed node: O(depth), never O(tree). This
// runs once per changed node inside a drag batch, where 50+ changes can be delivered at
// once. The page walk itself lives in page-of-node.ts — one implementation, shared with the
// connector layer, deliberately unbounded so depth can never cost a caller the true page.

/** Component identity as recorded in a change (id + best-effort name + node type). */
export interface ComponentIdentity {
  id: string;
  name: string | null;
  type: string;
}

/**
 * Resolve a changed node to its canonical component container: the enclosing
 * COMPONENT_SET if the node is a variant, else the nearest COMPONENT/COMPONENT_SET.
 * Returns null when the change is not under any component (the volume filter —
 * ordinary frame/text edits are ignored). Deletes arrive as a RemovedNode with only
 * id + type (no name, no parent), so a deleted DESCENDANT of a component cannot be
 * resolved upward — we capture only whole-component deletions. Documented limit.
 */
export function resolveComponentIdentity(node: SceneNode | RemovedNode): ComponentIdentity | null {
  if ('removed' in node && node.removed) {
    // RemovedNode: id + type only. Record it only if it WAS itself a component.
    if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') {
      return { id: node.id, name: null, type: node.type };
    }
    return null;
  }
  let n: BaseNode | null = node;
  while (n) {
    if (n.type === 'COMPONENT_SET') return { id: n.id, name: n.name, type: n.type };
    if (n.type === 'COMPONENT') {
      // A variant's canonical unit is its enclosing set (matches the registry).
      if (n.parent && n.parent.type === 'COMPONENT_SET') {
        return { id: n.parent.id, name: n.parent.name, type: n.parent.type };
      }
      return { id: n.id, name: n.name, type: n.type };
    }
    n = n.parent;
  }
  return null;
}

/** Best-effort identity, remembered so a DELETE (which arrives as id+type only) can
 *  still be described. Capped with oldest-out eviction — a long session must not leak. */
export interface CachedIdentity {
  name: string;
  type: string;
  parentName: string | null;
  page: string;
  /** The page's ID as well as its name. A name is not an identity (two pages may share
   *  one), and the idle re-walk needs the id to know which page to walk — a DELETE arrives
   *  with no parent chain at all, so this cache is the only record of where the node was. */
  pageId: string;
}

export const EDIT_IDENTITY_CACHE_CAP = 2_000;

export interface EditIdentityCache {
  get: (id: string) => CachedIdentity | undefined;
  remember: (id: string, value: CachedIdentity) => void;
  /** Live entry count — the eviction bound is a claim worth being able to check. */
  size: () => number;
}

export function createEditIdentityCache(cap: number = EDIT_IDENTITY_CACHE_CAP): EditIdentityCache {
  const entries = new Map<string, CachedIdentity>();
  return {
    get: (id) => entries.get(id),
    remember: (id, value) => {
      entries.set(id, value);
      if (entries.size > cap) {
        const oldestKey = entries.keys().next().value;
        if (oldestKey !== undefined) entries.delete(oldestKey);
      }
    },
    size: () => entries.size,
  };
}

export const ENCLOSING_NAME_HOP_CAP = 20;

/** Nearest enclosing FRAME/SECTION/COMPONENT/COMPONENT_SET above `node` — "where" the
 *  owner was working. Walks UP (not down), so it is O(depth), not O(tree). Null past
 *  the hop cap or when there is none (e.g. a direct child of the page). */
export function enclosingName(node: SceneNode): string | null {
  let n: BaseNode | null = node.parent;
  let hops = 0;
  while (n && hops < ENCLOSING_NAME_HOP_CAP) {
    if (n.type === 'FRAME' || n.type === 'SECTION' || n.type === 'COMPONENT' || n.type === 'COMPONENT_SET') {
      return n.name;
    }
    n = n.parent;
    hops += 1;
  }
  return null;
}
