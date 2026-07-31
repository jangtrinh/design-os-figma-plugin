// `ui.componentSet(...)` — build a COMPONENT_SET from a variant matrix or existing
// components (absorption phase-01, Basket B). Adapted from the fork's
// figma_create_component_set (MIT; see THIRD-PARTY.md) — the mode contract, the
// axis/value `=`/`,` ban, and the 100-combination cap are its constraints, ported
// deliberately. NOT ported: its manual clone/rename rollback bookkeeping — this repo's
// EXEC_JS `--undo-group` (executor-exec-js.ts) already gives a caller one atomic undo
// step over the whole script via Figma's own undo stack, so a second, hand-rolled
// rollback here would duplicate (and could race) what the bracket already guarantees.
// A caller who wants atomicity uses `--undo-group`, same as any other mutating script.
// Pure matrix helpers (cartesian product, name parsing, token validation) live in
// exec-stdlib-component-matrix.ts — split out to stay under this file's 200-line cap.
import { withCode } from './executor-styles';
import {
  MAX_VARIANTS, WARN_ABOVE, assertCleanToken, comboName, cartesianProduct, parseComboName, sameAxisMap,
} from './exec-stdlib-component-matrix';

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

async function resolveParent(ref: string | undefined): Promise<BaseNode & ChildrenMixin> {
  if (!ref) return figma.currentPage;
  const node = await figma.getNodeByIdAsync(ref);
  if (!node || !('appendChild' in node)) {
    throw withCode(new Error(`parent not found or cannot contain a component set: ${ref}`), 'E_INVALID_ARGS');
  }
  return node as BaseNode & ChildrenMixin;
}

async function buildModeA(base: string, axes: Record<string, string[]>): Promise<{ nodes: ComponentNode[]; expected: Record<string, string>[] }> {
  const baseNode = await figma.getNodeByIdAsync(base);
  if (!baseNode || baseNode.type !== 'COMPONENT') {
    throw withCode(new Error(`base must be a COMPONENT node id, got ${baseNode?.type ?? 'not found'}: ${base}`), 'E_INVALID_ARGS');
  }
  if (baseNode.parent?.type === 'COMPONENT_SET') {
    throw withCode(new Error(`base "${baseNode.name}" is already a variant inside "${baseNode.parent.name}"`), 'E_INVALID_ARGS');
  }
  const axisOrder = Object.keys(axes);
  for (const axis of axisOrder) {
    assertCleanToken('axis', axis);
    const values = axes[axis]!;
    if (values.length === 0) throw withCode(new Error(`axis "${axis}" has no values`), 'E_INVALID_ARGS');
    for (const v of values) assertCleanToken('value', v);
  }
  const combos = cartesianProduct(axes);
  if (combos.length > MAX_VARIANTS) {
    throw withCode(new Error(`${combos.length} variants requested — capped at ${MAX_VARIANTS}. Split by one axis and build multiple sets.`), 'E_INVALID_ARGS');
  }
  // Base becomes the first variant (keeps its node id — existing instances of the
  // base survive as instances of that variant); clones fill the rest, stacked
  // vertically so nothing overlaps before the caller lays the set out.
  const stepY = Math.ceil(baseNode.height) + 40;
  baseNode.name = comboName(combos[0]!, axisOrder);
  const nodes: ComponentNode[] = [baseNode];
  for (let i = 1; i < combos.length; i++) {
    const clone = baseNode.clone() as ComponentNode;
    clone.name = comboName(combos[i]!, axisOrder);
    clone.y = baseNode.y + i * stepY;
    nodes.push(clone);
  }
  return { nodes, expected: combos };
}

async function buildModeB(
  ids: string[],
  variantProps: Record<string, string>[] | undefined,
): Promise<{ nodes: ComponentNode[]; expected: Record<string, string>[]; warnings: string[] }> {
  if (ids.length > MAX_VARIANTS) {
    throw withCode(new Error(`${ids.length} components requested — capped at ${MAX_VARIANTS}.`), 'E_INVALID_ARGS');
  }
  if (variantProps && variantProps.length !== ids.length) {
    throw withCode(new Error(`variantProps length (${variantProps.length}) must match components length (${ids.length})`), 'E_INVALID_ARGS');
  }
  const nodes: ComponentNode[] = [];
  const expected: Record<string, string>[] = [];
  const warnings: string[] = [];
  for (let i = 0; i < ids.length; i++) {
    const node = await figma.getNodeByIdAsync(ids[i]!);
    if (!node || node.type !== 'COMPONENT') {
      throw withCode(new Error(`components[${i}] must be a COMPONENT node id, got ${node?.type ?? 'not found'}: ${ids[i]}`), 'E_INVALID_ARGS');
    }
    if (node.parent?.type === 'COMPONENT_SET') {
      throw withCode(new Error(`components[${i}] "${node.name}" is already a variant inside "${node.parent.name}"`), 'E_INVALID_ARGS');
    }
    if (variantProps) {
      const props = variantProps[i]!;
      const keys = Object.keys(props);
      if (keys.length === 0) throw withCode(new Error(`variantProps[${i}] is empty — needs at least one property`), 'E_INVALID_ARGS');
      for (const k of keys) { assertCleanToken('property', k); assertCleanToken('value', props[k]!); }
      node.name = comboName(props, keys);
      expected.push({ ...props });
    } else {
      // Figma turns a name lacking "=" into "Property 1=<name>" `[re-verify]` — warn
      // rather than silently accept an axis the caller did not choose (fork's own
      // warning shape, adapted). We did NOT rename this node, so there is no axis
      // map of OUR intent to verify against — asserting one would invent a fact the
      // `[re-verify]` tag says is still unconfirmed; the post-combine check below
      // only holds this node to "it survived", never to a fabricated axis map.
      if (!node.name.includes('=')) {
        warnings.push(`component "${node.name}" is not named "Prop=Value" — Figma will file it under "Property 1=${node.name}"`);
        expected.push({});
      } else {
        expected.push(parseComboName(node.name));
      }
    }
    nodes.push(node as ComponentNode);
  }
  return { nodes, expected, warnings };
}

async function componentSet(opts: ComponentSetOpts): Promise<ComponentSetResult> {
  const hasBase = typeof opts.base === 'string';
  const hasComponents = Array.isArray(opts.components) && opts.components.length > 0;
  if (hasBase === hasComponents) {
    throw withCode(new Error('componentSet needs exactly one of: base + axes, or components'), 'E_INVALID_ARGS');
  }
  let nodes: ComponentNode[];
  let expected: Record<string, string>[];
  let warnings: string[] = [];
  if (hasBase) {
    if (!opts.axes || Object.keys(opts.axes).length === 0) {
      throw withCode(new Error('axes is required with base — e.g. { State: ["default","hover"], Size: ["sm","lg"] }'), 'E_INVALID_ARGS');
    }
    ({ nodes, expected } = await buildModeA(opts.base!, opts.axes));
  } else {
    ({ nodes, expected, warnings } = await buildModeB(opts.components!, opts.variantProps));
  }
  const parent = await resolveParent(opts.parent);
  const set = figma.combineAsVariants(nodes, parent);
  if (opts.name) set.name = opts.name;
  if (typeof opts.x === 'number') set.x = opts.x;
  if (typeof opts.y === 'number') set.y = opts.y;

  // Verify: the combined set's own children must match what we intended — a
  // mismatch (Figma's own name-parsing disagreeing with ours) throws with both
  // lists rather than reporting a count that quietly drifted from reality.
  const children = set.children.filter((c): c is ComponentNode => c.type === 'COMPONENT');
  if (children.length !== nodes.length) {
    throw withCode(new Error(`componentSet combined ${children.length} children, expected ${nodes.length}`), 'E_EVAL');
  }
  const actualAxes = children.map((c) => parseComboName(c.name));
  const mismatches = expected
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
    ...(warnings.length ? { warnings } : {}),
  };
}

export interface ExecStdlibComponentSet {
  componentSet(opts: ComponentSetOpts): Promise<ComponentSetResult>;
}

export function createExecStdlibComponentSet(): ExecStdlibComponentSet {
  return { componentSet };
}
