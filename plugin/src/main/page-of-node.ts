// The one upward walk from a node to its PAGE, shared by every main-thread caller: the
// connector layer (a connector is parented to a page, never inside a frame) and
// `documentchange` capture (the feed files each edit under the page it happened on).
//
// One implementation on purpose. A second copy with its own bound is how a deeply nested
// node's edit came to be filed under whatever page the designer was looking at instead of
// its own — a wrong fact, written into the feed and cached from there.
//
// Unbounded by design: a parent chain is finite (it terminates at the document), and the
// walk is O(depth), never O(tree). Depth alone must never cost a caller the page.

/** The PAGE a node lives on, or null when it has none (an orphaned/detached node). Returns
 *  the node itself so callers get its id as well as its name — a page NAME is not an
 *  identity, since two pages may share one. Never invents a page; the caller decides what
 *  an unresolved page means. */
export function pageOf(node: BaseNode): PageNode | null {
  let current: BaseNode | null = node;
  while (current) {
    if (current.type === 'PAGE') return current;
    current = current.parent;
  }
  return null;
}
