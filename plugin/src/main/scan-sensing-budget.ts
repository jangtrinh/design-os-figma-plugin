// The time budget of the sensing step and the one walk it shares.
//
// SENSING_BUDGET_MS: SCAN_DESIGN_SYSTEM's default per-attempt timeout is 30_000 ms
// (shared/protocol.ts) and the existing scan work runs BEFORE sensing inside that same
// command. 15_000 ms for the new work leaves the other half of the window for the existing
// scan's own time and for the reply to cross the wire, so a slow file degrades to
// "sensing skipped" instead of a timed-out scan that loses fields which worked before.

export const SENSING_BUDGET_MS = 15_000;
/** Concurrent `getMainComponentAsync` lookups in flight. */
export const LOOKUP_CONCURRENCY = 16;
const CLOCK_CHECK_EVERY = 64;

export class SensingBudgetExceeded extends Error {
  constructor() { super('time-budget-exceeded'); }
}

export class SensingBudget {
  private ticks = 0;
  private readonly deadline: number;
  constructor(budgetMs: number = SENSING_BUDGET_MS, private readonly now: () => number = Date.now) {
    this.deadline = now() + budgetMs;
  }
  /** Milliseconds left before the deadline (never negative). */
  remainingMs(): number { return Math.max(0, this.deadline - this.now()); }
  /** Throws when the deadline has passed. */
  check(): void { if (this.now() > this.deadline) throw new SensingBudgetExceeded(); }
  /** Cheap per-node hook: reads the clock once per CLOCK_CHECK_EVERY nodes. */
  tick(): void { if (++this.ticks % CLOCK_CHECK_EVERY === 0) this.check(); }
}

/**
 * The instance boundary: visits `root` and everything below it through frames, groups and
 * sections, but stops at an INSTANCE — the instance itself is visited, its descendants are
 * not (they belong to that component's own entry, and instance subtrees are most of the
 * nodes of a real file). A `children` read that throws propagates: a half-walked subtree
 * would assert a list the scan never fully saw.
 */
export function walkToInstanceBoundary(
  root: SceneNode,
  visit: (n: SceneNode) => void,
  budget: SensingBudget,
  /** Frame walks: a component or set definition met below the root is a boundary too —
   *  neither visited nor descended (its content belongs to its own entry). */
  skipComponentDefinitions = false,
): void {
  const stack: SceneNode[] = [root];
  while (stack.length > 0) {
    const n = stack.pop() as SceneNode;
    if (skipComponentDefinitions && n !== root && (n.type === 'COMPONENT' || n.type === 'COMPONENT_SET')) continue;
    budget.tick();
    visit(n);
    if (n.type === 'INSTANCE' && n !== root) continue;
    if ('children' in n) for (const k of (n as SceneNode & ChildrenMixin).children) stack.push(k);
  }
}
