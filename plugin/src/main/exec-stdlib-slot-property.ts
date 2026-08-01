// `ui.slot.addProperty` (absorption phase-02) — the manual SLOT-property path,
// adapted from slot-tools.ts:291-377 (MIT; see THIRD-PARTY.md). Alternative to
// `ui.slot.create` for binding an EXISTING frame as slot content.
//
// Absorbed fact 11, each clause enforced:
//  - `componentPropertyReferences` is MERGED, never assigned — a fresh object would
//    wipe an existing binding on the frame (e.g. a BOOLEAN property driving `visible`).
//  - Frame must be a direct child of the component, or of a variant of the target set.
//  - Frame must not use GRID layout.
//  - Frame must not be nested inside another slot — the fork's own tool description
//    claims this but its code never actually checks it; enforced here for real, by
//    walking the frame's ancestors up to (not including) the component/set.
import { withCode } from './executor-styles';
import { requireDesignFile } from './exec-stdlib-editor';

function isNestedInsideAnotherSlot(frame: SceneNode, stopAt: BaseNode): boolean {
  let n: BaseNode | null = frame.parent;
  while (n && n !== stopAt) {
    if (n.type === 'SLOT') return true;
    n = 'parent' in n ? n.parent : null;
  }
  return false;
}

export async function addSlotProperty(
  componentId: string,
  propertyName: string,
  frameNodeId: string,
  opts: { description?: string; preferredValues?: { type: 'COMPONENT' | 'COMPONENT_SET'; key: string }[] } = {},
): Promise<{ propertyKey: string; frameId: string; frameName: string }> {
  // Design-file-only capability: `addComponentProperty` only exists on a
  // COMPONENT/COMPONENT_SET, neither of which any FigJam board or Slides deck
  // can ever contain — refuse before either node lookup.
  requireDesignFile('ui.slot.addProperty');
  const component = await figma.getNodeByIdAsync(componentId);
  if (!component || (component.type !== 'COMPONENT' && component.type !== 'COMPONENT_SET')) {
    throw withCode(new Error(`componentId must be a COMPONENT or COMPONENT_SET, got ${component?.type ?? 'not found'}: ${componentId}`), 'E_INVALID_ARGS');
  }
  const frame = await figma.getNodeByIdAsync(frameNodeId);
  if (!frame || frame.type !== 'FRAME') {
    throw withCode(new Error(`frameNodeId must be a FRAME, got ${frame?.type ?? 'not found'}: ${frameNodeId}`), 'E_INVALID_ARGS');
  }
  // Checked BEFORE the direct-child test: a frame sitting inside another slot is
  // ALSO not a direct child of `component`, but "nested inside another slot" is the
  // specific, actionable diagnosis — the generic "must be a direct child" message
  // would be true but useless here.
  if (isNestedInsideAnotherSlot(frame, component)) {
    throw withCode(new Error(`frame "${frame.name}" is nested inside another slot — a slot's content frame cannot itself sit inside a different slot`), 'E_INVALID_ARGS');
  }
  const directChild = frame.parent === component;
  const variantChild = component.type === 'COMPONENT_SET'
    && frame.parent?.type === 'COMPONENT' && frame.parent.parent === component;
  if (!directChild && !variantChild) {
    throw withCode(new Error(
      component.type === 'COMPONENT_SET'
        ? `frame must be a direct child of one of "${component.name}"'s variant components`
        : `frame must be a direct child of "${component.name}"`,
    ), 'E_INVALID_ARGS');
  }
  if (frame.layoutMode === 'GRID') {
    throw withCode(new Error(`frame "${frame.name}" uses GRID layout — not allowed as slot content`), 'E_INVALID_ARGS');
  }

  const typedComponent = component as (ComponentNode | ComponentSetNode) & {
    addComponentProperty(name: string, type: 'SLOT', value: string, opts?: Record<string, unknown>): string;
    deleteComponentProperty(name: string): void;
  };
  // Stage-4 fix (minor m1): same old-host defensiveness as `ui.slot.create` —
  // `addComponentProperty` reaches straight into the platform, so an old Desktop
  // build must refuse cleanly here too, not throw whatever raw error the platform
  // happens to produce.
  if (typeof typedComponent.addComponentProperty !== 'function') {
    throw withCode(new Error('addComponentProperty() is not available — update Figma Desktop to a version with Slots support'), 'E_INVALID_ARGS');
  }
  const propOpts: Record<string, unknown> = {};
  if (opts.description !== undefined) propOpts.description = opts.description;
  if (opts.preferredValues !== undefined) propOpts.preferredValues = opts.preferredValues;
  const propertyKey = typedComponent.addComponentProperty(
    propertyName, 'SLOT', '', Object.keys(propOpts).length ? propOpts : undefined,
  );

  // Stage-4 fix (BLOCKER 2): everything from here on can fail (the frame-side
  // write, or either verify re-read) — and unlike a create-then-verify pair with
  // no side effect on failure, `addComponentProperty` above already mutated the
  // component. A failure past this point must not leave an unlinked property
  // silently sitting on the component, unmentioned in the thrown error.
  //
  // Deleting it here is safe SPECIFICALLY because `propertyKey` was minted in this
  // same synchronous call, on the single-threaded plugin main thread: nothing else
  // running in this same tick could have referenced, bound to, or come to depend on
  // it between the mint above and the failure below. This cleanup only ever
  // touches the property THIS call just created — it must never be generalised to
  // delete a pre-existing property another variant (or another call) may depend on.
  try {
    // Merge, never assign — a fresh object would wipe an existing binding (e.g. a
    // BOOLEAN property driving `visible`).
    const frameTyped = frame as FrameNode & { componentPropertyReferences?: Record<string, string> };
    frameTyped.componentPropertyReferences = { ...frameTyped.componentPropertyReferences, slotContentId: propertyKey };

    // Verify: re-read both sides of the link.
    const defs = (component as ComponentNode | ComponentSetNode).componentPropertyDefinitions;
    if (!defs?.[propertyKey]) {
      throw withCode(new Error(`addProperty applied but "${propertyKey}" is not in componentPropertyDefinitions`), 'E_EVAL');
    }
    if (frameTyped.componentPropertyReferences?.slotContentId !== propertyKey) {
      throw withCode(new Error(`addProperty applied but frame "${frame.name}" is not linked to "${propertyKey}"`), 'E_EVAL');
    }
  } catch (err) {
    const original = err instanceof Error ? err : new Error(String(err));
    try {
      typedComponent.deleteComponentProperty(propertyKey);
    } catch (cleanupErr) {
      // Fallback honesty: if the rollback itself fails, do not pretend it worked —
      // name the leftover key so it is traceable, on top of the original failure.
      throw withCode(
        new Error(`${original.message} — additionally, cleanup of the unlinked property "${propertyKey}" failed: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`),
        (original as Error & { code?: string }).code ?? 'E_EVAL',
      );
    }
    throw original;
  }

  return { propertyKey, frameId: frame.id, frameName: frame.name };
}
