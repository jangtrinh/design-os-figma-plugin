// Shared node resolution for `ui.slides.*` (absorption phase-04). Every helper that
// targets a specific slide resolves through here — one place enforcing absorbed
// fact 3: a caller's id may be stale (ids go stale across sessions), so the type is
// asserted AFTER `getNodeByIdAsync`, never trusted from the caller's own claim of
// what the id names (fork's own pattern, e.g. code.js:6580-6582).
import { withCode } from './executor-styles';

export async function resolveSlide(slideId: string, capability: string): Promise<SlideNode> {
  const node = await figma.getNodeByIdAsync(slideId);
  if (!node) throw withCode(new Error(`${capability}: node not found: ${slideId}`), 'E_INVALID_ARGS');
  if (node.type !== 'SLIDE') {
    throw withCode(new Error(`${capability}: node ${slideId} is a ${node.type}, not a SLIDE`), 'E_INVALID_ARGS');
  }
  return node as SlideNode;
}
