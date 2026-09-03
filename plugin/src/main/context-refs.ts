// The reply's identity tables — the honest dedup, on by default.
//
// A subtree of 40 rows bound to one spacing token repeats that token's ID 40 times and its
// NAME zero times. Naming it once here is a real reduction with no risk: the key is the
// variable/style IDENTITY, so two differently-named tokens that happen to hold the same
// colour can never be folded into one. (Content hashing, which can, is a separate opt-in
// step and not part of this command.)
//
// What this module refuses to do: emit a variable's VALUE. `valuesByMode[modes[0]]` on a
// multi-mode collection is one mode's value wearing the collection's name — an agent that
// codes it as "the" value ships the light-mode colour into a dark-mode component. The
// honest fact is `modeCount`; a value is a question the caller asks with a mode named.
import { safe } from './scan-node-utils';

export interface ContextRefIds {
  variables: string[];
  styles: string[];
  components: { key: string; name: string }[];
}

export type VariableRef =
  | { name: string; collection: string | null; modeCount: number | null }
  | { unresolved: string };
export type StyleRef = { name: string; type: string } | { unresolved: string };

export interface ContextRefs {
  variables: Record<string, VariableRef>;
  styles: Record<string, StyleRef>;
  components: Record<string, { name: string }>;
}

export interface ContextRefsDeps {
  variableById: (id: string) => Promise<{ name?: unknown; variableCollectionId?: unknown } | null>;
  collectionById: (id: string) => Promise<{ name?: unknown; modes?: unknown } | null>;
  styleById: (id: string) => Promise<{ name?: unknown; type?: unknown } | null>;
}

/** Distinct ids in first-seen order — the reply's tables are then stable across two calls
 *  on the same subtree, which makes them diffable. */
export function collectRefIds(records: readonly Record<string, unknown>[]): ContextRefIds {
  const variables: string[] = [];
  const styles: string[] = [];
  const components: { key: string; name: string }[] = [];
  const seenComponent = new Set<string>();
  for (const record of records) {
    for (const [field, into] of [['bindings', variables], ['styles', styles]] as const) {
      const table = record[field];
      if (!table || typeof table !== 'object') continue;
      for (const id of Object.values(table as Record<string, unknown>)) {
        if (typeof id === 'string' && id !== '' && !into.includes(id)) into.push(id);
      }
    }
    const main = record.mainComponent as { key?: unknown; name?: unknown } | undefined;
    if (main && typeof main.key === 'string' && main.key !== '' && !seenComponent.has(main.key)) {
      seenComponent.add(main.key);
      components.push({ key: main.key, name: typeof main.name === 'string' ? main.name : '' });
    }
  }
  return { variables, styles, components };
}

const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);

/**
 * One async lookup per DISTINCT id, and one per distinct collection — never per node. The
 * regression this shape exists to prevent is `getVariableByIdAsync` inside the walk, which
 * turns a 40-row list into 40 host round-trips for one token (and the alternative,
 * `getLocalVariablesAsync` on a real design-system file, reads the whole registry to answer
 * two ids).
 */
export async function resolveContextRefs(
  records: readonly Record<string, unknown>[], deps: ContextRefsDeps,
): Promise<ContextRefs> {
  const ids = collectRefIds(records);
  const refs: ContextRefs = { variables: {}, styles: {}, components: {} };
  const collections = new Map<string, { name: string; modeCount: number | null } | null>();

  for (const id of ids.variables) {
    try {
      const variable = await deps.variableById(id);
      if (!variable) {
        refs.variables[id] = { unresolved: 'no variable answers to this id' };
        continue;
      }
      const collectionId = str(safe(() => variable.variableCollectionId));
      if (collectionId !== '' && !collections.has(collectionId)) {
        try {
          const collection = await deps.collectionById(collectionId);
          const modes = collection ? safe(() => collection.modes) : undefined;
          // `null`, never 0: no collection has zero modes, and a fabricated 0 invites the
          // exact multi-mode misread the identity table exists to prevent (an agent
          // reading a low mode count reasons "safe to inline a value").
          collections.set(collectionId, collection
            ? { name: str(safe(() => collection.name)), modeCount: Array.isArray(modes) ? modes.length : null }
            : null);
        } catch {
          collections.set(collectionId, null);
        }
      }
      const resolved = collections.get(collectionId) ?? null;
      refs.variables[id] = {
        name: str(safe(() => variable.name)),
        collection: resolved ? resolved.name : null,
        modeCount: resolved ? resolved.modeCount : null,
      };
    } catch (err) {
      refs.variables[id] = { unresolved: err instanceof Error ? err.message : String(err) };
    }
  }

  for (const id of ids.styles) {
    try {
      const style = await deps.styleById(id);
      if (!style) {
        refs.styles[id] = { unresolved: 'no style answers to this id' };
        continue;
      }
      refs.styles[id] = { name: str(safe(() => style.name)), type: str(safe(() => style.type), 'UNKNOWN') };
    } catch (err) {
      refs.styles[id] = { unresolved: err instanceof Error ? err.message : String(err) };
    }
  }

  // Component names come off the main component the walk already resolved — no second
  // lookup, and no `importComponentByKeyAsync` (which would reach outside the subtree).
  for (const { key, name } of ids.components) refs.components[key] = { name };

  return refs;
}
