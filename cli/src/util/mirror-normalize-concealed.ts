// The mirror's treatment of the scan's concealed-text annotation
// (plugin/src/main/text-concealment.ts).
//
// `concealed` is not a field of the node: it says whether a human can SEE the text where
// it sits — through its ancestors' visibility, opacity and clipping, which reach above
// the scanned root. A rebuild lands somewhere else (and the payload has no slot for
// `visible`), so the original and the rebuild can disagree on it with nothing lost. Left
// in, it would turn every concealed text into a permanent mirror diff.
//
// So it is dropped from BOTH sides before the diff, symmetrically, and every path that
// carried it on either side is reported in the gate's `normalized` list — the same
// "said out loud" rule as mirror-normalize.ts. Nothing it covers is forgiven: the
// node's own `characters`, fills and size are still compared.

type Spec = Record<string, unknown>;

const asSpec = (v: unknown): Spec | undefined =>
  (typeof v === 'object' && v !== null && !Array.isArray(v)) ? (v as Spec) : undefined;

const joinPath = (path: string, key: string): string => (path ? `${path}.${key}` : key);

/** Remove `concealed` from every node of the spec. Pure: the input is copied. */
export function stripConcealment<T>(spec: T): T {
  const node = asSpec(spec);
  if (!node) return spec;
  const { concealed: _concealed, ...out } = node;
  if (Array.isArray(out.children)) out.children = out.children.map((child) => stripConcealment(child));
  return out as T;
}

function concealedPaths(spec: unknown, path: string, into: Set<string>): void {
  const node = asSpec(spec);
  if (!node) return;
  if (node.concealed !== undefined) into.add(joinPath(path, 'concealed'));
  if (Array.isArray(node.children)) {
    node.children.forEach((child, i) => concealedPaths(child, `${joinPath(path, 'children')}[${i}]`, into));
  }
}

/** One `normalized` line per path where EITHER scan carried the annotation. */
export function concealmentNotes(specA: unknown, specB: unknown): string[] {
  const paths = new Set<string>();
  concealedPaths(specA, '', paths);
  concealedPaths(specB, '', paths);
  return [...paths].sort().map((p) => `${p} (read-only annotation, not compared)`);
}
