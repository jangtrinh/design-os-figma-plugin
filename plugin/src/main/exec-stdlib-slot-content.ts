// `ui.slot.append` / `ui.slot.reset` (absorption phase-02). Adapted from the fork's
// APPEND_TO_SLOT / RESET_SLOT handlers (MIT; see THIRD-PARTY.md), code.js:2956-3112.
//
// Absorbed facts enforced here (phase-02 spec §5):
//  7. A raw COMPONENT cannot be appended, guarded BEFORE cloning — cloning a
//     ComponentNode makes another ComponentNode, so cloning first leaks an orphan
//     main component.
//  8. clearExisting runs ONLY after the content resolves — the fork's earlier
//     version cleared first, so a bad sourceNodeId emptied the slot and THEN
//     errored. Preserve this order.
//  9. A cloned node keeps its old x/y and can render invisible inside a NONE-layout
//     slot; snap to 0,0 there. `[re-verify]` ours — the fork's fix was live-validated
//     by them only.
// Reduced scope vs. the fork's content.nodeType (deliberate, reported): supports
// RECTANGLE/FRAME/TEXT only, not the fork's full 8-type set — the mock and the
// common case both cover these three; the rest are a mechanical follow-up if a real
// task needs them.
import { withCode } from './executor-styles';
import type { SlotAppendContent, SlotTarget } from './exec-stdlib-slot-types';
import { resolveSlot } from './exec-stdlib-slot-resolve';
import { requireDesignFile } from './exec-stdlib-editor';

async function createSlotContentNode(nodeType: string, props: Record<string, string | number>): Promise<SceneNode> {
  let node: SceneNode;
  switch (nodeType) {
    case 'RECTANGLE': node = figma.createRectangle(); break;
    case 'FRAME': node = figma.createFrame(); break;
    case 'TEXT': {
      const text = figma.createText();
      await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
      text.fontName = { family: 'Inter', style: 'Regular' };
      if (props.text !== undefined) text.characters = String(props.text);
      node = text;
      break;
    }
    default:
      throw withCode(new Error(`unsupported content.nodeType "${nodeType}" — supported: RECTANGLE, FRAME, TEXT`), 'E_INVALID_ARGS');
  }
  if (props.name !== undefined) node.name = String(props.name);
  if (props.width !== undefined || props.height !== undefined) {
    const w = props.width !== undefined ? Number(props.width) : node.width;
    const h = props.height !== undefined ? Number(props.height) : node.height;
    if (!Number.isNaN(w) && !Number.isNaN(h)) node.resize(w, h);
  }
  return node;
}

export async function append(
  target: SlotTarget,
  content: SlotAppendContent,
  opts: { clearExisting?: boolean } = {},
): Promise<{ slot: { id: string; name: string }; appended: { id: string; name: string; type: string; width: number; height: number } }> {
  // Design-file-only capability: a SLOT node only exists on a COMPONENT, never
  // in FigJam or Slides — refuse before resolving the target.
  requireDesignFile('ui.slot.append');
  const slotNode = await resolveSlot(target);

  // Prepare content FIRST — a validation failure must not leave the slot
  // half-mutated (fact 8).
  let appendedNode: SceneNode;
  if (content.sourceNodeId) {
    const source = await figma.getNodeByIdAsync(content.sourceNodeId);
    if (!source) throw withCode(new Error(`source node not found: ${content.sourceNodeId}`), 'E_INVALID_ARGS');
    // Fact 7: guard BEFORE cloning.
    if (source.type === 'COMPONENT') {
      throw withCode(new Error('a COMPONENT cannot be appended directly to a slot — create an INSTANCE first, or clone an existing instance'), 'E_INVALID_ARGS');
    }
    appendedNode = content.clone !== false ? (source as SceneNode).clone() : (source as SceneNode);
  } else if (content.nodeType) {
    appendedNode = await createSlotContentNode(content.nodeType, content.props ?? {});
  } else {
    throw withCode(new Error('append needs content.sourceNodeId (clone/move existing) or content.nodeType (create new)'), 'E_INVALID_ARGS');
  }

  // Fact 8: clear existing children ONLY now that content is ready.
  if (opts.clearExisting) {
    for (const child of [...slotNode.children]) child.remove();
  }

  slotNode.appendChild(appendedNode);

  // Fact 9: snap position in a NONE-layout slot; leave auto-layout slots to Figma.
  if (!slotNode.layoutMode || slotNode.layoutMode === 'NONE') {
    try { appendedNode.x = 0; appendedNode.y = 0; } catch { /* locked/readonly — leave as-is */ }
  }

  // Verify: re-read the slot's children for the appended id.
  if (!slotNode.children.some((c) => c.id === appendedNode.id)) {
    throw withCode(new Error(`append applied but "${appendedNode.id}" is not in slot "${slotNode.name}"'s children`), 'E_EVAL');
  }

  return {
    slot: { id: slotNode.id, name: slotNode.name },
    appended: {
      id: appendedNode.id, name: appendedNode.name, type: appendedNode.type,
      width: appendedNode.width, height: appendedNode.height,
    },
  };
}

export async function reset(target: SlotTarget): Promise<{ slot: { id: string; name: string; childCount: number } }> {
  // Design-file-only capability: same reasoning as `append`.
  requireDesignFile('ui.slot.reset');
  const slotNode = await resolveSlot(target);
  const typed = slotNode as SlotNode & { resetSlot?: () => void };
  if (typeof typed.resetSlot !== 'function') {
    throw withCode(new Error('resetSlot() is not available on this node — ensure Figma Desktop supports Slots'), 'E_INVALID_ARGS');
  }
  typed.resetSlot();
  return { slot: { id: slotNode.id, name: slotNode.name, childCount: slotNode.children?.length ?? 0 } };
}
