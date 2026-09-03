// Reconnect gap-fill — the PURE core: the record codec, the diff, the top-level
// (coarse) signal, the notice frames and the per-page write decision. No figma access of
// any kind, so every rule here is driven directly from tests/edit-gapfill.test.ts.
//
// Split out of edit-gapfill.ts, which keeps the figma-dependent halves (the page walk, the
// clientStorage read/write, the boot diff's control flow). The dependency runs one way:
// this module imports only the wire format plus TYPES from the walker and the baseline
// store, and neither of those imports gap-fill — so there is no cycle to route around.
import type { EditInput, EditOp } from '../../../shared/edit-feed';
import type { BaselinePage, BaselineRecord } from './gapfill-baseline-store';
import type { NodeSnapshot, TopLevelRecord } from './page-walk-bounded';

export function toBaselineRecord(rec: NodeSnapshot): BaselineRecord {
  return [rec.id, rec.name, rec.type, rec.x, rec.y, rec.parent];
}

export function fromBaselineRecord(rec: BaselineRecord): NodeSnapshot {
  return { id: rec[0], name: rec[1], type: rec[2], x: rec[3], y: rec[4], parent: rec[5] };
}

/** Boot-path seam: `runGapfillDiff` has ALREADY walked every page once for its diff, so
 *  the baseline write must reuse those results instead of walking the whole document a
 *  second time (the double walk was measured as the boot freeze on large files). Reusing
 *  the PRE-diff snapshot is also the correct baseline: an edit made while the diff is
 *  yielding must NOT be baked into the baseline it was absent from, or the next session's
 *  gap-fill would never report it. Pure — unit-tested directly. */
export function snapshotProviderFrom<P extends { id: string }, R>(
  precomputed: ReadonlyMap<string, R>,
  fallback: (page: P) => R,
): (page: P) => R {
  return (page) => precomputed.get(page.id) ?? fallback(page);
}

const MOVE_EPSILON = 0.5;

export interface RecordPair { prev: NodeSnapshot; next: NodeSnapshot }

/** Diff two snapshots of the SAME page: id present→absent = deleted, absent→present =
 *  created, same id different `name` = renamed, same id different `x`|`y` (> 0.5px) =
 *  moved. A node that changed BOTH appears in `renamed` AND `moved` — each is its own
 *  real, independent fact; neither list drops it for the other (the caller, which knows
 *  the wire format, is what merges them into one `updated` EditInput — see
 *  `runGapfillDiff`). Pure — no figma access, fully unit-tested. */
export interface GapfillDiff {
  created: NodeSnapshot[];
  deleted: NodeSnapshot[];
  renamed: RecordPair[];
  moved: RecordPair[];
}

export function diffSnapshots(prev: readonly NodeSnapshot[], next: readonly NodeSnapshot[]): GapfillDiff {
  const prevById = new Map(prev.map((n) => [n.id, n]));
  const nextIds = new Set(next.map((n) => n.id));
  const created: NodeSnapshot[] = [];
  const deleted: NodeSnapshot[] = [];
  const renamed: RecordPair[] = [];
  const moved: RecordPair[] = [];

  for (const n of next) {
    const p = prevById.get(n.id);
    if (!p) { created.push(n); continue; }
    if (p.name !== n.name) renamed.push({ prev: p, next: n });
    if (Math.abs(p.x - n.x) > MOVE_EPSILON || Math.abs(p.y - n.y) > MOVE_EPSILON) moved.push({ prev: p, next: n });
  }
  for (const p of prev) {
    if (!nextIds.has(p.id)) deleted.push(p);
  }
  return { created, deleted, renamed, moved };
}

/** A frame-level fact the top-level fingerprint produces, carrying exactly the props it
 *  is about: `['subtree']` for a child-count change, `['width']`/`['height']` for a
 *  resize. */
export interface CoarseChange { rec: NodeSnapshot; props: readonly string[] }

/** Props whose sentence would be LOST if they rode a frame that also carries a rename or
 *  a move: `updateVerb` ranks name > position > residual, so a frame rendered as
 *  "Renamed …" never states its subtree fact — and on a truncated page that fact is the
 *  only thing said about the nodes inside. Such a prop therefore gets its OWN frame.
 *  Size props are deliberately NOT here: a resize is a fact about the same frame the
 *  rename is about, so reporting the clearest one — with `width`/`height` still listed in
 *  changedProps — is the vocabulary's normal contract rather than a lost fact. */
const OWN_FRAME_PROPS: ReadonlySet<string> = new Set(['subtree']);

/**
 * Merges `renamed`+`moved` pairs for the SAME node into one `updated` EditInput with the
 * union of changedProps — the wire format's own "one frame per node per batch" contract
 * (mirrors `coalesceEdits`), so a node that changed both is reported ONCE, not twice.
 *
 * The one deliberate exception is `OWN_FRAME_PROPS`: a fact the verb ranking would swallow
 * is emitted as a SECOND frame for that node instead of being folded in silently. Gap-fill
 * posts its batch directly rather than through `coalesceEdits`, so both frames reach the
 * feed and each renders the sentence its own props describe. A node carrying ONLY such a
 * fact keeps its single frame, exactly as before.
 * Pure — the seam `runGapfillDiff` (figma-dependent) delegates to.
 */
export function mergeUpdatedRecords(
  renamed: readonly RecordPair[],
  moved: readonly RecordPair[],
  // The top-level signal's own categories: this frame's CONTENTS changed, or the frame
  // itself was resized, while the plugin was closed.
  coarse: readonly CoarseChange[] = [],
): Array<{ rec: NodeSnapshot; changedProps: string[] }> {
  const byId = new Map<string, { rec: NodeSnapshot; props: Set<string> }>();
  const entryFor = (rec: NodeSnapshot): { rec: NodeSnapshot; props: Set<string> } => {
    const entry = byId.get(rec.id) ?? { rec, props: new Set<string>() };
    byId.set(rec.id, entry);
    return entry;
  };
  for (const { next } of renamed) entryFor(next).props.add('name');
  for (const { next } of moved) {
    const entry = entryFor(next);
    entry.props.add('x');
    entry.props.add('y');
  }
  for (const { rec, props } of coarse) for (const prop of props) entryFor(rec).props.add(prop);

  const out: Array<{ rec: NodeSnapshot; changedProps: string[] }> = [];
  for (const { rec, props } of byId.values()) {
    const ownFrame = [...props].filter((p) => OWN_FRAME_PROPS.has(p)).sort();
    const rest = [...props].filter((p) => !OWN_FRAME_PROPS.has(p)).sort();
    if (rest.length > 0) out.push({ rec, changedProps: rest });
    // Alone, the fact IS the frame; alongside others, it gets one of its own.
    if (ownFrame.length > 0) out.push({ rec, changedProps: ownFrame });
  }
  return out;
}

/**
 * Filters the `deleted` candidates of a diff down to the ones that are REALLY gone.
 *
 * The page walk spans macrotask yields, so the scene can change under it: a node
 * reparented out of a not-yet-walked region into an already-walked one is absent from
 * this session's records with nothing thrown and nothing counted, and reads as deleted.
 * Every candidate is therefore looked up before it is reported — deleted candidates only,
 * which are normally a handful, so the cost is one lookup per genuine change rather than
 * per node.
 *
 * A survivor is dropped from the diff rather than re-classified: this session cannot say
 * where it went, and its new page's records will show it next session. Counted, so the
 * suppression is never silent. Pure — the lookup is injected.
 */
export async function withoutSurvivingNodes(
  deleted: readonly NodeSnapshot[],
  nodeExists: (id: string) => Promise<boolean>,
): Promise<{ deleted: NodeSnapshot[]; survived: number }> {
  const kept: NodeSnapshot[] = [];
  let survived = 0;
  for (const rec of deleted) {
    if (await nodeExists(rec.id)) survived += 1;
    else kept.push(rec);
  }
  return { deleted: kept, survived };
}

/** Which page ids the PREVIOUS baseline knew about that no longer appear among the
 *  currently-loaded pages at all (the whole page was deleted while the plugin was
 *  closed). Pure — figma-dependent callers pass in plain ids. */
export function deletedPageIds(prevPageIds: readonly string[], currentPageIds: ReadonlySet<string>): string[] {
  return prevPageIds.filter((id) => !currentPageIds.has(id));
}

/** Either side of a page's own snapshot being truncated makes created/deleted facts
 *  unreliable (a node pushed past the cap by unrelated tree growth reads as a false
 *  deletion; one that only now fits reads as a false creation). Pure. */
export function pageWasTruncated(prevTruncated: boolean | undefined, nextTruncated: boolean): boolean {
  return prevTruncated === true || nextTruncated;
}

/** A deleted page is named with its node count only when the baseline actually stored the
 *  records to count. A truncated page stored none, and inventing "(0 node(s))" for it
 *  would be a wrong fact where an absent one costs nothing. */
export function deletedPageLabel(page: BaselinePage): string {
  return page.records ? `${page.name} (${page.records.length} node(s))` : page.name;
}

export function toGapfillEdit(op: EditOp, rec: NodeSnapshot, page: string, changedProps: string[] = []): EditInput {
  return {
    op, nodeId: rec.id, nodeName: rec.name, nodeType: rec.type,
    // Gap-fill is existence/name/position only (spec non-goal: no property-level diff for
    // the offline window) — the baseline itself never tracked a parent NAME (only a
    // parent id, for a future use), so this is null rather than invented.
    parentName: null,
    page, changedProps, origin: 'LOCAL',
    // The agent cannot have acted while its bridge was down — every gap-fill frame is
    // unambiguously the owner's.
    actor: 'owner',
  };
}

/** Builds the EDIT_FEED-ready edits for one page's diff, applying `mergeUpdatedRecords`'s
 *  one-frame-per-node contract. Pure. */
export function gapfillEditsForPage(
  diff: GapfillDiff,
  pageName: string,
  coarse: readonly CoarseChange[] = [],
): EditInput[] {
  const edits: EditInput[] = [];
  for (const rec of diff.created) edits.push(toGapfillEdit('created', rec, pageName));
  for (const rec of diff.deleted) edits.push(toGapfillEdit('deleted', rec, pageName));
  for (const { rec, changedProps } of mergeUpdatedRecords(diff.renamed, diff.moved, coarse)) {
    edits.push(toGapfillEdit('updated', rec, pageName, changedProps));
  }
  return edits;
}

// ── The top-level (coarse) signal for a page over the node cap ──────────────────────

/** A fingerprint entry as the diff sees it: the same identity/name/position fields a full
 *  record carries, so the EXISTING `diffSnapshots` produces created/deleted/renamed/moved
 *  for top-level frames with no second implementation. `parent` is null rather than the
 *  page id — the fingerprint never stored one, and gap-fill does not invent. */
function topLevelSnapshot(rec: TopLevelRecord): NodeSnapshot {
  return { id: rec[0], name: rec[1], type: rec[2], x: rec[3], y: rec[4], parent: null };
}

export interface TopLevelDiff {
  /** created / deleted / renamed / moved, in the same shape a full page diff produces. */
  diff: GapfillDiff;
  /** The frame-level facts the fingerprint can state exactly: `subtree` when the CHILD
   *  COUNT changed (the coarse stand-in for "something happened inside this frame" on a
   *  page too large to walk exactly — it names the frame and claims nothing about which
   *  node changed), or the size props that actually changed. */
  coarse: CoarseChange[];
}

/**
 * The closed-window signal for a page over the node cap. Before this, such a page emitted
 * a truncation notice and NOTHING else — on the owner's file that is 16 of 21 pages blind
 * to every edit made while the plugin was closed. Comparing the two top-level fingerprints
 * is O(top-level) and reports real facts about real frames; it simply cannot see WHICH
 * node inside a frame changed, and never pretends to. Pure.
 *
 * A child-count change is the only evidence of an edit INSIDE the frame, so it reports
 * `subtree` and stops there: a frame that also resized almost always did so BECAUSE its
 * contents changed, and naming the effect separately would state one edit as two facts. A
 * size change with the child count unchanged is a RESIZE and says exactly that — calling
 * it "contents changed" was a claim about nodes this session never looked at.
 */
export function diffTopLevel(prev: readonly TopLevelRecord[], next: readonly TopLevelRecord[]): TopLevelDiff {
  const diff = diffSnapshots(prev.map(topLevelSnapshot), next.map(topLevelSnapshot));
  const prevById = new Map(prev.map((rec) => [rec[0], rec]));
  const coarse: CoarseChange[] = [];
  for (const rec of next) {
    const before = prevById.get(rec[0]);
    if (!before) continue; // a NEW frame is already reported as created — not "changed"
    if (before[7] !== rec[7]) { coarse.push({ rec: topLevelSnapshot(rec), props: ['subtree'] }); continue; }
    const resized: string[] = [];
    if (before[5] !== rec[5]) resized.push('width');
    if (before[6] !== rec[6]) resized.push('height');
    if (resized.length > 0) coarse.push({ rec: topLevelSnapshot(rec), props: resized });
  }
  return { diff, coarse };
}

// ── Notice frames: the facts gap-fill states when it cannot state an edit ────────────

/** The one frame a session emits when it had NO baseline to diff against — first run on
 *  this file, a cleared cache, or a renamed Free-tier file whose slug-keyed baseline was
 *  orphaned. Reported instead of a silent empty diff, and instead of diffing against an
 *  empty baseline, which would fabricate a "created" frame for every node in the file. */
export function baselineMissingNotice(fileName: string, pageName: string): EditInput {
  return toGapfillEdit(
    'updated',
    { id: 'gapfill:baseline-missing', name: fileName, type: 'DOCUMENT', x: 0, y: 0, parent: null },
    pageName,
    ['baseline-missing'],
  );
}

/** The one frame a session emits when a baseline EXISTS but the store refused to read it.
 *  Not `baseline-missing`: that would state a wrong fact (there is one on disk). The write
 *  is withheld too, so the stored value survives and the next successful boot diffs against
 *  it — delayed, never lost. No page is walked on this path: a read failure must not cost a
 *  full document walk whose result could not be persisted anyway. */
export function baselineUnreadableNotice(fileName: string, pageName: string): EditInput {
  return toGapfillEdit(
    'updated',
    { id: 'gapfill:baseline-unreadable', name: fileName, type: 'DOCUMENT', x: 0, y: 0, parent: null },
    pageName,
    ['baseline-unreadable'],
  );
}

/** A whole page the previous session knew about is gone. ONE notice naming the page —
 *  never N synthetic per-node deletions: we know the page is gone, not whether each node
 *  was individually deleted. */
export function pageDeletedNotice(prevPage: BaselinePage): EditInput {
  return toGapfillEdit(
    'deleted',
    { id: `page-deleted:${prevPage.id}`, name: deletedPageLabel(prevPage), type: 'PAGE', x: 0, y: 0, parent: null },
    prevPage.name,
    ['page-deleted'],
  );
}

/**
 * A page whose walk could not read every node. Those nodes are ABSENT from this session's
 * records, and a diff run against them would report each one — plus its whole unvisited
 * subtree — as `deleted`: a wrong fact about nodes the designer can still see. So the
 * page's diff is skipped entirely and this notice takes its place, while the previous
 * baseline entry carries forward (`resolveBaselinePage`).
 *
 * The frame carries no count: the wire format has no numeric field, and encoding one into
 * a `changedProps` marker would put a value to be parsed where every other consumer reads
 * a plain flag. The count is on the record where numbers belong — STATUS's
 * `gapfill.pagesWithReadErrors` and `perf.propertyReadErrors`, plus the session's first
 * error message, which names the page and how many nodes it lost.
 */
export function walkErrorsNotice(page: { id: string; name: string }): EditInput {
  return toGapfillEdit(
    'updated',
    { id: `walk-errors:${page.id}`, name: page.name, type: 'PAGE', x: 0, y: 0, parent: null },
    page.name,
    ['walk-errors'],
  );
}

/** The page IS over the node cap and its per-node facts stay suppressed — still true, and
 *  still said out loud rather than left to a silence. */
export function truncatedNotice(page: { id: string; name: string }): EditInput {
  return toGapfillEdit(
    'updated',
    { id: `truncated:${page.id}`, name: page.name, type: 'PAGE', x: 0, y: 0, parent: null },
    page.name,
    ['truncated'],
  );
}

/**
 * The other reason a per-node diff is suppressed: the page was over the cap in the PREVIOUS
 * session — so that baseline stored a top-level fingerprint and no records — and is under
 * it now. Nothing this session can do recovers the per-node facts of that window.
 *
 * A distinct notice rather than `truncatedNotice`, because the sentence that one renders
 * states the page exceeds the scan cap, and this page does not. The suppression is the
 * same; the reason is not, and stating the wrong reason is exactly the kind of wrong fact
 * an absent one would beat.
 */
export function previouslyTruncatedNotice(page: { id: string; name: string }): EditInput {
  return toGapfillEdit(
    'updated',
    { id: `prev-truncated:${page.id}`, name: page.name, type: 'PAGE', x: 0, y: 0, parent: null },
    page.name,
    ['prev-truncated'],
  );
}

// ── The per-page write decision ─────────────────────────────────────────────────────

export interface PageSnapshotResult {
  records: NodeSnapshot[];
  truncated: boolean;
  /** Stored for every page — see `BaselinePage.top`. */
  top: TopLevelRecord[];
  /** Nodes (and top-level frames) whose properties threw. A walk with any of these is
   *  INCOMPLETE, and the write decision below refuses to let it overwrite a usable
   *  history. */
  propertyReadErrors: number;
  /** The ids of those nodes, when the id itself could still be read — a sample, with
   *  `propertyReadErrors` as the authoritative count. */
  errorNodeIds: string[];
}

/**
 * The per-page write DECISION, pure so it is testable without a live sandbox. `walk` is
 * the result of the figma-dependent page walk, or `null` when that walk FAILED — e.g. a
 * page that isn't loaded under `dynamic-page`, which refuses to enumerate its children.
 * On success: a fresh page entry, carrying records only when the page is not truncated,
 * and the top-level fingerprint either way. On failure: the PREVIOUS entry carries forward
 * VERBATIM, so one page's failure never discards that page's usable history nor any OTHER
 * page's fresh data; `null` when there was no previous entry either (a brand-new page
 * whose first snapshot attempt failed — nothing to keep).
 *
 * A walk that COMPLETED but could not read every node is treated the same way, whenever
 * there is a previous entry: storing it would bake the missing nodes in, and the next
 * session would then report each of them as `created` when it reads them again. With no
 * previous entry there is nothing better to keep, so the incomplete walk is stored — its
 * gaps cost a few wrong `created` frames next session, where storing nothing would cost
 * one for every node on the page.
 */
export function resolveBaselinePage(
  page: { id: string; name: string },
  prevEntry: BaselinePage | undefined,
  walk: PageSnapshotResult | null,
): BaselinePage | null {
  if (!walk) return prevEntry ?? null;
  if (walk.propertyReadErrors > 0 && prevEntry) return prevEntry;
  const { records, truncated, top } = walk;
  return truncated
    ? { id: page.id, name: page.name, truncated: true, top }
    : { id: page.id, name: page.name, truncated: false, top, records: records.map(toBaselineRecord) };
}
