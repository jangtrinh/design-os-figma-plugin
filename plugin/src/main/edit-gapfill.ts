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
// This file is the FIGMA-DEPENDENT half: the page walk, the clientStorage read/write and
// the boot diff's control flow, exercised through an injected store and fake pages in
// tests/edit-gapfill-baseline.test.ts. The pure half — diff, record codec, notice frames,
// write decision — lives in gapfill-diff.ts and is unit-tested directly.
import type { EditInput } from '../../../shared/edit-feed';
import {
  baselineKeyFor, clearStaleBaseline, legacyBaselineKeyFor, readFileBaseline, writeFileBaseline,
  type BaselineIdentity, type BaselinePage, type BaselineStore, type FileBaseline,
} from './gapfill-baseline-store';
import {
  baselineMissingNotice, baselineUnreadableNotice, deletedPageIds, diffSnapshots, diffTopLevel,
  fromBaselineRecord, gapfillEditsForPage, pageDeletedNotice, pageWasTruncated,
  previouslyTruncatedNotice, resolveBaselinePage, snapshotProviderFrom, truncatedNotice,
  walkErrorsNotice, withoutSurvivingNodes,
  type GapfillDiff, type PageSnapshotResult,
} from './gapfill-diff';
import { recordGapfillError, recordGapfillEviction, type GapfillStats } from './gapfill-status';
import {
  DEFAULT_SLICE_BUDGET_MS, normalizeSnapshotCoord, walkPageSliced,
  type NodeSnapshot, type SlicedWalkTiming,
} from './page-walk-bounded';
import {
  createPerfStats, recordPageLoadAsync, recordWalk, type PerfStats, type WalkPhase,
} from './perf-stats';

export { normalizeSnapshotCoord };
export type { NodeSnapshot, PageSnapshotResult };

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

/** The UPPER bound on nodes per SYNCHRONOUS slice of a page walk — not the stall budget
 *  itself. Measured at this size on the owner's file: the worst chunk was 45 ms in an
 *  isolated probe and 65 ms on a real cold open, where the walk competes with the iframe and
 *  socket startup. Both are at or past the 50 ms "no visible stall" target, so a node count
 *  cannot hold that target on its own — per-node cost varies by node type and by what else
 *  the host is doing. `SNAPSHOT_SLICE_BUDGET_MS` is what bounds the held thread; this
 *  bounds how far a slice can run when nodes turn out to be cheap. */
export const SNAPSHOT_SLICE_SIZE = 500;

/** The TIME budget for one synchronous slice: the walk yields as soon as this much has
 *  elapsed in the current chunk, so the worst chunk is the budget plus one node's work
 *  (≈ 50 µs). That holds on a machine of any speed, which the 500-node count did not — see
 *  the measurements above. */
export const SNAPSHOT_SLICE_BUDGET_MS = DEFAULT_SLICE_BUDGET_MS;

/** One macrotask hop between per-page walks, so the boot diff never holds the plugin's
 *  single thread for the whole document at once (the UI-freeze half of the boot cost). */
function yieldToHost(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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

/**
 * Walks one page (existence / name / position only), bounded at
 * `SNAPSHOT_NODE_CAP_PER_PAGE` VISITS and sliced at `SNAPSHOT_SLICE_BUDGET_MS` of held
 * thread per synchronous chunk, with `SNAPSHOT_SLICE_SIZE` as that chunk's upper node count
 * — see page-walk-bounded.ts for why `findAll` could not do either.
 * Free to REJECT: a page that cannot enumerate its children has no walk, and the caller
 * must treat that as a failure (previous entry carried forward), never as an empty page.
 *
 * `page.loadAsync()` first, when the host offers it: pages are already resident after
 * `loadAllPagesAsync`, so this is expected to cost ≈ 0 — and that measurement is exactly
 * the evidence the progressive-load decision needs, taken here where it is free.
 */
export async function snapshotPageBounded(
  page: PageNode,
  perf: PerfStats = createPerfStats(),
  phase: WalkPhase = 'idle',
  // The walk's clock and hop, injectable so a test can pin the exact slice timings this
  // records into `perf` — the numbers the "no visible stall" budget is written in.
  timing: SlicedWalkTiming = {},
): Promise<PageSnapshotResult> {
  const loadable = page as unknown as { loadAsync?: () => Promise<void> };
  if (typeof loadable.loadAsync === 'function') {
    const loadStartedAt = Date.now();
    await loadable.loadAsync();
    recordPageLoadAsync(perf, Date.now() - loadStartedAt);
  }
  const walk = await walkPageSliced(page, {
    cap: SNAPSHOT_NODE_CAP_PER_PAGE, sliceSize: SNAPSHOT_SLICE_SIZE,
    sliceBudgetMs: SNAPSHOT_SLICE_BUDGET_MS, ...timing,
  });
  recordWalk(perf, phase, walk);
  return {
    records: walk.records, truncated: walk.truncated, top: walk.top,
    propertyReadErrors: walk.propertyReadErrors, errorNodeIds: walk.errorNodeIds,
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One diff with its surviving `deleted` candidates removed and counted in STATUS. */
async function withoutSurvivors(
  diff: GapfillDiff,
  nodeExists: (id: string) => Promise<boolean>,
  stats: GapfillStats,
): Promise<GapfillDiff> {
  const checked = await withoutSurvivingNodes(diff.deleted, nodeExists);
  stats.deletedRechecked += checked.survived;
  return { ...diff, deleted: checked.deleted };
}

/** Names the page, the number of nodes lost, and — as far as the ids could be read — which
 *  ones, so a session that dropped 40 nodes is diagnosable rather than merely counted. */
function walkErrorMessage(pageName: string, walk: PageSnapshotResult): string {
  const named = walk.errorNodeIds.slice(0, 3);
  const detail = named.length > 0 ? ` (${named.join(', ')}${walk.errorNodeIds.length > named.length ? ', …' : ''})` : '';
  return `gap-fill skipped the diff of "${pageName}": ${walk.propertyReadErrors} node(s) could not be read${detail}`;
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
  // `snapshotPageBounded` itself — there is no implicit default, so no caller can silently
  // write a baseline built by the wrong walker.
  snapshotFor: (page: PageNode) => PageSnapshotResult | Promise<PageSnapshotResult>,
  store: BaselineStore,
  stats: GapfillStats,
  // Injectable so a test can pin the stamp to a known moment. `writtenAt` is not
  // decoration: eviction ranks every file's baseline by it, so a stamp that does not parse
  // back to the write moment silently breaks which file gets dropped under quota.
  now: () => number = Date.now,
  // The IDLE contract: only these page ids are re-walked; every other page's entry carries
  // forward verbatim, so a one-frame edit costs one page instead of the whole document.
  // Omitted (boot) means every page. A page the stored baseline has never heard of is
  // walked regardless — leaving it absent would make the NEXT boot read its whole tree as
  // freshly created, which is a wrong fact, not a saved walk.
  onlyPageIds?: ReadonlySet<string> | null,
): Promise<void> {
  const key = currentBaselineKey();
  // A session that never diffed against the stored baseline must not replace it: the
  // unreadable notice promised those closed-window edits for the next successful BOOT,
  // and a write here — even after reads recover — would bake them in unreported.
  if (stats.bootBaselineUnreadable) {
    recordGapfillError(stats, 'baseline write withheld: this session could not read the stored baseline at boot');
    return;
  }
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
    const prevEntry = prevById.get(page.id);
    if (onlyPageIds && !onlyPageIds.has(page.id) && prevEntry) {
      nextPages.push(prevEntry); // unchanged page: carried forward, walked not at all
      continue;
    }
    // The walk is figma-dependent and free to reject; a failure here is one page's
    // history, never the write.
    let walk: PageSnapshotResult | null = null;
    try {
      walk = await snapshotFor(page);
    } catch (err) {
      recordGapfillError(stats, `page walk failed on "${page.name}": ${messageOf(err)}`);
    }
    const resolved = resolveBaselinePage(page, prevEntry, walk);
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
    // Only now that the new value is safely stored: the superseded previous-shape value is
    // removed so it stops holding storage quota nothing will ever read. Counted, because a
    // deletion of stored data never happens off the record.
    const { fileKey, fileName } = identity;
    const stale = await clearStaleBaseline(store, legacyBaselineKeyFor(fileKey, fileName));
    stats.staleBaselinesCleared += stale.cleared;
    if (stale.error) recordGapfillError(stats, stale.error);
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
 * Whether a node the walk did not see is still in the file. `getNodeByIdAsync` is the only
 * authority on that, and a host that has no such getter — or one that refuses the lookup —
 * leaves the question unanswerable, so the candidate keeps the classification the diff gave
 * it. That is the behaviour this check replaces, applied only where it cannot be improved
 * on; it never invents a survival it could not confirm.
 *
 * A RESOLVED handle is not by itself a survival: `.removed` is this repo's honest check
 * everywhere a node reference is held across an await (see `executor-exec-js.ts`), and a
 * host that answers a gone id with a removed handle rather than `null` would otherwise make
 * every closed-window deletion look like a survivor — the whole `deleted` category would
 * leave the feed and survive only as an anonymous `deletedRechecked` count.
 */
export async function nodeStillExists(id: string): Promise<boolean> {
  try {
    const host = figma as unknown as { getNodeByIdAsync?: (nodeId: string) => Promise<unknown> };
    if (typeof host.getNodeByIdAsync !== 'function') return false;
    const node = await host.getNodeByIdAsync(id);
    return node !== null && !(node as { removed?: boolean }).removed;
  } catch {
    return false;
  }
}

/** Injected seams of the boot diff. Every one has a production default; a test supplies
 *  the ones it needs to pin (a clock with known deltas, a node lookup with known answers).
 */
export interface GapfillDiffDeps {
  /** Cross-check for a `deleted` candidate — see `withoutSurvivingNodes`. */
  nodeExists?: (id: string) => Promise<boolean>;
  /** Clock and between-slice hop for every page walk this diff takes. */
  walk?: SlicedWalkTiming;
}

/** The boot write's page source: the walk already taken above for a page, else a fresh
 *  bounded walk for the few pages that were not cached (their first attempt threw). */
function bootSnapshotProvider(
  walked: ReadonlyMap<string, PageSnapshotResult>,
  perf: PerfStats,
  timing: SlicedWalkTiming,
): (page: PageNode) => PageSnapshotResult | Promise<PageSnapshotResult> {
  return snapshotProviderFrom<PageNode, PageSnapshotResult | Promise<PageSnapshotResult>>(
    walked, (page) => snapshotPageBounded(page, perf, 'boot', timing),
  );
}

/**
 * Runs ONCE at boot (main.ts wiring, after `loadAllPagesAsync`): diffs the PREVIOUS
 * session's baseline against the CURRENT scene, across every loaded page, and returns the
 * gap-fill edits ready to post as one EDIT_FEED batch (`source: 'gapfill'`, stamped by the
 * caller). Budget: one diff per reconnect — called exactly once at boot, never on an
 * interval. Writes a FRESH baseline before resolving, so the window between "diffed" and
 * "next observation" never grows stale.
 *
 * Honest under-reports rather than wrong facts:
 *   - No baseline at all → ONE `baseline-missing` notice, never a whole-file "created"
 *     storm diffed against nothing.
 *   - A baseline the store refused to READ → ONE `baseline-unreadable` notice; no walk, no
 *     write, so the stored baseline survives for the next successful boot.
 *   - A page that existed in the PREVIOUS session but is no longer loaded AT ALL → ONE
 *     notice naming the page (never N synthetic per-node deletions — we know the page is
 *     gone, not whether each node was individually deleted).
 *   - Either side of a page truncated → no per-node diff (a node pushed past the cap by
 *     unrelated growth would read as a deletion), but the page is NOT silent: the notice
 *     for whichever side was over the cap — this session's walk, or only the previous
 *     baseline — plus the TOP-LEVEL diff, which reports real frame-level facts.
 *   - A page whose walk THROWS → that page's diff is skipped and the failure recorded;
 *     its previous baseline entry carries forward and every other page still reports.
 */
export async function runGapfillDiff(
  pages: readonly PageNode[],
  store: BaselineStore,
  stats: GapfillStats,
  // Where the boot walk's timings land. Defaulted so a test that only cares about edits
  // need not supply one; main.ts passes the session's own ledger.
  perf: PerfStats = createPerfStats(),
  deps: GapfillDiffDeps = {},
): Promise<EditInput[]> {
  const nodeExists = deps.nodeExists ?? nodeStillExists;
  const timing = deps.walk ?? {};
  const { baseline: prev, readFailed } = await readBaseline(store, stats);
  if (readFailed) {
    // The store refused the read (error already recorded in `stats`). Skip the walk AND the
    // write: the stored baseline stays intact for the next successful boot. The flag keeps
    // every later write of THIS session withheld too (see `writeBaseline`).
    stats.bootBaselineUnreadable = true;
    return [baselineUnreadableNotice(figma.root.name, figma.currentPage.name)];
  }
  if (!prev) {
    // Nothing to diff, but start the baseline now. Walked here (with yields) so the write
    // below reuses the results; a page whose walk throws is simply not cached, and
    // `resolveBaselinePage`'s own fallback attempt keeps its per-page skip semantics.
    const firstRun = new Map<string, PageSnapshotResult>();
    for (const page of pages) {
      await yieldToHost();
      try { firstRun.set(page.id, await snapshotPageBounded(page, perf, 'boot', timing)); } catch { /* writeBaseline re-attempts and skips */ }
    }
    await writeBaseline(pages, bootSnapshotProvider(firstRun, perf, timing), store, stats);
    return [baselineMissingNotice(figma.root.name, figma.currentPage.name)];
  }

  const edits: EditInput[] = [];
  const walked = new Map<string, PageSnapshotResult>();
  const currentPageIds = new Set(pages.map((p) => p.id));
  const prevById = new Map(prev.pages.map((p) => [p.id, p]));

  for (const deletedId of deletedPageIds(prev.pages.map((p) => p.id), currentPageIds)) {
    edits.push(pageDeletedNotice(prevById.get(deletedId)!));
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
      walk = await snapshotPageBounded(page, perf, 'boot', timing);
    } catch (err) {
      recordGapfillError(stats, `page walk failed on "${page.name}": ${messageOf(err)}`);
      continue;
    }
    const { records: nextRecords, truncated: nextTruncated } = walk;
    // Cached even when it is incomplete: `resolveBaselinePage` prefers the previous entry
    // to it, and falls back to it only for a page the baseline has never held at all.
    walked.set(page.id, walk);
    // A walk that dropped nodes cannot be diffed AT EITHER LEVEL. Every dropped node is
    // missing from `records` — and a dropped TOP-LEVEL frame is missing from `top` — with
    // nothing to distinguish "gone" from "unreadable", so both diffs would state
    // deletions that did not happen. One notice instead, and the previous entry survives.
    //
    // The truncation notice is deliberately NOT also emitted for such a page, even when it
    // is over the cap: that notice claims the page was covered at frame level, and this
    // one was not covered at all. `pagesTruncated` therefore does not count it either —
    // `pagesWithReadErrors` is where this page appears, and `pagesDiffed` is where it
    // does not.
    if (walk.propertyReadErrors > 0) {
      stats.pagesWithReadErrors += 1;
      recordGapfillError(stats, walkErrorMessage(page.name, walk));
      edits.push(walkErrorsNotice(page));
      continue;
    }
    stats.pagesDiffed += 1;
    // EITHER side truncated suppresses the per-NODE diff — one side has no records to
    // compare, and a node pushed past the cap by unrelated growth would read as a deletion.
    // The two sides are different FACTS about the page in front of the owner, though, so
    // each states the one that is true of it.
    if (pageWasTruncated(prevPage?.truncated, nextTruncated)) {
      if (nextTruncated) {
        // The page IS over the cap and its per-node facts stay suppressed — that is still
        // true and still said out loud. This is the ONLY case `pagesTruncated` counts, so
        // that number and the sentence it backs say the same thing.
        stats.pagesTruncated += 1;
        edits.push(truncatedNotice(page));
      } else {
        // The page shrank back under the cap while the plugin was closed. The per-node diff
        // is still impossible — the PREVIOUS baseline stored a fingerprint and no records —
        // but this page does not exceed the cap, so it is neither told that it does nor
        // counted among the pages that do.
        edits.push(previouslyTruncatedNotice(page));
      }
      // What used to be the whole story. On the owner's file 16 of 21 pages are over the
      // cap, so "truncated ⇒ report nothing" made closed-window edits on most of the
      // document vanish without trace. The top-level fingerprint is O(top-level) and gives
      // real frame-level facts; it is compared only when the PREVIOUS session actually
      // stored one, since diffing against an absent fingerprint would invent a "created"
      // frame for every frame on the page.
      const prevTop = prevPage?.top;
      if (prevTop) {
        stats.pagesTopLevelOnly += 1;
        const { diff, coarse } = diffTopLevel(prevTop, walk.top);
        edits.push(...gapfillEditsForPage(await withoutSurvivors(diff, nodeExists, stats), page.name, coarse));
      }
      continue; // never a per-NODE created/deleted/renamed/moved fact for this page
    }
    const diff = diffSnapshots((prevPage?.records ?? []).map(fromBaselineRecord), nextRecords);
    edits.push(...gapfillEditsForPage(await withoutSurvivors(diff, nodeExists, stats), page.name));
  }
  // The diff window now starts at THIS observation, not session start — and the baseline
  // is the walk taken ABOVE, never a re-walk: an edit made during a yield stays absent
  // from the baseline, so the next session's gap-fill reports it instead of losing it.
  await writeBaseline(pages, bootSnapshotProvider(walked, perf, timing), store, stats);
  return edits;
}
