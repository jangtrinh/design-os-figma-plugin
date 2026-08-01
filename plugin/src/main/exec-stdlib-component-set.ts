// `ui.componentSet(...)` — build a COMPONENT_SET from a variant matrix or existing
// components (absorption phase-01, Basket B). Adapted from the fork's
// figma_create_component_set (MIT; see THIRD-PARTY.md) — the mode contract, the
// axis/value `=`/`,` ban, and the 100-combination cap are its constraints, ported
// deliberately. NOT ported: its manual clone/rename rollback bookkeeping AS A
// GENERAL-PURPOSE SYSTEM — this repo's own EXEC_JS `--undo-group`
// (executor-exec-js.ts) already gives a caller one atomic undo step over the WHOLE
// script via Figma's own undo stack. What IS ported, narrowly: this function still
// cleans up its OWN mutations (rename/clone) if ITS OWN later step throws — see
// exec-stdlib-component-build.ts's `cleanup()`. That is a compensating action scoped
// to this one call, not a second undo system, and it does not substitute for
// `--undo-group`, which a caller MUST use for atomicity against a failure elsewhere
// in the same script (stated in knowledge/component-sets.md).
import { withCode } from './executor-styles';
import { WARN_ABOVE, parseComboName, sameAxisMap } from './exec-stdlib-component-matrix';
import { buildModeA, buildModeB } from './exec-stdlib-component-build';
import { safeCleanup } from '../../../shared/safe-cleanup';
import { requireDesignFile } from './exec-stdlib-editor';

export interface ComponentSetOpts {
  base?: string;
  axes?: Record<string, string[]>;
  components?: string[];
  variantProps?: Record<string, string>[];
  name?: string;
  parent?: string;
  x?: number;
  y?: number;
}

export interface ComponentSetResult {
  id: string;
  name: string;
  variantCount: number;
  variants: { id: string; name: string; key: string; axes: Record<string, string> }[];
  propertyDefinitions: Record<string, unknown>;
  sizeWarning?: string;
  // Additive beyond the plan's named shape (deliberate, reported): mode 2 without
  // variantProps can leave a component named without "=", which Figma silently
  // re-homes under "Property 1=<name>" — surfacing that as a runtime warning
  // seemed more honest than only saying it in the recipe prose.
  warnings?: string[];
}

// Real containers a COMPONENT_SET can sensibly live in. `appendChild in node` alone
// (the previous check) also passes for COMPONENT/COMPONENT_SET/INSTANCE — nodes that
// combineAsVariants would only reject LATER, after the build step already renamed
// the base and cloned it (stage-4 review, PR #10 minor 6 — one guard earlier than
// issue 2's own self-inflicted-mutation window).
const VALID_PARENT_TYPES = new Set(['PAGE', 'FRAME', 'SECTION', 'GROUP']);

async function resolveParent(ref: string | undefined): Promise<BaseNode & ChildrenMixin> {
  if (!ref) return figma.currentPage;
  const node = await figma.getNodeByIdAsync(ref);
  if (!node || !VALID_PARENT_TYPES.has(node.type)) {
    throw withCode(new Error(`parent not found or cannot contain a component set: ${ref}`), 'E_INVALID_ARGS');
  }
  return node as BaseNode & ChildrenMixin;
}

async function componentSet(opts: ComponentSetOpts): Promise<ComponentSetResult> {
  // Design-file-only capability: refuse outside the Figma design editor before
  // touching a node — `figma.combineAsVariants` only exists there, and a caller
  // that opened the wrong editor deserves that answer before its args are even
  // validated, not a downstream "not found" once a node lookup already ran.
  requireDesignFile('ui.componentSet');
  const hasBase = typeof opts.base === 'string';
  const hasComponents = Array.isArray(opts.components) && opts.components.length > 0;
  if (hasBase === hasComponents) {
    throw withCode(new Error('componentSet needs exactly one of: base + axes, or components'), 'E_INVALID_ARGS');
  }
  if (hasBase && (!opts.axes || Object.keys(opts.axes).length === 0)) {
    throw withCode(new Error('axes is required with base — e.g. { State: ["default","hover"], Size: ["sm","lg"] }'), 'E_INVALID_ARGS');
  }
  const build = hasBase
    ? await buildModeA(opts.base!, opts.axes!)
    : await buildModeB(opts.components!, opts.variantProps);

  // Everything below can fail AFTER build already renamed/cloned — on any throw in
  // this window, reverse exactly what build() did, then let the original error
  // (code and message intact) propagate. This is the ruling from the reviewer's
  // question: restore independently of WHY it failed, not only on a verify mismatch.
  try {
    const parent = await resolveParent(opts.parent);
    const set = figma.combineAsVariants(build.nodes, parent);
    if (opts.name) set.name = opts.name;
    if (typeof opts.x === 'number') set.x = opts.x;
    if (typeof opts.y === 'number') set.y = opts.y;

    // Verify: the combined set's own children must match what we intended — a
    // mismatch (Figma's own name-parsing disagreeing with ours) throws with both
    // lists rather than reporting a count that quietly drifted from reality.
    const children = set.children.filter((c): c is ComponentNode => c.type === 'COMPONENT');
    if (children.length !== build.nodes.length) {
      throw withCode(new Error(`componentSet combined ${children.length} children, expected ${build.nodes.length}`), 'E_EVAL');
    }
    const actualAxes = children.map((c) => parseComboName(c.name));
    const mismatches = build.expected
      .map((exp, i) => ({ i, exp, actual: actualAxes[i] }))
      .filter(({ exp, actual }) => !actual || !sameAxisMap(exp, actual));
    if (mismatches.length > 0) {
      throw withCode(new Error(`componentSet variant names did not parse back to the intended axes: ${JSON.stringify(mismatches)}`), 'E_EVAL');
    }

    const propertyDefinitions = (set.componentPropertyDefinitions ?? {}) as Record<string, unknown>;
    const variantCount = children.length;
    const sizeWarning = variantCount > WARN_ABOVE
      ? `${variantCount} variants — large sets are slow to build; consider splitting by one axis`
      : undefined;

    return {
      id: set.id,
      name: set.name,
      variantCount,
      // Each variant's key AND id — instances come from a variant's key/id, never
      // the set's (fork's hint, write-tools.ts ~3040).
      variants: children.map((c, i) => ({ id: c.id, name: c.name, key: c.key, axes: actualAxes[i]! })),
      propertyDefinitions,
      ...(sizeWarning ? { sizeWarning } : {}),
      ...(build.warnings.length ? { warnings: build.warnings } : {}),
    };
  } catch (err) {
    // The ORIGINAL error is what the caller must see, always — cleanup() runs on a
    // best-effort basis over live Figma state (removing a clone, restoring a name),
    // and can itself throw (a locked node, a clone something else already removed).
    // A throwing cleanup must never replace the failure that triggered it (stage-4
    // follow-up, issue #11 item 1); centralized in `safeCleanup` (issue #24) so this
    // guarantee lives in one place instead of being re-derived per call site.
    safeCleanup(err, () => build.cleanup());
  }
}

export interface ExecStdlibComponentSet {
  componentSet(opts: ComponentSetOpts): Promise<ComponentSetResult>;
}

export function createExecStdlibComponentSet(): ExecStdlibComponentSet {
  return { componentSet };
}
