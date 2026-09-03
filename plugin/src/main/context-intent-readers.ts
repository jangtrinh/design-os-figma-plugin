// The four free design-intent READS, each one pure and each one honest when empty.
//
// What is readable on every plan, with no Dev Mode and no seat: `devStatus` ("Ready for
// dev"), `annotations`, dev-resource links, and a component's own `description` /
// `descriptionMarkdown` / `documentationLinks`. Their VALUES are file-dependent — the
// controller's live probe on the owner's Free file read `devStatus` as null and found 0 dev
// resources, while `annotations` read fine. So every reader here answers `null` or an empty
// shape instead of inventing a placeholder, and the caller then emits no `intent` key at all.
//
// The one cost this module refuses to pay per node: dev resources are read ONCE for the whole
// subtree and mapped by `nodeId`. One call per node would be one host round trip per node on
// top of `getCSSAsync`'s ~7-8ms.
//
// Split from `context-intent.ts`, which holds the wiring — the record-builder wrapper and the
// per-component-key memo — while this file holds the field shapes.
import { messageOf, type ContextNodeLike } from './context-node-record';
import { safe } from './scan-node-utils';

/** `nodeId` is deliberately NOT kept: it is the record's own id. `inheritedNodeId` IS kept —
 *  "this link came from the main component, not from this layer" is a fact the caller cannot
 *  recover any other way. */
export interface DevResourceEntry { name: string; url: string; inheritedNodeId?: string }

export interface SubtreeDevResources {
  byNode: Map<string, DevResourceEntry[]>;
  /** What the single call returned, in LINKS — the same unit as `attached`. One layer
   *  routinely takes several dev resources, so counting records against this would make
   *  `attached < found` on a reply where nothing at all is missing. */
  found: number;
  /** Links the call returned that name no readable node id. They can never be attached — there
   *  is no id to attach them to — so without their own counter they would sink into the
   *  `found`/`attached` gap and read as "belongs to a node outside this reply", which is not
   *  what happened. */
  unaddressed: number;
  /** Set when the read REFUSED — which must never look like "this file has none". Also set
   *  when the method is absent, so an absent `budget.devResources` block strictly means
   *  "the call succeeded and there were none". */
  error?: string;
}

export interface ComponentIntent {
  name: string;
  description?: string;
  /** Only when it says something `description` does not. */
  descriptionMarkdown?: string;
  /** The `uri` strings; `uri` is the only field a documentation link carries. */
  documentationLinks?: string[];
}

/** What the reader holds when the caller did NOT pass `--dev-resources`: no read happened, so
 *  there is nothing to report and the executor emits no `budget.devResources` block at all.
 *  A zeroed block would say "asked and found none", which would be a wrong fact. */
export const noDevResourcesRead = (): SubtreeDevResources => ({ byNode: new Map(), found: 0, unaddressed: 0 });

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The `uri`/`type` strings out of a list of one-field objects, skipping anything unreadable
 *  rather than emitting an empty string that reads like a real value. */
function readOnlyField(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const read = entry === null || typeof entry !== 'object'
      ? '' : str(safe(() => (entry as Record<string, unknown>)[field]));
    return read === '' ? [] : [read];
  });
}

/**
 * ONE `getDevResourcesAsync` for the whole walk, rather than one per node.
 *
 * `includeChildren` is always passed EXPLICITLY, never left to the default: a per-node default
 * silently turns this into N calls the moment the option is dropped. The caller sets it false
 * when only one record can carry an answer (`--depth 0`), which keeps a one-record request
 * from paying for a whole-page read while still reporting that node's own links.
 */
export async function readSubtreeDevResources(
  root: ContextNodeLike, scope: { includeChildren: boolean } = { includeChildren: true },
): Promise<SubtreeDevResources> {
  const byNode = new Map<string, DevResourceEntry[]>();
  const read = safe(() => root.getDevResourcesAsync) as
    ((opts: { includeChildren: boolean }) => Promise<unknown[]>) | undefined;
  if (typeof read !== 'function') {
    return { byNode, found: 0, unaddressed: 0, error: 'getDevResourcesAsync is not available on this node' };
  }
  let list: unknown[];
  try {
    list = await read.call(root, { includeChildren: scope.includeChildren });
  } catch (err) {
    return { byNode, found: 0, unaddressed: 0, error: messageOf(err) };
  }
  if (!Array.isArray(list)) {
    return { byNode, found: 0, unaddressed: 0, error: 'getDevResourcesAsync did not answer with a list' };
  }
  let unaddressed = 0;
  for (const raw of list) {
    if (raw === null || typeof raw !== 'object') { unaddressed += 1; continue; }
    const resource = raw as Record<string, unknown>;
    const nodeId = str(safe(() => resource.nodeId));
    if (nodeId === '') { unaddressed += 1; continue; }
    const inherited = str(safe(() => resource.inheritedNodeId));
    const entry: DevResourceEntry = {
      name: str(safe(() => resource.name)),
      url: str(safe(() => resource.url)),
      ...(inherited !== '' && { inheritedNodeId: inherited }),
    };
    const existing = byNode.get(nodeId);
    if (existing === undefined) byNode.set(nodeId, [entry]);
    else existing.push(entry);
  }
  return { byNode, found: list.length, unaddressed };
}

/** `{type, description?}` verbatim, or `null` when the designer set nothing — the Free-plan
 *  default and the honest answer. The getter itself is NOT guarded here: a refusal has to
 *  reach the caller as `intentError`, and swallowing it here would report an empty devStatus
 *  on a node that never answered. */
export function readDevStatus(node: ContextNodeLike): Record<string, unknown> | null {
  const raw = node.devStatus;
  if (raw === null || typeof raw !== 'object') return null;
  const status = raw as Record<string, unknown>;
  const type = str(safe(() => status.type));
  if (type === '') return null;
  const description = str(safe(() => status.description));
  return { type, ...(description !== '' && { description }) };
}

/** The field names `exec-stdlib-annotate.ts` already uses, minus its nulls: an `intent` block
 *  that only exists when it is non-empty must not then be full of empty fields. `properties`
 *  is flattened to the property TYPE strings, since `type` is the only field that command
 *  emits per property either. An annotation with nothing readable in it stays an empty object
 *  rather than being dropped — the NUMBER of annotations on a node is itself a fact. */
export function readAnnotations(node: ContextNodeLike): Record<string, unknown>[] | null {
  const raw = node.annotations;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  return raw.map((entry) => {
    if (entry === null || typeof entry !== 'object') return {};
    const annotation = entry as Record<string, unknown>;
    const label = str(safe(() => annotation.label));
    const labelMarkdown = str(safe(() => annotation.labelMarkdown));
    const categoryId = str(safe(() => annotation.categoryId));
    const types = readOnlyField(safe(() => annotation.properties), 'type');
    return {
      ...(label !== '' && { label }),
      ...(labelMarkdown !== '' && { labelMarkdown }),
      ...(types.length > 0 && { properties: types }),
      ...(categoryId !== '' && { categoryId }),
    };
  });
}

/** A component's own words. `descriptionMarkdown` is dropped when it repeats `description` —
 *  the same rule `exec-stdlib-annotate` follows for a label, and for the same reason: Figma
 *  populates both on read. */
export function readComponentIntent(component: ContextNodeLike): ComponentIntent {
  const description = str(safe(() => component.description));
  const markdown = str(safe(() => component.descriptionMarkdown));
  const uris = readOnlyField(safe(() => component.documentationLinks), 'uri');
  return {
    name: str(safe(() => component.name)),
    ...(description !== '' && { description }),
    ...(markdown !== '' && markdown !== description && { descriptionMarkdown: markdown }),
    ...(uris.length > 0 && { documentationLinks: uris }),
  };
}

/**
 * Dev-resource LINKS carried by records that actually SHIP — the same unit as `found`, so the
 * two are comparable, and the same population the reply contains.
 *
 * Counted here, over the finished list, rather than while each record is built: the walk builds
 * a whole breadth-first batch and only then drops its tail (and the rest of the queue) into
 * `omitted.budget`, so a built record may never reach `nodes[]`. Counting at build time
 * reported `attached === found` for a budget-cut page where every link's node was on the
 * frontier and no shipped record carried a `devResources` key — which hides the exact gap the
 * `found`/`attached` pair exists to expose.
 *
 * Called on the PRE-dedup list: `--dedup` moves a record's fields into `refs.templates` instead
 * of dropping them, so a folded record still ships and still counts.
 */
export function countAttachedDevResources(records: readonly Record<string, unknown>[]): number {
  let attached = 0;
  for (const record of records) {
    const intent = record.intent;
    if (intent === null || typeof intent !== 'object') continue;
    const links = (intent as Record<string, unknown>).devResources;
    if (Array.isArray(links)) attached += links.length;
  }
  return attached;
}

/** Whether a component row has anything to SAY. A row with only a name is exactly what P1
 *  already ships, so it must not gain a `description` key. */
export const hasComponentIntent = (intent: ComponentIntent): boolean => (
  intent.description !== undefined || intent.descriptionMarkdown !== undefined
  || intent.documentationLinks !== undefined
);
