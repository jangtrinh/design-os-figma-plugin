// `ui.slot.*` — Figma Slots (absorption phase-02). Adapted from the fork's slot
// handlers (MIT; see THIRD-PARTY.md): code.js:2837-3112 (create/list/append/reset),
// code.js:409-486 (list/target resolution). `addProperty`'s merge pattern is adapted
// from slot-tools.ts:291-377.
//
// Split across four files (this one plus -types/-resolve/-content/-property) to stay
// under the 200-line cap once verification + the fork's absorbed refusals were all
// written out — the same split-by-shape convention as exec-stdlib-instance.ts.
//
// Absorbed facts THIS file enforces (phase-02 spec §5; append/reset's facts are
// documented in exec-stdlib-slot-content.ts):
//  1. createSlot() takes NO arguments — rename-after-create IS the naming API.
//     `[re-verify]` — the fork's own claim, live-validated by THEM only (2026-07-09).
//  3. typeof node.createSlot !== 'function' ⇒ host too old for Slots. Kept even
//     though Slots is GA (June 2026) — an old Desktop build is a real user state.
//  4. GRID layoutMode is refused on a slot, BEFORE anything is created.
//  5. componentPropertyDefinitions throws on a variant COMPONENT — `list` never
//     needs it directly (it walks SLOT nodes, not property definitions), but the
//     SAME predicate class applies to resolving a COMPONENT_SET's variants below.
import { withCode } from './executor-styles';
import type { SlotAppendContent, SlotCreateOpts, SlotInfo, SlotTarget } from './exec-stdlib-slot-types';
import { resolveSlot, serializeSlotsFromNode } from './exec-stdlib-slot-resolve';
import { append, reset } from './exec-stdlib-slot-content';
import { addSlotProperty } from './exec-stdlib-slot-property';

const CREATE_LAYOUT_MODES = new Set(['NONE', 'HORIZONTAL', 'VERTICAL']);

async function create(componentId: string, opts: SlotCreateOpts = {}): Promise<{
  id: string; name: string; type: 'SLOT'; propertyKey: string | null; width: number; height: number; layoutMode: string;
}> {
  const node = await figma.getNodeByIdAsync(componentId);
  if (!node || node.type !== 'COMPONENT') {
    throw withCode(new Error(`componentId must be a COMPONENT node id (standalone or a variant inside a COMPONENT_SET — call once per variant), got ${node?.type ?? 'not found'}: ${componentId}`), 'E_INVALID_ARGS');
  }
  const target = node as ComponentNode & { createSlot?: () => SlotNode };
  if (typeof target.createSlot !== 'function') {
    throw withCode(new Error('createSlot() is not available — update Figma Desktop to a version with Slots support'), 'E_INVALID_ARGS');
  }
  // Fact 4: reject GRID before anything is created — not after the slot exists.
  if (opts.layoutMode && !CREATE_LAYOUT_MODES.has(opts.layoutMode)) {
    throw withCode(new Error(`layoutMode "${opts.layoutMode}" is not allowed on a slot — use NONE, HORIZONTAL, or VERTICAL`), 'E_INVALID_ARGS');
  }

  const slot = target.createSlot!();
  // Fact 1: createSlot() takes no name — renaming the returned node IS the naming API.
  if (opts.name) slot.name = opts.name;
  if (opts.layoutMode) slot.layoutMode = opts.layoutMode;
  if (opts.width !== undefined || opts.height !== undefined) {
    slot.resize(opts.width ?? slot.width, opts.height ?? slot.height);
  }

  // `slotContentId` is a real, live field the installed @figma/plugin-typings
  // doesn't type yet (the maturity conflict this phase's spec calls out) — read
  // through an untyped cast, same as exec-stdlib-slot-resolve.ts.
  let propertyKey: string | null = null;
  try {
    propertyKey = (slot.componentPropertyReferences as Record<string, string> | undefined)?.slotContentId ?? null;
  } catch { /* absent */ }

  // Verify: re-read the returned node's own state — never synthesise a propertyKey.
  if (slot.type !== 'SLOT') {
    throw withCode(new Error(`createSlot() returned a ${slot.type}, not SLOT`), 'E_EVAL');
  }
  return {
    id: slot.id, name: slot.name, type: 'SLOT', propertyKey,
    width: slot.width, height: slot.height, layoutMode: slot.layoutMode || 'NONE',
  };
}

async function list(nodeId: string): Promise<{ nodeId: string; nodeType: string; slots: SlotInfo[]; count: number }> {
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node || (node.type !== 'COMPONENT' && node.type !== 'INSTANCE' && node.type !== 'COMPONENT_SET')) {
    throw withCode(new Error(`nodeId must be a COMPONENT, COMPONENT_SET, or INSTANCE, got ${node?.type ?? 'not found'}: ${nodeId}`), 'E_INVALID_ARGS');
  }
  let slots: SlotInfo[];
  if (node.type === 'COMPONENT_SET') {
    // Fact 6: a COMPONENT_SET has one SLOT per variant pointing at the same
    // property — tag each with which variant it came from, one entry per variant.
    slots = (node.children as SceneNode[])
      .filter((c): c is ComponentNode => c.type === 'COMPONENT')
      .flatMap((variant) => serializeSlotsFromNode(variant).map((s) => ({ ...s, variantId: variant.id, variantName: variant.name })));
  } else {
    slots = serializeSlotsFromNode(node);
  }
  return { nodeId: node.id, nodeType: node.type, slots, count: slots.length };
}

export interface ExecStdlibSlot {
  create(componentId: string, opts?: SlotCreateOpts): ReturnType<typeof create>;
  list(nodeId: string): ReturnType<typeof list>;
  append(target: SlotTarget, content: SlotAppendContent, opts?: { clearExisting?: boolean }): Promise<{
    slot: { id: string; name: string }; appended: { id: string; name: string; type: string; width: number; height: number };
  }>;
  reset(target: SlotTarget): Promise<{ slot: { id: string; name: string; childCount: number } }>;
  addProperty(componentId: string, propertyName: string, frameNodeId: string, opts?: {
    description?: string; preferredValues?: { type: 'COMPONENT' | 'COMPONENT_SET'; key: string }[];
  }): Promise<{ propertyKey: string; frameId: string; frameName: string }>;
}

export function createExecStdlibSlot(): ExecStdlibSlot {
  return { create, list, append, reset, addProperty: addSlotProperty };
}

export { resolveSlot };
