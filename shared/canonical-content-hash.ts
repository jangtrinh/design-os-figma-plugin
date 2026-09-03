// One canonicaliser and one FNV-1a, for every part of this codebase that fingerprints
// content.
//
// Two callers, two different jobs, the same requirement — "same content, same string":
//   - `shared/supervised-memory.ts` writes `correctionContentHash` into every stored
//     correction event and recomputes it to detect corruption. That hash is a DURABLE
//     identity: change the function and every event already on disk reads as corrupt.
//     `tests/supervised-memory.test.ts` pins two of its outputs as literals for exactly that
//     reason, and those literals are what let this module be extracted at all.
//   - `shared/context-dedup-literals.ts` keys `refs.literals` and the subtree signatures.
//     Nothing durable, but a second copy of a canonicaliser is a second set of edge cases
//     (key order, `undefined`, nested arrays) to keep in agreement with the first.
//
// The hash is NOT a security primitive and is not collision-proof; both callers guard that
// themselves — supervised-memory by comparing whole bodies, context-dedup by interning
// against the canonical content before it reuses a key.

/**
 * Key-sorted, recursive JSON: `{a,b}` and `{b,a}` produce one string, `undefined` properties
 * are dropped the way `JSON.stringify` drops them, and a top-level `undefined` is `'null'`.
 *
 * `localeCompare` is the sort, preserved verbatim from the supervised-memory original —
 * swapping it for `<`/`>` reorders non-ASCII keys and would silently invalidate every stored
 * correction hash.
 */
export function canonicalContent(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalContent).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalContent(child)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** FNV-1a 32-bit, as eight lower-case hex digits. `Math.imul` is already shipped in the
 *  plugin bundle (correction-edge-store rides this same function), so the sandbox question
 *  is settled by the build, not by assumption. */
export function fnv1aHex(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
