// Pure helpers behind `ui.componentSet(...)` (exec-stdlib-component-set.ts) — split out
// so that file stays under the repo's 200-line cap (the same split-by-shape convention
// as exec-stdlib-instance.ts). No `figma` global here, so these are unit-testable without
// a live plugin or a mock — the cartesian-order determinism and the `=`/`,` rejection
// are asserted directly against these functions.
import { withCode } from './executor-styles';

export const MAX_VARIANTS = 100;
export const WARN_ABOVE = 40;

/** Figma parses variant names on `=`/`,` — a value carrying either would silently
 * split into a bogus extra axis. Reject before creating anything (adapted from the
 * fork's own constraint, write-tools.ts:2843-2846 — see THIRD-PARTY.md). */
export function assertCleanToken(kind: 'axis' | 'value' | 'property', s: string): void {
  if (s.includes('=') || s.includes(',')) {
    throw withCode(new Error(`${kind} "${s}" must not contain "=" or "," — Figma parses variant names on those characters`), 'E_INVALID_ARGS');
  }
}

export function comboName(combo: Record<string, string>, axisOrder: readonly string[]): string {
  return axisOrder.map((a) => `${a}=${combo[a]}`).join(', ');
}

/** Deterministic cartesian product — axis insertion order, values in given order
 * (Article I: a nondeterministic variant order makes the matrix untestable). */
export function cartesianProduct(axes: Record<string, readonly string[]>): Record<string, string>[] {
  const axisOrder = Object.keys(axes);
  let combos: Record<string, string>[] = [{}];
  for (const axis of axisOrder) {
    const next: Record<string, string>[] = [];
    for (const c of combos) for (const v of axes[axis]!) next.push({ ...c, [axis]: v });
    combos = next;
  }
  return combos;
}

/** Parse a built variant's "Prop=Value, ..." name back into an axis map, for the
 * post-combine verification (§5.2 rule 7: every child name must parse back to the
 * intended map). */
export function parseComboName(name: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of name.split(', ')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

export function sameAxisMap(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a).sort();
  const bk = Object.keys(b).sort();
  if (ak.length !== bk.length || ak.some((k, i) => k !== bk[i])) return false;
  return ak.every((k) => a[k] === b[k]);
}
