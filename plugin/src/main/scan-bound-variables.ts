// Where a variable binding can live on a node, read in one place so the component walk and
// any future reader look with the same eyes. Every read goes through `safe()`: a mixed value
// (figma.mixed) or a getter that throws is "nothing bound here", never an aborted scan.
//
// Sensed (version 1): every field of `node.boundVariables` in every shape the typings give
// (single alias, alias arrays, nested `componentProperties`, text ranges), paints of fills
// and strokes item by item INCLUDING gradient stops, effects, layout grids, and the default
// values of component property definitions.
// NOT sensed (version 1): a variable reached only through a style applied to the node, and an
// override on a node inside a nested instance (the walk stops at the instance boundary).
import { safe } from './scan-node-utils';

interface AliasLike { type?: unknown; id?: unknown }

/** Every `VARIABLE_ALIAS` id found anywhere inside a boundVariables-shaped value. */
export function collectAliasIds(value: unknown, into: Set<string>, depth = 0): void {
  if (!value || typeof value !== 'object' || depth > 4) return;
  if (Array.isArray(value)) {
    for (const v of value) collectAliasIds(v, into, depth + 1);
    return;
  }
  const alias = value as AliasLike;
  if (alias.type === 'VARIABLE_ALIAS' && typeof alias.id === 'string' && alias.id) {
    into.add(alias.id);
    return;
  }
  for (const v of Object.values(value)) collectAliasIds(v, into, depth + 1);
}

function collectItemBindings(item: unknown, into: Set<string>): void {
  collectAliasIds(safe(() => (item as { boundVariables?: unknown }).boundVariables), into);
  // A gradient paint binds colour per stop, on the stop, not on the paint.
  const stops = safe(() => (item as { gradientStops?: unknown }).gradientStops);
  if (Array.isArray(stops)) for (const stop of stops) collectAliasIds(safe(() => (stop as { boundVariables?: unknown }).boundVariables), into);
}

/** Variable ids bound on ONE node: its own fields, the paints/effects/grids it carries, and
 *  (components only) the default values of its property definitions. */
export function collectOwnBindings(n: Record<string, unknown>, into: Set<string>): void {
  collectAliasIds(safe(() => n.boundVariables), into);
  for (const field of ['fills', 'strokes', 'effects', 'layoutGrids'] as const) {
    const list = safe(() => n[field]);
    if (Array.isArray(list)) for (const item of list) collectItemBindings(item, into);
  }
  if (n.type === 'COMPONENT' || n.type === 'COMPONENT_SET') {
    // Throws on a variant child of a set: those defaults live on the set itself.
    const defs = safe(() => n.componentPropertyDefinitions) as Record<string, { boundVariables?: unknown }> | undefined;
    if (defs && typeof defs === 'object') {
      for (const def of Object.values(defs)) collectAliasIds(safe(() => def.boundVariables), into);
    }
  }
}
