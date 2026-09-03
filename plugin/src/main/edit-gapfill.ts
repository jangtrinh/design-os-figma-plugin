// Reconnect gap-fill — covers the window the live event stream cannot see: the plugin was
// CLOSED. Page switches need no gap-fill — `documentchange` is document-wide once
// `loadAllPagesAsync` has run — so only the plugin-closed window is a real gap.
//
// A compact baseline — existence/name/position ONLY (property-level diffing for the
// offline window is a stated non-goal) — is persisted per FILE in `figma.clientStorage`
// (see gapfill-baseline-store.ts for why it is not in the document, and why one value now
// replaces the old per-page chunk/manifest machinery). The baseline covers EVERY page, not
// just `figma.currentPage`: a page nobody visited is exactly where a closed-window edit
// hides.
//
// Split cleanly into a PURE core (diff, merge, record codec, write decision — no figma
// access, unit-tested in tests/edit-gapfill.test.ts) and the figma-dependent walk/read/
// write halves, which are exercised through an injected store and fake pages in
// tests/edit-gapfill-baseline.test.ts.
import type { EditInput, EditOp } from '../../../shared/edit-feed';
import {
  baselineKeyFor, readFileBaseline, writeFileBaseline,
  type BaselineIdentity, type BaselinePage, type BaselineRecord, type BaselineStore, type FileBaseline,
} from './gapfill-baseline-store';
import { recordGapfillError, recordGapfillEviction, type GapfillStats } from './gapfill-status';

export interface NodeSnapshot {
  id: string;
  name: string;
  type: string;
  x: number;
  y: number;
  parent: string | null;
}

/** The pre-clientStorage baseline: a manifest plus per-page chunks written into
 *  `figma.root`'s sharedPluginData. Cleared once, never read — the write path that
 *  produced it threw on its first record on every file, so the data behind these keys is
 *  either absent or a fragment no diff may trust. */
const LEGACY_NS = 'ease_design';
const LEGACY_MANIFEST_KEY = 'figma-edit-snapshot-v1';
const LEGACY_CHUNK_PREFIX = 'figma-edit-snap-';

/** The repo's existing scan budget — a page over this reports `truncated: true` rather
 *  than silently under-reporting (deleted nodes past the cap are unknowable, and saying so
 *  is the honest answer). */
export const SNAPSHOT_NODE_CAP_PER_PAGE = 4_000;

// ── Pure core (unit-tested directly, no figma access) ───────────────────────────────

/** Rounds to 0.5px — a sub-pixel re-layout must not churn the baseline or spuriously
 *  report a "moved" node between two sessions. */
export function normalizeSnapshotCoord(n: number): number {
  return Math.round(n * 2) / 2;
}

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

/** One macrotask hop between per-page walks, so the boot diff never holds the plugin's
 *  single thread for the whole document at once (the UI-freeze half of the boot cost). */
function yieldToHost(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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

/** Merges `renamed`+`moved` pairs for the SAME node into one `updated` EditInput with the
 *  union of changedProps — the wire format's own "one frame per node per batch" contract
 *  (mirrors `coalesceEdits`), so a node that changed both is reported ONCE, not twice.
 *  Pure — the seam `runGapfillDiff` (figma-dependent) delegates to. */
export function mergeUpdatedRecords(renamed: readonly RecordPair[], moved: readonly RecordPair[]): Array<{ rec: NodeSnapshot; changedProps: string[] }> {
  const byId = new Map<string, { rec: NodeSnapshot; props: Set<string> }>();
  for (const { next } of renamed) {
    const entry = byId.get(next.id) ?? { rec: next, props: new Set<string>() };
    entry.props.add('name');
    byId.set(next.id, entry);
  }
  for (const { next } of moved) {
    const entry = byId.get(next.id) ?? { rec: next, props: new Set<string>() };
    entry.props.add('x');
    entry.props.add('y');
    byId.set(next.id, entry);
  }
  return [...byId.values()].map(({ rec, props }) => ({ rec, changedProps: [...props].sort() }));
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

function toGapfillEdit(op: EditOp, rec: NodeSnapshot, page: string, changedProps: string[] = []): EditInput {
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
export function gapfillEditsForPage(diff: GapfillDiff, pageName: string): EditInput[] {
  const edits: EditInput[] = [];
  for (const rec of diff.created) edits.push(toGapfillEdit('created', rec, pageName));
  for (const rec of diff.deleted) edits.push(toGapfillEdit('deleted', rec, pageName));
  for (const { rec, changedProps } of mergeUpdatedRecords(diff.renamed, diff.moved)) {
    edits.push(toGapfillEdit('updated', rec, pageName, changedProps));
  }
  return edits;
}

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

export interface PageSnapshotResult { records: NodeSnapshot[]; truncated: boolean }

/**
 * The per-page write DECISION, pure so it is testable without a live sandbox: `snapshot`
 * is the figma-dependent page walk (real caller: `snapshotPage`), free to throw — e.g.
 * `PageNode.findAll` on a page that isn't loaded under `dynamic-page`. On success: a fresh
 * page entry, carrying records only when the page is not truncated. On failure: the
 * PREVIOUS entry carries forward VERBATIM, so one page's failure never discards that
 * page's usable history nor any OTHER page's fresh data; `null` when there was no previous
 * entry either (a brand-new page whose first snapshot attempt failed — nothing to keep).
 */
export function resolveBaselinePage(
  page: { id: string; name: string },
  prevEntry: BaselinePage | undefined,
  snapshot: () => PageSnapshotResult,
): BaselinePage | null {
  try {
    const { records, truncated } = snapshot();
    return truncated
      ? { id: page.id, name: page.name, truncated: true }
      : { id: page.id, name: page.name, truncated: false, records: records.map(toBaselineRecord) };
  } catch {
    return prevEntry ?? null;
  }
}

/**
 * Coalescing trigger for an ASYNC write that must never run twice at once. A trigger
 * arriving while a write is in flight re-arms it exactly once for after that write
 * settles, so the request is neither dropped nor allowed to interleave two writes racing
 * for the same key. Any number of triggers during one flight collapse into that single
 * re-run — the later run reads the newer scene anyway. Pure control flow, unit-tested.
 */
export function createSingleFlightWriter(write: () => Promise<void>): () => void {
  let inFlight = false;
  let rearmed = false;

  function settle(): void {
    inFlight = false;
    if (rearmed) { rearmed = false; trigger(); }
  }

  function trigger(): void {
    if (inFlight) { rearmed = true; return; }
    inFlight = true;
    let started: Promise<void>;
    try { started = write(); } catch { settle(); return; }
    started.then(settle, settle);
  }

  return trigger;
}

// ── Figma-dependent halves ─────────────────────────────────────────────────────────

/** Walks one page's tree (existence/name/position only), capped at
 *  `SNAPSHOT_NODE_CAP_PER_PAGE` — a page over the cap sets `truncated: true` rather than
 *  silently under-reporting. */
export function snapshotPage(page: PageNode): PageSnapshotResult {
  const all = page.findAll(() => true);
  const truncated = all.length > SNAPSHOT_NODE_CAP_PER_PAGE;
  const records: NodeSnapshot[] = [];
  for (const node of all) {
    if (records.length >= SNAPSHOT_NODE_CAP_PER_PAGE) break;
    const hasXY = 'x' in node && 'y' in node;
    records.push({
      id: node.id,
      name: node.name,
      type: node.type,
      x: hasXY ? normalizeSnapshotCoord((node as { x: number }).x) : 0,
      y: hasXY ? normalizeSnapshotCoord((node as { y: number }).y) : 0,
      parent: node.parent ? node.parent.id : null,
    });
  }
  return { records, truncated };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function currentIdentity(): BaselineIdentity {
  return { fileKey: figma.fileKey ?? null, fileName: figma.root.name };
}

function currentBaselineKey(): string {
  const { fileKey, fileName } = currentIdentity();
  return baselineKeyFor(fileKey, fileName);
}

async function readBaseline(store: BaselineStore, stats: GapfillStats): Promise<{ baseline: FileBaseline | null; readFailed: boolean }> {
  const { baseline, error, readFailed } = await readFileBaseline(store, currentBaselineKey(), currentIdentity());
  if (error) recordGapfillError(stats, error);
  return { baseline, readFailed: readFailed === true };
}

/**
 * Writes the baseline for every loaded page as ONE clientStorage value — called after the
 * boot diff and on the idle debounce. Never throws: a failure is recorded in STATUS and
 * leaves the PREVIOUS baseline in place, which makes the next session's diff report some
 * already-reported edits again (duplicates) but lose none.
 */
export async function writeBaseline(
  pages: readonly PageNode[],
  // Injectable so the boot path can reuse the walk `runGapfillDiff` already took (see
  // `snapshotProviderFrom`). The idle caller, which has no prior walk to reuse, passes
  // `snapshotPage` itself — there is no implicit default, so no caller can silently write
  // a baseline built by the wrong walker.
  snapshotFor: (page: PageNode) => PageSnapshotResult,
  store: BaselineStore,
  stats: GapfillStats,
  // Injectable so a test can pin the stamp to a known moment. `writtenAt` is not
  // decoration: eviction ranks every file's baseline by it, so a stamp that does not parse
  // back to the write moment silently breaks which file gets dropped under quota.
  now: () => number = Date.now,
): Promise<void> {
  const key = currentBaselineKey();
  const { baseline: prev, readFailed } = await readBaseline(store, stats);
  // A read that FAILED is not an empty baseline. Writing the current scene over a value we
  // could not load would discard the only record of the window the plugin was closed —
  // turning "reported late" into "never reported". Skip this write and keep the stored
  // one; the next write (idle fire or next boot) reads again.
  if (readFailed) {
    recordGapfillError(stats, 'baseline write skipped: the previous baseline could not be read');
    return;
  }
  const prevById = new Map((prev?.pages ?? []).map((p) => [p.id, p]));
  const nextPages: BaselinePage[] = [];
  for (const page of pages) {
    const resolved = resolveBaselinePage(page, prevById.get(page.id), () => snapshotFor(page));
    if (resolved) nextPages.push(resolved);
  }
  const identity = currentIdentity();
  const baseline: FileBaseline = {
    writtenAt: new Date(now()).toISOString(),
    writtenBy: figma.currentUser ? figma.currentUser.name : null,
    fileKey: identity.fileKey,
    fileName: identity.fileName,
    pages: nextPages,
  };
  const result = await writeFileBaseline(store, key, baseline);
  if (result.evicted) recordGapfillEviction(stats, result.evicted);
  if (result.error) recordGapfillError(stats, result.error);
  if (result.ok) {
    stats.baselineWrittenAt = baseline.writtenAt;
    stats.baselineBytes = result.bytes;
  }
}

/**
 * Clears the pre-clientStorage in-document baseline keys, ONCE, when a manifest is still
 * present. Gated on the manifest so an already-clean file pays no document write at all.
 * Deliberately never READS those keys as a baseline: the value behind them is at best a
 * fragment of a walk that threw, and diffing against a fragment invents a "created" frame
 * for every node it is missing. Returns the number of keys cleared.
 */
export function clearLegacyGapfillDocumentData(stats: GapfillStats): number {
  let cleared = 0;
  try {
    if (!figma.root.getSharedPluginData(LEGACY_NS, LEGACY_MANIFEST_KEY)) return 0;
    const keys = figma.root.getSharedPluginDataKeys(LEGACY_NS);
    for (const key of keys) {
      if (key !== LEGACY_MANIFEST_KEY && !key.startsWith(LEGACY_CHUNK_PREFIX)) continue;
      figma.root.setSharedPluginData(LEGACY_NS, key, '');
      cleared += 1;
    }
  } catch (err) {
    recordGapfillError(stats, `legacy gap-fill cleanup failed: ${messageOf(err)}`);
  }
  stats.legacyCleared += cleared;
  return cleared;
}

/**
 * Runs ONCE at boot (main.ts wiring, after `loadAllPagesAsync`): diffs the PREVIOUS
 * session's baseline against the CURRENT scene, across every loaded page, and returns the
 * gap-fill edits ready to post as one EDIT_FEED batch (`source: 'gapfill'`, stamped by the
 * caller). Budget: one diff per reconnect — called exactly once at boot, never on an
 * interval. Writes a FRESH baseline before resolving, so the window between "diffed" and
 * "next observation" never grows stale.
 *
 * Two honest under-reports rather than wrong facts:
 *   - No baseline at all → ONE `baseline-missing` notice, never a whole-file "created"
 *     storm diffed against nothing.
 *   - A page that existed in the PREVIOUS session but is no longer loaded AT ALL → ONE
 *     notice naming the page (never N synthetic per-node deletions — we know the page is
 *     gone, not whether each node was individually deleted).
 *   - Either side of a page truncated → the WHOLE diff for that page is suppressed and
 *     only the truncation notice is emitted.
 *   - A page whose walk THROWS → that page's diff is skipped and the failure recorded;
 *     its previous baseline entry carries forward and every other page still reports.
 */
export async function runGapfillDiff(
  pages: readonly PageNode[],
  store: BaselineStore,
  stats: GapfillStats,
): Promise<EditInput[]> {
  const { baseline: prev } = await readBaseline(store, stats);
  if (!prev) {
    // Nothing to diff, but start the baseline now. Walked here (with yields) so the write
    // below reuses the results; a page whose walk throws is simply not cached, and
    // `resolveBaselinePage`'s own fallback attempt keeps its per-page skip semantics.
    const firstRun = new Map<string, PageSnapshotResult>();
    for (const page of pages) {
      await yieldToHost();
      try { firstRun.set(page.id, snapshotPage(page)); } catch { /* resolveBaselinePage re-attempts and skips */ }
    }
    await writeBaseline(pages, snapshotProviderFrom(firstRun, snapshotPage), store, stats);
    return [baselineMissingNotice(figma.root.name, figma.currentPage.name)];
  }

  const edits: EditInput[] = [];
  const walked = new Map<string, PageSnapshotResult>();
  const currentPageIds = new Set(pages.map((p) => p.id));
  const prevById = new Map(prev.pages.map((p) => [p.id, p]));

  for (const deletedId of deletedPageIds(prev.pages.map((p) => p.id), currentPageIds)) {
    const prevPage = prevById.get(deletedId)!;
    edits.push(toGapfillEdit(
      'deleted',
      { id: `page-deleted:${prevPage.id}`, name: deletedPageLabel(prevPage), type: 'PAGE', x: 0, y: 0, parent: null },
      prevPage.name,
      ['page-deleted'],
    ));
  }

  for (const page of pages) {
    await yieldToHost();
    const prevPage = prevById.get(page.id);
    // A page that refuses to walk (an unloaded dynamic page, a host refusal) costs THIS
    // page's diff for this boot and nothing more: the failure is recorded, every other
    // page still reports, and `writeBaseline` carries this page's previous entry forward
    // verbatim (`resolveBaselinePage`) rather than overwriting its history with nothing.
    let walk: PageSnapshotResult;
    try {
      walk = snapshotPage(page);
    } catch (err) {
      recordGapfillError(stats, `page walk failed on "${page.name}": ${messageOf(err)}`);
      continue;
    }
    const { records: nextRecords, truncated: nextTruncated } = walk;
    walked.set(page.id, walk);
    stats.pagesDiffed += 1;
    if (pageWasTruncated(prevPage?.truncated, nextTruncated)) {
      stats.pagesTruncated += 1;
      edits.push(toGapfillEdit('updated', { id: `truncated:${page.id}`, name: page.name, type: 'PAGE', x: 0, y: 0, parent: null }, page.name, ['truncated']));
      continue; // never a created/deleted/renamed/moved fact for this page this round
    }
    const diff = diffSnapshots((prevPage?.records ?? []).map(fromBaselineRecord), nextRecords);
    edits.push(...gapfillEditsForPage(diff, page.name));
  }
  // The diff window now starts at THIS observation, not session start — and the baseline
  // is the walk taken ABOVE, never a re-walk: an edit made during a yield stays absent
  // from the baseline, so the next session's gap-fill reports it instead of losing it.
  await writeBaseline(pages, snapshotProviderFrom(walked, snapshotPage), store, stats);
  return edits;
}
