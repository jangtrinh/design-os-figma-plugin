// The exact inverse of `context --dedup`, CLI-side and pure.
//
// **Not a flag.** There is no `figma-agent context --inflate`: printing the raw form the
// caller explicitly asked to compress would make `--dedup` a no-op with extra steps. This
// function exists for two readers — the invariant suite that GATES the dedup transform
// (`inflate(dedup(x))` must deep-equal `x` over a hostile corpus, in `npm test`), and an
// agent that imports the CLI as a module and would rather hold one flat list than resolve
// refs itself. The catalog row says exactly that.
//
// What it removes: `refs.literals`, `refs.templates` and the `dedup` block. All three
// describe a TRANSPORT form; once expanded they would be claims about a payload that no
// longer exists.
//
// It is the inverse by DEEP EQUALITY, not byte-for-byte: a restored record's keys come back
// in the order the transform left them in, and a `css` block re-read from `refs.literals`
// sits wherever the spread puts it. `JSON.stringify` output can therefore differ while every
// value is identical — which is the property the round-trip invariant asserts.
//
// What it never does: heal. A `cssRef` with no entry in `refs.literals`, or an occurrence
// whose template is missing, is left exactly as it arrived. Replacing a missing literal with
// `{}` would report "this node has no CSS" — a wrong fact — and quietly turn a broken reply
// into a plausible one.
import { expandContextLiterals } from '../../../shared/context-dedup-literals.ts';
import type { ContextTemplate, TemplateNodeIdentity } from '../../../shared/context-dedup-templates.ts';

type Record_ = Record<string, unknown>;

interface Occurrence {
  template: ContextTemplate;
  /** relative id → the real identity and raw list position. `"0"` is the occurrence itself. */
  identities: Map<string, TemplateNodeIdentity>;
  parentId: string | null;
  depth: number;
}

const isRecord = (value: unknown): value is Record_ => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

/**
 * Everything an occurrence needs, or `null`.
 *
 * Validated as a whole before anything is rebuilt: a half-expanded occurrence would leave the
 * list length wrong and every following node one slot out of place. `null` means "leave this
 * record alone", which keeps a malformed reply visible instead of half-repaired.
 */
function readOccurrence(record: Record_, templates: Record<string, ContextTemplate>): Occurrence | null {
  const ref = record.templateRef;
  if (typeof ref !== 'string') return null;
  const template = templates[ref];
  if (template === undefined || !Array.isArray(template.nodes)) return null;
  const rootMap = record.rootMap;
  if (!isRecord(rootMap)) return null;
  if (typeof record.id !== 'string' || typeof record.name !== 'string') return null;
  if (typeof record.depth !== 'number') return null;
  const parentId = record.parentId;
  if (parentId !== null && typeof parentId !== 'string') return null;

  const identities = new Map<string, TemplateNodeIdentity>();
  identities.set('0', { id: record.id, name: record.name, at: -1 });
  for (const [rel, value] of Object.entries(rootMap)) {
    if (!isRecord(value)) return null;
    const { id, name, at } = value;
    if (typeof id !== 'string' || typeof name !== 'string' || typeof at !== 'number') return null;
    identities.set(rel, { id, name, at });
  }
  // Every node the template describes must have an identity, and nothing may claim a slot
  // the template does not describe.
  if (identities.size !== template.nodes.length) return null;
  for (const node of template.nodes) {
    if (!isRecord(node) || typeof node.id !== 'string' || !identities.has(node.id)) return null;
    if (typeof node.depth !== 'number') return null;
  }
  return { template, identities, parentId, depth: record.depth };
}

function expandOccurrence(occurrence: Occurrence): { root: Record_; placed: [number, Record_][] } {
  const { template, identities, parentId, depth } = occurrence;
  let root: Record_ = {};
  const placed: [number, Record_][] = [];
  for (const node of template.nodes) {
    const rel = node.id as string;
    const identity = identities.get(rel) as TemplateNodeIdentity;
    const templateParent = node.parentId;
    const restored: Record_ = {
      // A DEEP copy: one template feeds every occurrence, so a shallow spread would hand N
      // records the same `bindings` / `componentProperties` / `css` objects and an edit to
      // one would reach all of them. Every value here arrived as JSON off the wire, so a
      // JSON round-trip is the honest clone.
      ...(JSON.parse(JSON.stringify(node)) as Record_),
      id: identity.id,
      name: identity.name,
      // The template's own `parentId` is relative; the ROOT's real parent is the
      // occurrence's, which is the one link a template cannot carry.
      parentId: typeof templateParent === 'string'
        ? (identities.get(templateParent)?.id ?? null)
        : parentId,
      // Relative depth plus the occurrence's absolute depth: the same template is reused at
      // whatever depth it is found, so the absolute number can only come from here.
      depth: depth + (node.depth as number),
    };
    if (rel === '0') root = restored;
    else placed.push([identity.at, restored]);
  }
  return { root, placed };
}

/** Deduped list + templates → the raw breadth-first list, each record back in its own slot. */
export function expandContextTemplates(
  nodes: readonly Record_[], templates: Record<string, ContextTemplate>,
): Record_[] {
  const plan = nodes.map((record) => readOccurrence(record, templates));
  const extra = plan.reduce((sum, o) => sum + (o === null ? 0 : o.template.nodes.length - 1), 0);
  if (extra === 0) return nodes.map((record) => ({ ...record }));

  const total = nodes.length + extra;
  const out: (Record_ | undefined)[] = new Array(total).fill(undefined);
  const stream: Record_[] = [];
  for (let i = 0; i < nodes.length; i += 1) {
    const occurrence = plan[i];
    if (occurrence === null) { stream.push({ ...nodes[i] }); continue; }
    const { root, placed } = expandOccurrence(occurrence);
    stream.push(root);
    for (const [at, record] of placed) {
      // A position outside the list, or one already taken, means the reply's own numbers do
      // not add up. Appending to the stream keeps every record rather than dropping one.
      if (at >= 0 && at < total && out[at] === undefined) out[at] = record;
      else stream.push(record);
    }
  }
  let next = 0;
  for (let i = 0; i < total; i += 1) {
    if (out[i] === undefined) { out[i] = stream[next]; next += 1; }
  }
  return out.filter((record): record is Record_ => record !== undefined);
}

/**
 * A deduped `context` reply → the reply the walk produced. Pure: the argument is not touched,
 * and no expanded record shares a nested object with another or with the ref tables. A reply
 * that was never deduped comes back deep-equal to itself.
 */
export function inflateContextReply(reply: Record_): Record_ {
  const out: Record_ = { ...reply };
  delete out.dedup;
  const refs = isRecord(reply.refs) ? reply.refs : {};
  const literals = isRecord(refs.literals) ? (refs.literals as Record<string, Record_>) : {};
  const templates = isRecord(refs.templates) ? (refs.templates as Record<string, ContextTemplate>) : {};
  const refsOut: Record_ = { ...refs };
  delete refsOut.literals;
  delete refsOut.templates;
  if (isRecord(reply.refs)) out.refs = refsOut;

  const nodes = Array.isArray(reply.nodes) ? (reply.nodes as Record_[]) : undefined;
  if (nodes !== undefined) {
    // Templates first: a template's nodes carry `cssRef`/`layoutRef` of their own, so the
    // literal pass has to run over the expanded list, not before it.
    out.nodes = expandContextLiterals(expandContextTemplates(nodes, templates), literals);
  }
  return out;
}
