// The additive sensing fields of SCAN_DESIGN_SYSTEM (field shape version 1):
//   components[].boundVariables  sorted unique variable ids (see scan-bound-variables.ts)
//   components[].instances       [{component, count}] components used directly inside it
//   frames[]                     page frames (also inside sections) with their instances
//   sensing                      {status: "complete"} or {status: "skipped", reason}
// The plugin only SENSES; the kernel judges which variable is a token and which page holds
// screens. Rules: the walk stops at an instance (scan-sensing-budget.ts); every instance is
// resolved through the ASYNC main-component lookup (the sync getter throws under
// dynamic-page); a lookup that returns nothing, throws, or returns a local component that
// is no longer in the document (no parent, not remote) is NOT given a `component` — it is
// counted in `unresolvedInstances` (on a frame and on a component or set, summed over its
// variants), written only when above 0. A component or set never lists ITSELF in its own
// `instances` (a variant using a sibling variant of the same set folds to the set's id): the
// count is dropped by rule, it carries nothing for the closure and would only make a cycle. `component` carries no
// marker: a local id looks like `<n>:<n>`, a library key is a hex string.
// Sensing runs after the existing result is complete and can never fail the scan: on any
// throw or on budget overrun the caller keeps the pre-feature result plus `skipped`.
import { collectOwnBindings } from './scan-bound-variables';
import { r2 } from './scan-node-utils';
import { LOOKUP_CONCURRENCY, SensingBudget, SensingBudgetExceeded, walkToInstanceBoundary } from './scan-sensing-budget';

export interface InstanceCount { component: string; count: number }
export interface ScannedFrame {
  id: string;
  name: string;
  page: { id: string; name: string };
  /** Innermost enclosing section; absent for a direct child of the page. */
  section?: string;
  w: number;
  h: number;
  instances: InstanceCount[];
  /** Present only when > 0. */
  unresolvedInstances?: number;
}
export type Sensing = { status: 'complete' } | { status: 'skipped'; reason: string };

/** True for a COMPONENT folded into its COMPONENT_SET's entry (no entry of its own). */
export function isFoldedVariant(n: SceneNode): boolean {
  return n.type === 'COMPONENT' && !!n.parent && n.parent.type === 'COMPONENT_SET';
}

/** The `component` value of a resolved main component, or null when it cannot be named. */
function componentRefOf(main: ComponentNode): string | null {
  const set = main.parent && main.parent.type === 'COMPONENT_SET' ? (main.parent as ComponentSetNode) : null;
  const target = set ?? main;
  if (main.remote === true || target.remote === true) return target.key || null;
  // A local component with no parent was removed from the document: it names nothing.
  return main.parent ? target.id || null : null;
}

/** Race a lookup against what is left of the budget: a promise that never settles must not
 *  keep the sensing step pending past its budget (the command would time out and the scan
 *  would lose every field). The budget winning throws; the lookup's own failure is `null`. */
async function lookupRef(inst: InstanceNode, budget: SensingBudget): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SensingBudgetExceeded()), budget.remainingMs());
  });
  const lookup = (async (): Promise<string | null> => {
    try {
      const main = await inst.getMainComponentAsync();
      return main ? componentRefOf(main) : null;
    } catch {
      return null;
    }
  })();
  try {
    return await Promise.race([lookup, expired]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Resolve instances with bounded concurrency; counts per component, sorted. */
async function countInstances(insts: readonly InstanceNode[], budget: SensingBudget): Promise<{ instances: InstanceCount[]; unresolved: number }> {
  const refs: Array<string | null> = new Array(insts.length).fill(null);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < insts.length) {
      const i = next++;
      budget.check();
      refs[i] = await lookupRef(insts[i], budget);
    }
  };
  await Promise.all(Array.from({ length: Math.min(LOOKUP_CONCURRENCY, insts.length) }, worker));
  const counts = new Map<string, number>();
  let unresolved = 0;
  for (const ref of refs) {
    if (ref === null) unresolved++;
    else counts.set(ref, (counts.get(ref) ?? 0) + 1);
  }
  const instances = [...counts].map(([component, count]) => ({ component, count })).sort((a, b) => byCode(a.component, b.component));
  return { instances, unresolved };
}

/**
 * Walk one root under the instance boundary: its instance nodes and, for a component only,
 * its bound variable ids. A frame walk reads no binding field (cost) and treats a component
 * or set definition inside the frame as a boundary.
 */
function walkRoot(root: SceneNode, budget: SensingBudget, isComponent: boolean): { bound: Set<string>; insts: InstanceNode[] } {
  const bound = new Set<string>();
  const insts: InstanceNode[] = [];
  walkToInstanceBoundary(root, (n) => {
    if (isComponent) collectOwnBindings(n as unknown as Record<string, unknown>, bound);
    if (n.type === 'INSTANCE' && n !== root) insts.push(n as InstanceNode);
  }, budget, !isComponent);
  return { bound, insts };
}

/** Frames that are direct children of a page or of a section at any depth under it. */
function frameRoots(page: PageNode): Array<{ frame: FrameNode; section?: string }> {
  const out: Array<{ frame: FrameNode; section?: string }> = [];
  const visit = (container: ChildrenMixin, section?: string): void => {
    for (const child of container.children) {
      if (child.type === 'FRAME') out.push({ frame: child, section });
      else if (child.type === 'SECTION') visit(child, child.name);
    }
  };
  visit(page);
  return out;
}

export interface SensedDesignSystem {
  components: Record<string, unknown>[];
  frames: ScannedFrame[];
}

async function senseAll(
  components: readonly Record<string, unknown>[],
  componentNodes: readonly SceneNode[],
  pages: readonly PageNode[],
  budget: SensingBudget,
): Promise<SensedDesignSystem> {
  const nodeById = new Map(componentNodes.map((n) => [n.id, n]));
  const sensedComponents: Record<string, unknown>[] = [];
  for (const entry of components) {
    const node = nodeById.get(entry.id as string);
    if (!node) { sensedComponents.push(entry); continue; }
    const { bound, insts } = walkRoot(node, budget, true);
    const { instances, unresolved } = await countInstances(insts, budget);
    const sensed: Record<string, unknown> = {
      ...entry,
      boundVariables: [...bound].sort(byCode),
      instances: instances.filter((i) => i.component !== node.id), // no self-reference
    };
    if (unresolved > 0) sensed.unresolvedInstances = unresolved;
    sensedComponents.push(sensed);
  }
  const frames: ScannedFrame[] = [];
  for (const page of pages) {
    for (const { frame, section } of frameRoots(page)) {
      const { insts } = walkRoot(frame, budget, false);
      const { instances, unresolved } = await countInstances(insts, budget);
      const out: ScannedFrame = { id: frame.id, name: frame.name, page: { id: page.id, name: page.name } } as ScannedFrame;
      if (section !== undefined) out.section = section;
      out.w = r2(frame.width); out.h = r2(frame.height); out.instances = instances;
      if (unresolved > 0) out.unresolvedInstances = unresolved;
      frames.push(out);
    }
  }
  return { components: sensedComponents, frames };
}

/**
 * Add the sensing fields to an already-complete scan, or leave it untouched. Returns the
 * (possibly enriched) components and the extra top-level keys to append after `counts`.
 */
export async function applySensing(
  components: Record<string, unknown>[],
  componentNodes: readonly SceneNode[],
  pages: readonly PageNode[],
  budget: SensingBudget = new SensingBudget(),
): Promise<{ components: Record<string, unknown>[]; extra: Record<string, unknown> }> {
  try {
    const sensed = await senseAll(components, componentNodes, pages, budget);
    return { components: sensed.components, extra: { frames: sensed.frames, sensing: { status: 'complete' } satisfies Sensing } };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return { components, extra: { sensing: { status: 'skipped', reason } satisfies Sensing } };
  }
}
