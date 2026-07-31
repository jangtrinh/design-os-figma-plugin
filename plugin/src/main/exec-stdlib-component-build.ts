// Mode-specific node preparation behind `ui.componentSet(...)` — split out of
// exec-stdlib-component-set.ts to keep that file to one shape. Each build
// function mutates the canvas (renames, clones) and returns a `cleanup()` that
// reverses EXACTLY those mutations — the caller (componentSet()) invokes it if a
// LATER step (parent resolution, combineAsVariants, verification) throws, so a
// self-inflicted failure never leaves a renamed base or an orphan clone behind
// (stage-4 review, PR #10 issue 2). This is a compensating action for THIS helper's
// own mutations, not a second undo system — `--undo-group` still covers everything
// else in the script; knowledge/component-sets.md states that requirement plainly.
import { withCode } from './executor-styles';
import {
  MAX_VARIANTS, assertCleanToken, comboName, cartesianProduct, parseComboName,
} from './exec-stdlib-component-matrix';

export interface BuildResult {
  nodes: ComponentNode[];
  expected: Record<string, string>[];
  warnings: string[];
  /** Reverse exactly the mutations THIS build made — safe to call multiple times. */
  cleanup(): void;
}

export async function buildModeA(base: string, axes: Record<string, string[]>): Promise<BuildResult> {
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
  // Snapshot BEFORE any mutation — the ruling this cleanup follows: restore the
  // base's name on ANY later failure of this call, not only a verification mismatch
  // (stage-4 review reviewer question, ruled: yes, independent of issue 2's fix).
  const originalBaseName = baseNode.name;
  const stepY = Math.ceil(baseNode.height) + 40;
  baseNode.name = comboName(combos[0]!, axisOrder);
  const nodes: ComponentNode[] = [baseNode];
  for (let i = 1; i < combos.length; i++) {
    const clone = baseNode.clone() as ComponentNode;
    clone.name = comboName(combos[i]!, axisOrder);
    clone.y = baseNode.y + i * stepY;
    nodes.push(clone);
  }
  const clones = nodes.slice(1);
  return {
    nodes, expected: combos, warnings: [],
    cleanup(): void {
      for (const c of clones) c.remove();
      baseNode.name = originalBaseName;
    },
  };
}

export async function buildModeB(
  ids: string[],
  variantProps: Record<string, string>[] | undefined,
): Promise<BuildResult> {
  if (ids.length > MAX_VARIANTS) {
    throw withCode(new Error(`${ids.length} components requested — capped at ${MAX_VARIANTS}.`), 'E_INVALID_ARGS');
  }
  if (variantProps && variantProps.length !== ids.length) {
    throw withCode(new Error(`variantProps length (${variantProps.length}) must match components length (${ids.length})`), 'E_INVALID_ARGS');
  }

  // Pass 1 — resolve and validate EVERY input before mutating anything. A rejection
  // partway through must never leave an EARLIER component in this same call already
  // renamed with no closure (stage-4 follow-up, issue #11 item 3: fail before the
  // first mutation, not validate-then-rename per iteration).
  const resolved: ComponentNode[] = [];
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
    }
    resolved.push(node as ComponentNode);
  }

  // Pass 2 — every input is validated; only now do we mutate (rename via variantProps).
  const nodes: ComponentNode[] = [];
  const expected: Record<string, string>[] = [];
  const warnings: string[] = [];
  const renamed: { node: ComponentNode; originalName: string }[] = [];
  for (let i = 0; i < resolved.length; i++) {
    const node = resolved[i]!;
    if (variantProps) {
      const props = variantProps[i]!;
      const keys = Object.keys(props);
      renamed.push({ node, originalName: node.name });
      node.name = comboName(props, keys);
      expected.push({ ...props });
    } else {
      // Figma turns a name lacking "=" into "Property 1=<name>" `[re-verify]` — warn
      // rather than silently accept an axis the caller did not choose. We did NOT
      // rename this node, so there is no axis map of OUR intent to verify against —
      // the post-combine check only holds it to "it survived", never a fabricated map.
      if (!node.name.includes('=')) {
        warnings.push(`component "${node.name}" is not named "Prop=Value" — Figma will file it under "Property 1=${node.name}"`);
        expected.push({});
      } else {
        expected.push(parseComboName(node.name));
      }
    }
    nodes.push(node);
  }
  return {
    nodes, expected, warnings,
    cleanup(): void {
      for (const { node, originalName } of renamed) node.name = originalName;
    },
  };
}
