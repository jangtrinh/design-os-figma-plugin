// Slot lookup/serialization shared by `create`+`list` (exec-stdlib-slot.ts) and
// `append`+`reset` (exec-stdlib-slot-content.ts) — kept separate so neither of those
// files has to import the other (would be circular).
import { withCode } from './executor-styles';
import type { SlotInfo, SlotTarget } from './exec-stdlib-slot-types';

/** `componentPropertyReferences.slotContentId` is a REAL, live field (Figma Slots,
 * GA June 2026) but `@figma/plugin-typings` (installed: ^1.130.0) has not caught up
 * with it — `ComponentPropertyReferences` only types `characters`/`visible`/
 * `mainComponent`. This is exactly the maturity conflict the phase spec calls out;
 * read it through an untyped cast rather than widen the ambient type ourselves. */
function readSlotContentId(node: { componentPropertyReferences?: unknown }): string | null {
  const refs = node.componentPropertyReferences as Record<string, string> | undefined;
  return refs?.slotContentId ?? null;
}

export function serializeSlotsFromNode(root: ComponentNode | InstanceNode): SlotInfo[] {
  const slotNodes = root.findAllWithCriteria({ types: ['SLOT'] });
  return slotNodes.map((slot) => {
    let propertyKey: string | null = null;
    try { propertyKey = readSlotContentId(slot); } catch { /* absent */ }
    let children: { id: string; name: string; type: string }[] = [];
    try { children = slot.children.map((c) => ({ id: c.id, name: c.name, type: c.type })); } catch { /* inaccessible sublayer */ }
    return {
      id: slot.id, name: slot.name, type: 'SLOT' as const, width: slot.width, height: slot.height,
      layoutMode: slot.layoutMode || 'NONE', propertyKey, children,
    };
  });
}

/** Resolve a slot node from {slotId} or {instanceId, slotName}. STRICTER than the
 * fork (absorbed fact 10): ≥2 DIRECT matches throws ambiguous, never silently
 * takes [0] — the same rule byPath already sets (exec-stdlib.ts:96-101). */
export async function resolveSlot(target: SlotTarget): Promise<SlotNode> {
  if (target.slotId) {
    const node = await figma.getNodeByIdAsync(target.slotId);
    if (!node) throw withCode(new Error(`slot not found: ${target.slotId}`), 'E_INVALID_ARGS');
    if (node.type !== 'SLOT') throw withCode(new Error(`node is not a SLOT, got ${node.type}: ${target.slotId}`), 'E_INVALID_ARGS');
    return node;
  }
  if (target.instanceId && target.slotName) {
    const inst = await figma.getNodeByIdAsync(target.instanceId);
    if (!inst) throw withCode(new Error(`instance not found: ${target.instanceId}`), 'E_INVALID_ARGS');
    if (inst.type !== 'INSTANCE') throw withCode(new Error(`instanceId must be an INSTANCE, got ${inst.type}`), 'E_INVALID_ARGS');
    const all = inst.findAllWithCriteria({ types: ['SLOT'] });
    const named = all.filter((n) => n.name === target.slotName);
    if (named.length === 0) {
      throw withCode(new Error(`slot "${target.slotName}" not found on instance — available: ${all.map((n) => n.name).join(', ') || '(none)'}`), 'E_INVALID_ARGS');
    }
    const direct = named.filter((n) => n.parent === inst);
    if (direct.length > 1) {
      throw withCode(new Error(`slot "${target.slotName}" is ambiguous — ${direct.length} direct matches: ${direct.map((n) => n.id).join(', ')}`), 'E_INVALID_ARGS');
    }
    if (direct.length === 1) return direct[0]!;
    if (named.length > 1) {
      throw withCode(new Error(`slot "${target.slotName}" is ambiguous — ${named.length} nested matches, no direct child: ${named.map((n) => n.id).join(', ')}`), 'E_INVALID_ARGS');
    }
    return named[0]!;
  }
  throw withCode(new Error('append/reset need slotId, or instanceId + slotName'), 'E_INVALID_ARGS');
}
