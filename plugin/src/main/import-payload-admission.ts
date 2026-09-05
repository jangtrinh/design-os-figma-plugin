import { validateImportPayload } from '../../../shared/figma-payload-validation';
import {
  createColorStyles, createEffectStyles, createTextStyles, getImportWarnings, resetImportWarnings,
} from './executor-styles';
import { createFigmaNode } from './executor-frame';
import { resetKeyedVariableCache } from './executor-keyed-vars';
import { resolveTokenVars } from './executor-token-var-resolve';

type Params = Record<string, unknown>;

/** Validate one import completely before the first Figma style, variable, or node write. */
export async function importPayload(
  params: Params,
): Promise<{ id: string; name: string; warnings: string[] }> {
  const { payload, placement } = validateImportPayload(params);
  resetImportWarnings();
  resetKeyedVariableCache();

  const tokens = payload.tokens;
  const colorStyles = await createColorStyles(tokens.colors);
  await createTextStyles(tokens.typography);
  await createEffectStyles(tokens.shadows);
  const tokenVars = await resolveTokenVars(tokens);

  const root = await createFigmaNode(payload.rootNode, colorStyles, tokenVars);
  if (!root) throw new Error('payload rootNode produced no Figma node');

  let replaceTarget: SceneNode | null = null;
  if (placement.replaceId) {
    const target = await figma.getNodeByIdAsync(placement.replaceId);
    if (target && target.type !== 'DOCUMENT' && target.type !== 'PAGE') replaceTarget = target as SceneNode;
  }
  let parent: BaseNode & ChildrenMixin = figma.currentPage;
  if (placement.parentId) {
    const target = await figma.getNodeByIdAsync(placement.parentId);
    if (target && 'appendChild' in target) parent = target as BaseNode & ChildrenMixin;
  }
  parent.appendChild(root);

  if (replaceTarget) {
    root.x = replaceTarget.x;
    root.y = replaceTarget.y;
    replaceTarget.remove();
  } else if (placement.x !== undefined && placement.y !== undefined) {
    root.x = placement.x;
    root.y = placement.y;
  } else {
    root.x = Math.round(figma.viewport.center.x - root.width / 2);
    root.y = Math.round(figma.viewport.center.y - root.height / 2);
  }

  try {
    figma.currentPage.selection = [root];
    figma.viewport.scrollAndZoomIntoView([root]);
  } catch { /* root not on current page */ }

  figma.notify(`Imported "${payload.name}" (${tokens.colors.length} colors, ${tokens.typography.length} text styles)`);
  return { id: root.id, name: root.name, warnings: getImportWarnings() };
}
