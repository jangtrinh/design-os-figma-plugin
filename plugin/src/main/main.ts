// Plugin MAIN thread — command dispatch loop.
// The UI relay (plugin/src/ui/ui-relay.ts) forwards CLI requests as
// {requestId, cmd, params}; every handler runs against the Figma scene and
// replies {requestId, ok:true, result} or {requestId, ok:false, error:{code,message}}.
// Orchestration handlers that need the dispatch itself (IMPORT_PAYLOAD, BATCH)
// live here; single-command executors live in executor-*.ts.

import type { CommandName, ErrorCode, FileContext, WireError } from '../../../shared/protocol';
import { DEFAULT_IDLE_MS, MIN_IDLE_MS } from '../../../shared/protocol';
import { fileMatches } from '../../../shared/file-match';
import type { FigmaExportPayload } from '../../../shared/figma-payload-types';
import {
  clearLegacyGapfillDocumentData, runGapfillDiff, snapshotPageBounded, writeBaseline,
} from './edit-gapfill';
import { createIdleBaselineWriter } from './idle-baseline-write';
import { runBootCapture } from './boot-capture';
import { createClientStorageBaselineStore } from './gapfill-baseline-store';
import { createGapfillStats, toGapfillStatus } from './gapfill-status';
import {
  createPerfStats, markBootComplete, recordLoadAllPages, toPerfStatus,
} from './perf-stats';
import {
  pruneDeclaredIds, pruneLastAgentAt, AGENT_ECHO_MS, type ActorState,
} from './edit-actor';
import { createEditIdentityCache } from './change-node-identity';
import { createDocumentChangeCapture } from './document-change-capture';
import {
  createColorStyles, createTextStyles, createEffectStyles,
  resetImportWarnings, getImportWarnings, withCode,
} from './executor-styles';
import { opCreateVariable, opBindVariable } from './executor-variables';
import { resetKeyedVariableCache } from './executor-keyed-vars';
import { resolveTokenVars } from './executor-token-var-resolve';
import { createFigmaNode } from './executor-frame';
import { serializeDesignSystem } from './serialize-node';
import { auditDs } from './executor-audit';
import { figmaContextEnv, opGetContext } from './executor-context';
import {
  opStatus, opGetSelection, opCreateFrame, opCreateInstance, opSetVariant,
  opSetAutoLayout, opSetConstraints, opSetText, opExportPng,
} from './executor-ops';
import { opExecJs } from './executor-exec-js';
import { opCloneTraits } from './executor-clone-traits';
import { importGradient } from './executor-gradient';
import { MUTATING_COMMANDS } from '../../../shared/mutating-commands';
import { opConnect, opDisconnect, opListConnections, opReroute, opVerifyConnections } from './executor-connector';
import { noteChangedNodes } from './connector-reroute';
import {
  beginAgentMutation,
  beginCorrectionBatch,
  flushCorrectionBatch,
  readEdgeCorrections,
  readEvictedUnresolvedCount,
  recordAgentMutationBatch,
  recordDesignerCorrectionInBatch,
  writeEdgeCorrections,
} from './correction-edge-store';
import type { CorrectionEvent } from '../../../shared/supervised-memory';
import { RAIL_HEIGHT, RAIL_MIN_WIDTH, resolveViewportRequest } from '../ui/panel-model';
import {
  createReadOnlyGuardState, isReadOnlyExecJs, recordDocumentChangeBatch,
  snapshotChangeEvents, violatedSinceSnapshot,
} from './readonly-guard';

// The panel is ONE row that hugs its content. It opens at the narrowest width the host's
// own title bar can still render "design:os by JANG" in full; from there the iframe measures
// its rendered row and asks for that width. Main owns the band and the height, and never
// trusts the number on the wire (panel-model.ts's `clampRailWidth`).
//
// Owner decree 2026-07-30: the plugin window's own (host-drawn) title bar cannot be
// removed and duplicated the panel's internal masthead, which is now gone (panel.html) —
// this is the other half of that fix. Confirmed live: a blank title DOES render (the
// owner's screenshot showed it working) — this is now the owner's exact wording for the
// title bar's live text, not a placeholder.
//
// `themeColors: true` (owner requirement, system/Figma appearance): Figma stamps
// `figma-dark`/`figma-light` onto the iframe document's <html> element to match the
// user's current Figma appearance — documented `showUI` behavior. panel.html's
// `html.figma-light { ... }` override block (a sibling of the default dark :root) is
// what actually repaints every color token; this flag is what makes that class exist.
figma.showUI(__html__, {
  visible: true, width: RAIL_MIN_WIDTH, height: RAIL_HEIGHT, title: 'design:os by JANG', themeColors: true,
});

// Absorption phase-03 (FigJam) — which design-only boot capabilities this session
// consciously skipped, surfaced via STATUS's `bootSkipped` (same present-only-when-
// non-empty contract as the broker's senderMismatchCount/legacyMigrationDeferred).
// Empty today: neither the phase-03 (FigJam) nor phase-04 (Slides) boot-path trace
// found anything in THIS boot sequence that needs skipping — gap-fill/live capture
// already degrade honestly for both editors' native node types (verbatim node.type,
// no design-only property reads; see knowledge/figjam.md, knowledge/slides.md). Kept
// as real, mutable state (not a hardcoded `[]` at the call site) so a future editor
// surface has somewhere to push an entry without a STATUS payload shape change.
const bootSkipped: string[] = [];

// auto-connect slice 2 (fix round) — offer a "Reconnect figma-agent" entry in
// Figma's own relaunch menu, but ONLY on a file the CLI has actually bound
// (`figma-agent bind`) — never write into a document nobody asked this plugin to
// manage. The plugin's main thread has no filesystem access and cannot read
// design/figma-bind.json itself, so it waits for the broker's own answer: the
// SAME SYNC_CONFIG event that already carries the idle window now also carries
// `bound` (broker-daemon.ts's PLUGIN_HELLO/PROJECT_BIND handlers, same bind-index
// lookup already done for idleMs — no new round trip). Fires at most ONCE per
// plugin session (`relaunchAttempted`), the first time `bound` reads true —
// still "once at startup" in spirit, just gated on the first honest answer
// instead of firing blind before anyone could know. UNVERIFIED here (zero prior
// `setRelaunchData` use in this repo): it writes to the document, may mark it
// dirty, may be refused on a file the user cannot edit, and the button itself
// only appears after this call has actually landed once — see the phase's
// live-test items. A refusal or a deliberate skip is never a bare console-only
// no-op: both land on `bootSkipped` so `status` and the live test have
// something to read.
let relaunchAttempted = false;
let relaunchUnboundNoted = false;
function maybeSetRelaunchData(bound: boolean): void {
  if (relaunchAttempted) return;
  if (!bound) {
    // Logged once, not on every reconnect while the file stays unbound — this is the
    // ordinary state for a fresh/unbound session, not a fault; `bootSkipped` still
    // carries it once so a live test (or `status`) can see WHY no button appeared.
    if (!relaunchUnboundNoted) {
      relaunchUnboundNoted = true;
      bootSkipped.push('relaunchData: skipped (file not bound — run `figma-agent bind`)');
    }
    return;
  }
  relaunchAttempted = true;
  try {
    figma.root.setRelaunchData({ open: 'Reconnect figma-agent' });
  } catch (err) {
    bootSkipped.push(`relaunchData: refused (${err instanceof Error ? err.message : String(err)})`);
  }
}

/** Block 2's Selection row: the first selected node's name (if any) + the count. */
function selectionSummary(): { selectionName: string | null; selectionCount: number } {
  const sel = figma.currentPage.selection; // sync getter, allowed under dynamic-page
  return { selectionName: sel.length > 0 ? sel[0].name : null, selectionCount: sel.length };
}

// Announce scene identity to the UI iframe so the panel's Context block can show
// File/Page/Selection; ui-relay also forwards this to the broker (enriches
// PLUGIN_HELLO / `figma-agent status`). Re-announce on page change AND selection
// change so the panel stays current.
let announcedFileName = '';

function announceFileInfo(): void {
  announcedFileName = figma.root.name;
  figma.ui.postMessage({
    type: 'FILE_INFO',
    data: {
      fileName: figma.root.name, page: figma.currentPage.name, fileKey: figma.fileKey ?? null,
      ...selectionSummary(),
    },
  });
}
announceFileInfo();
figma.on('currentpagechange', announceFileInfo);
// `selectionchange` fires on every click — the handler posts five-ish scalars with no
// scene traversal and no await, so it is cheap enough to leave undebounced; debouncing
// would delay the panel behind the user's own click.
figma.on('selectionchange', announceFileInfo);

/**
 * The file identity read at every request, with a rename self-heal: sync getters only,
 * safe under dynamic-page and cheap enough to call per request. `announceFileInfo` fires
 * only at startup and on `currentpagechange`; renaming the Figma FILE fires neither event,
 * so the broker's registry would keep routing the old name (and the guard below would then
 * refuse the new one). Re-announcing whenever `figma.root.name` drifts lets routing and the
 * guard converge within one round-trip instead of staying stale until the panel reloads.
 */
function fileContext(): FileContext {
  const ctx = { fileName: figma.root.name, fileKey: figma.fileKey ?? null };
  if (ctx.fileName !== announcedFileName) announceFileInfo();
  return ctx;
}

// ─── Live-sync capture (spec 004 P1) ────────────────────────────────
// Watch whole-document edits, coalesce to the component level, and post the batch
// as DOC_CHANGE; the relay forwards it to the broker, which appends it to
// design/figma.changes.jsonl. Capture ONLY — no reconcile, no registry write here.
//
// The `dynamic-page` manifest requires loadAllPagesAsync() BEFORE subscribing to
// `documentchange`, or the event fires for the current page only. We pay that cost
// once at boot (RAM measured in the P1 dogfood) so edits on any page are captured.

// ─── Actor classification state (wave 4.4 phase 01) ──────────────────
// Post-review fix (Codex P1, round 1): concurrent overlapping dispatches to the same
// plugin instance are real (two CLI invocations racing the same file), so this is a
// COUNTER — not a single scalar "busy until" that one dispatch finishing would clobber
// for another still in flight.
//
// Post-review fix (Codex P1, round 2): `declaredIds` gets the SAME per-id lifecycle as
// `lastAgentAt`, not a blanket add-only union cleared in one sweep — that version grew
// unboundedly under continuous traffic and let a long-finished request's ids keep
// mislabelling a much-later owner edit as `agent`. Now nodeId → expiresAt: `Infinity`
// while the declaring dispatch is active, stamped to `now + AGENT_ECHO_MS` in THAT
// dispatch's own `finally`, then pruned per-id (not blanket-cleared).
let activeCount = 0;
let lastDrainAt = 0; // epoch ms the count last returned to 0 (0 = never has)
const declaredIds = new Map<string, number>();
const lastAgentAt = new Map<string, number>();

function actorState(): ActorState {
  return { activeCount, lastDrainAt, declared: declaredIds, lastAgentAt };
}

// ─── Read-only EXEC_JS enforcement ──────────────────────
// See readonly-guard.ts for the full attribution design (why `activeCount === 1` is the
// signal, and the documented residual gap it accepts). `readOnlyViolations` follows the
// broker's own senderMismatchCount/legacyMigrationDeferred contract: surfaced in STATUS
// only once it is actually non-empty (executor-ops.ts's opStatus).
const readOnlyGuard = createReadOnlyGuardState();
let readOnlyViolations = 0;

// ─── Idle-commit timer (spec 004 P4) ────────────────────────────────
// Every captured documentchange resets a debounce; after IDLE_MS of quiet the plugin
// posts IDLE_READY {count} to its iframe, which shows the "N changes — Sync now /
// Later" prompt. IDLE_MS defaults to 5 min and is overridden by SYNC_CONFIG (the
// project's design/figma-sync.json, relayed by the broker). The change-log the broker
// already persisted is the source of truth — the timer only decides WHEN to prompt.
let idleMs = DEFAULT_IDLE_MS;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let changesSinceCommit = 0;
// Reconnect gap-fill — WHICH pages the stored baseline is now behind on. Any widened edit
// marks its page, not just a component-level one (a session with only ordinary-frame edits
// still needs a fresh baseline for the next reconnect's diff). Separate from
// `changesSinceCommit` on purpose: that counter is the component-log's own "N changes
// ready" prompt count and must not be conflated with the baseline's freshness.
//
// A SET rather than a flag because the idle re-walk used to cost the whole document for one
// edit — 21 pages of walking to refresh the one page that changed. The event stream already
// knows which page it was.
const dirtyPageIds = new Set<string>();

// The baseline lives in `figma.clientStorage` (gapfill-baseline-store.ts) — per machine,
// async, and invisible to `documentchange`, so writing it can never feed the very timer
// that scheduled it.
const baselineStore = createClientStorageBaselineStore();
const gapfillStats = createGapfillStats();
// Where a session's time actually went (perf-stats.ts) — the boot walk this plugin
// controls and the two host costs it does not. Reported by STATUS's `perf` block.
const perfStats = createPerfStats();

// Claim-and-clear, single-flight, dirty-pages-only: the rules and their reasons live in
// idle-baseline-write.ts, where they are tested directly. If this write is REFUSED
// (quota), the claimed page ids are not re-marked: the stored baseline stays older, so the
// next boot's gap-fill re-reports edits already captured live — duplicates, never a loss —
// and the refusal itself is counted in `gapfillStats`.
const triggerBaselineWrite = createIdleBaselineWriter<PageNode>({
  dirtyPageIds,
  pages: () => figma.root.children,
  write: (pages, dirty) => writeBaseline(
    pages,
    (page) => snapshotPageBounded(page, perfStats, 'idle'),
    baselineStore, gapfillStats, Date.now, dirty,
  ),
});

function resetIdleTimer(): void {
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = setTimeout(fireIdle, idleMs);
}

function fireIdle(): void {
  idleTimer = null;
  // Written on a debounce after each idle window — regardless of whether this window's
  // activity was component-scoped, since the baseline tracks EVERY node. Only the pages
  // that actually changed are re-walked (the writer claims and clears the dirty set).
  if (dirtyPageIds.size > 0) triggerBaselineWrite();
  if (changesSinceCommit <= 0) return; // nothing accumulated — no prompt
  figma.ui.postMessage({ type: 'IDLE_READY', data: { count: changesSinceCommit } });
  // Reset here: the displayed count means "changes since this prompt". The log/cursor
  // stay authoritative — Sync applies EVERYTHING past the cursor regardless of count.
  changesSinceCommit = 0;
}

// The handler itself lives in document-change-capture.ts (main.ts cannot be imported
// outside a live sandbox — it calls `figma.showUI` at module load — so the hottest loop in
// the plugin is only testable from its own module). Everything session-scoped stays here:
// this file owns the state, that module owns the pass over one delivered batch.
const editIdentityCache = createEditIdentityCache();
const capture = createDocumentChangeCapture({
  now: () => Date.now(),
  onBatchStart: (now) => {
    pruneDeclaredIds(declaredIds, now); // once per batch — nothing reads `declared` between batches
    // Read-only EXEC_JS enforcement — once per batch, not per node: this records
    // ATTRIBUTABILITY ("could this batch belong to the one active dispatch"), not which
    // node changed. See readonly-guard.ts.
    recordDocumentChangeBatch(readOnlyGuard, activeCount);
  },
  actorState,
  identity: editIdentityCache,
  // The store is read once for the whole batch and written once at its end — never per
  // changed node, which is what made a 50-node drag pay for the whole store 50 times.
  corrections: {
    begin: beginCorrectionBatch,
    record: recordDesignerCorrectionInBatch,
    flush: flushCorrectionBatch,
  },
  noteChangedNodes: (nodeIds) => { void noteChangedNodes(nodeIds); },
  post: (message) => { figma.ui.postMessage(message); },
  noteComponentChanges: (count) => { changesSinceCommit += count; },
  notePageDirty: (pageId) => { dirtyPageIds.add(pageId); }, // the next idle fire re-walks exactly these
  armIdle: resetIdleTimer,
});

// Reconnect gap-fill (wave 4.4 phase 02 §2) — ONE diff against the PREVIOUS session's
// snapshot, covering the window this plugin was closed (page switches need no gap-fill:
// `documentchange` is document-wide once `loadAllPagesAsync` has run, the spec's own
// verdict). Completes BEFORE subscribing to `documentchange`, so a live edit can never race
// the boot diff's read of the about-to-be-superseded snapshot. The diff yields between
// pages (boot must not hold the plugin thread for the whole document — the measured freeze
// on large files); an edit made during a yield is not seen live (no subscription yet) AND
// is absent from the pre-edit baseline the diff writes, so the NEXT session's gap-fill
// reports it — delayed, never lost. `runGapfillDiff` itself writes the fresh baseline
// before resolving.
async function reportGapfill(): Promise<void> {
  const gapfillEdits = await runGapfillDiff(figma.root.children, baselineStore, gapfillStats, perfStats);
  if (gapfillEdits.length > 0) {
    // Posted DIRECTLY, never through `coalesceEdits`. `coalesceEdits` keys by nodeId ALONE
    // across the WHOLE batch, with no notion of page — a node that moved pages between
    // sessions (deleted on page A, created on page B, same stable node id) would collapse
    // into ONE entry carrying the FIRST page seen and the LAST op seen, mislabelling a
    // create as landing on the wrong page. `runGapfillDiff`/`gapfillEditsForPage` already
    // guarantee one edit per node PER PAGE (each page's own diff is computed and coalesced
    // independently), so a cross-page rename/move is deliberately reported as two
    // separate, correctly-paged frames (deleted on A, created on B) rather than merged
    // into a single frame that could carry the wrong page.
    figma.ui.postMessage({
      type: 'EDIT_FEED',
      data: {
        edits: gapfillEdits, fileKey: figma.fileKey ?? null,
        fileName: figma.root.name, source: 'gapfill',
      },
    });
  }
  // The one-time removal of the pre-clientStorage in-document baseline. AFTER the diff
  // (which never reads those keys) and BEFORE subscribing, because clearing them is a
  // `figma.root` write and a write to the document is exactly the kind of event this
  // handler would otherwise report back to the project as an owner edit.
  clearLegacyGapfillDocumentData(gapfillStats);
}

// Subscribe only after all pages are loaded (dynamic-page requirement) — and subscribe even
// when gap-fill failed: the closed-window report and the session's live capture are two
// different things, and one page refusing to walk must not cost the second. Sequencing and
// failure semantics live in boot-capture.ts, where they are tested directly.
void runBootCapture({
  loadAllPages: async () => {
    // Timed, not guessed: whether the boot wait is Figma's page load or this plugin's walk
    // is the whole question the progressive-load decision turns on, and STATUS is where
    // that answer has to be readable.
    const startedAt = Date.now();
    await figma.loadAllPagesAsync();
    recordLoadAllPages(perfStats, Date.now() - startedAt);
  },
  gapfill: async () => {
    // `finally`: a gap-fill that failed still measured whatever it did, and a `perf` block
    // that disappears on the interesting boots is worse than one full of zeros.
    try { await reportGapfill(); } finally { markBootComplete(perfStats); }
  },
  subscribe: () => { figma.on('documentchange', capture.onDocumentChange); },
  notify: (message) => { figma.notify(message); },
});

// There is deliberately NO `figma.on('close', ...)` baseline write. The store is async and
// a close callback must not be (the sandbox is destroyed the instant it returns), and the
// write it used to do was into the document — the write this whole change removes. Closing
// mid-session therefore leaves an OLDER baseline, which the next boot diffs against: some
// edits already reported live get reported once more (duplicates, net-correct), and none
// is lost.

type Params = Record<string, unknown>;

interface UiRequest {
  requestId: string; cmd: CommandName; params?: Params; expectedFile?: string;
  /** Concurrency & jobs — the caller's `--read-only` declaration, carried this far by
   *  ui-relay.ts (see its own comment). Only EXEC_JS reads it (readonly-guard.ts's
   *  `isReadOnlyExecJs`) — every other mutating command is already refused this flag
   *  at the CLI, before a request ever reaches the wire. */
  readOnly?: boolean;
}

figma.ui.onmessage = async (msg: unknown) => {
  const chrome = msg as { type?: unknown; data?: unknown } | null;
  const viewport = resolveViewportRequest(msg);
  if (viewport) {
    figma.ui.resize(viewport.width, viewport.height);
    return;
  }
  // Live-sync (spec 004 P4): the broker's idle window, relayed by the iframe.
  if (chrome && chrome.type === 'SYNC_CONFIG') {
    const data = chrome.data as { idleMs?: unknown; bound?: unknown } | undefined;
    const raw = data?.idleMs;
    if (typeof raw === 'number' && Number.isFinite(raw)) idleMs = Math.max(MIN_IDLE_MS, Math.floor(raw));
    // auto-connect slice 2 (fix round) — gate the relaunch button on the broker's own
    // bind-index answer, never a bare startup guess.
    maybeSetRelaunchData(data?.bound === true);
    return;
  }
  // The panel's sync-result listener posts this ONCE THE OUTCOME IS KNOWN (fix round,
  // finding 2 — it used to post on click, before any result existed), carrying `commit`
  // (panel-model.ts's `shouldClearPendingCount` — true only for a genuine apply success).
  // Closing review round, defect #2: a real reconcile failure or "already running" also
  // applied nothing, so resetting the counter there was just as dishonest as resetting it
  // on an E_UNBOUND refusal — every failure must leave the counter (and the prompt) intact.
  if (chrome && chrome.type === 'SYNC_DONE') {
    if ((chrome as { commit?: unknown }).commit === true) changesSinceCommit = 0;
    return;
  }
  // The relay boots before main's first FILE_INFO push can possibly have arrived — an
  // iframe-originated error raised in that window would otherwise have no identity to
  // attach to its reply. Re-announcing on demand closes that race.
  if (chrome && chrome.type === 'UI_READY') { announceFileInfo(); return; }
  const req = msg as Partial<UiRequest> | null;
  if (!req || typeof req.requestId !== 'string' || typeof req.cmd !== 'string') return; // relay chatter, not a command
  const ctx = fileContext();
  try {
    if (typeof req.expectedFile === 'string' && req.expectedFile.trim() !== ''
        && !fileMatches(ctx.fileName, req.expectedFile, true)) {
      // Guard runs at the wire boundary, BEFORE any executor: a wrong-file command must not
      // touch the scene, and must not be recorded as an agent mutation either.
      throw withCode(new Error(
        `this plugin is connected to file "${ctx.fileName}", command expected "${req.expectedFile}" — nothing was executed`,
      ), 'E_WRONG_FILE');
    }
    const targetIds = mutationTargetIds(req.cmd as CommandName, req.params ?? {});
    beginAgentMutation(targetIds);
    // Actor classification (wave 4.4 P1, post-review counter fix): increment on entry,
    // decrement in `finally` so a THROW still balances the count — two commands
    // overlapping in flight to this plugin instance must not clobber each other's window.
    // Round 2: this dispatch's OWN target ids go in as `Infinity` (still active) and get
    // stamped to a real expiry in ITS OWN finally below — never a blanket union that
    // another still-active dispatch's ids could be cleared alongside.
    activeCount += 1;
    for (const id of targetIds) declaredIds.set(id, Infinity);
    // Read-only EXEC_JS enforcement — snapshot BEFORE `dispatch`, the same
    // moment this dispatch starts counting as "active" above, so the window covers its
    // entire run. See readonly-guard.ts for why `activeCount` is the attribution signal.
    const enforceReadOnly = isReadOnlyExecJs(req.cmd, req.readOnly);
    const readOnlySnapshot = enforceReadOnly ? snapshotChangeEvents(readOnlyGuard) : 0;
    try {
      const result = await dispatch(req.cmd, req.params ?? {});
      if (enforceReadOnly && violatedSinceSnapshot(readOnlyGuard, readOnlySnapshot)) {
        // The script already ran and already mutated — v1 is detect + refuse + count,
        // never a silent apply. `commitIfMutating` below (this dispatch's `catch`, via
        // the throw) still seals the leaked write into its OWN undo step (EXEC_JS is in
        // MUTATING_COMMANDS), same as any other exec-js failure — a designer can revert
        // it with a single ⌘Z. Auto-rollback beyond that is deliberately out of scope
        // for v1 (see the PR description's open-question note).
        readOnlyViolations += 1;
        throw withCode(new Error(
          'EXEC_JS declared --read-only but mutated the scene — a read-only-declared '
          + 'script must not write; refused (the mutation already ran and was sealed '
          + 'into its own undo step, not the caller\'s previous one)',
        ), 'E_READONLY_VIOLATION');
      }
      // A creating command's target id only exists in `result` — `targetIds` (armed
      // before dispatch) cannot have carried it. `recordAgentMutationBatch` arms the
      // suppression window for every id in `changedIds` at the SAME moment it records
      // their provenance, so a freshly created node's own writes are covered too (see
      // correction-edge-store.ts's own doc comment for why the window must be armed here).
      const changedIds = [...new Set([...targetIds, ...resultMutationIds(req.cmd as CommandName, result)])];
      recordAgentMutationBatch(changedIds, { command: req.cmd });
      const completedAt = Date.now();
      for (const nodeId of changedIds) lastAgentAt.set(nodeId, completedAt);
      pruneLastAgentAt(lastAgentAt, completedAt);
      commitIfMutating(req.cmd as CommandName);
      figma.ui.postMessage({ requestId: req.requestId, ok: true, result, fileContext: ctx });
    } finally {
      // Known, accepted edge case (not asked to be solved here): if TWO overlapping
      // dispatches happen to declare the SAME nodeId, this one finishing downgrades it
      // to a real expiry even though the other dispatch may still be active and still
      // consider it `Infinity`-declared from its own perspective — a shared id could
      // therefore start counting down early. Rare (two concurrent commands targeting the
      // exact same node) and fails toward `ambiguous`, never a false `agent`, so it is
      // safe to leave unsolved rather than adding per-id refcounting for it.
      const finishedAt = Date.now();
      const expiresAt = finishedAt + AGENT_ECHO_MS;
      for (const id of targetIds) declaredIds.set(id, expiresAt);
      activeCount -= 1;
      if (activeCount === 0) lastDrainAt = finishedAt;
    }
  } catch (err) {
    // Commit on failure too, so a half-applied mutation (e.g. IMPORT_PAYLOAD styles/
    // variables created before the throw) owns its own undo step instead of being
    // swallowed into the next command's. Known limit (not silently improved here): a
    // command that throws mid-way mutated nodes it never recorded, so those writes are
    // NOT added to lastAgentAt — they fall back to the busy-window `ambiguous` rule
    // instead of a false `agent`, which is the honest side to be wrong on.
    commitIfMutating(req.cmd as CommandName);
    figma.ui.postMessage({ requestId: req.requestId, ok: false, error: shapeError(err), fileContext: ctx });
  }
};

/** Commit AFTER the correction-memory bookkeeping so a command and its bookkeeping share one step. */
function commitIfMutating(cmd: CommandName): void {
  if (MUTATING_COMMANDS.indexOf(cmd) !== -1) figma.commitUndo();
}

function shapeError(err: unknown): WireError {
  const code = ((err as { code?: string } | null)?.code ?? 'E_PLUGIN_ERROR') as ErrorCode;
  const message = err instanceof Error ? err.message : String(err);
  const rolledBack = (err as { rolledBack?: boolean } | null)?.rolledBack;
  return rolledBack ? { code, message, rolledBack } : { code, message };
}

function resultMutationIds(cmd: CommandName, result: unknown): string[] {
  const creating: readonly CommandName[] = [
    'CREATE_FRAME', 'CREATE_INSTANCE', 'IMPORT_PAYLOAD', 'HTML_TO_FIGMA', 'CONNECT',
  ];
  if (!creating.includes(cmd) || !result || typeof result !== 'object') return [];
  const id = (result as { id?: unknown }).id;
  return typeof id === 'string' && id ? [id] : [];
}

function mutationTargetIds(cmd: CommandName, params: Params): string[] {
  const mutating: readonly CommandName[] = [
    'SET_VARIANT', 'BIND_VARIABLE', 'SET_AUTOLAYOUT', 'SET_CONSTRAINTS',
    'SET_TEXT', 'CLONE_TRAITS',
  ];
  if (!mutating.includes(cmd)) return [];
  const raw = cmd === 'CLONE_TRAITS' ? params.targetId ?? params.target : params.nodeId ?? params.node;
  return typeof raw === 'string' && raw ? [raw] : [];
}

async function dispatch(cmd: CommandName, params: Params): Promise<unknown> {
  switch (cmd) {
    case 'STATUS': return opStatus(
      bootSkipped, readOnlyViolations, toGapfillStatus(gapfillStats), capture.stats,
      toPerfStatus(perfStats),
    );
    case 'GET_SELECTION': return opGetSelection(params);
    // The change counter handed in here is the SAME signal the read-only guard keeps
    // (one bump per documentchange batch that lands while exactly one dispatch is
    // active). The walk snapshots it and diffs it, so a subtree read across two document
    // states reports `changesDuringWalk` instead of presenting itself as one state.
    case 'GET_CONTEXT': return opGetContext(params, figmaContextEnv(() => snapshotChangeEvents(readOnlyGuard)));
    case 'SCAN_DESIGN_SYSTEM': return serializeDesignSystem();
    case 'AUDIT_DS': return auditDs();
    case 'CREATE_FRAME': return opCreateFrame(params);
    case 'CONNECT': return opConnect(params);
    case 'DISCONNECT': return opDisconnect(params);
    case 'LIST_CONNECTIONS': return opListConnections();
    case 'REROUTE': return opReroute(params);
    case 'VERIFY_CONNECTIONS': return opVerifyConnections();
    case 'CREATE_INSTANCE': return opCreateInstance(params);
    case 'SET_VARIANT': return opSetVariant(params);
    case 'CREATE_VARIABLE': return opCreateVariable(params);
    case 'BIND_VARIABLE': return opBindVariable(params);
    case 'SET_AUTOLAYOUT': return opSetAutoLayout(params);
    case 'SET_CONSTRAINTS': return opSetConstraints(params);
    case 'SET_TEXT': return opSetText(params);
    case 'CLONE_TRAITS': return opCloneTraits(params);
    // Stage-4 MAJOR7 — `evictedUnresolved` surfaces the edge cache's own eviction count
    // (never a panel UI, just an audit signal `sync-corrections` reports on) so an event
    // dropped here before it was ever synced project-side leaves at least a count, not
    // zero trace.
    case 'GET_CORRECTION_MEMORY': return { events: readEdgeCorrections(), evictedUnresolved: readEvictedUnresolvedCount() };
    case 'SET_CORRECTION_MEMORY': {
      const events = params.events;
      if (!Array.isArray(events)) throw withCode(new Error('SET_CORRECTION_MEMORY requires events[]'), 'E_INVALID_ARGS');
      return { events: writeEdgeCorrections(events as CorrectionEvent[]) };
    }
    case 'EXPORT_PNG': return opExportPng(params);
    case 'EXEC_JS': return opExecJs(params);
    case 'IMPORT_PAYLOAD': return importPayload(params);
    case 'IMPORT_GRADIENT': return importGradient(params);
    case 'BATCH': return runBatch(params);
    default:
      // HTML_TO_FIGMA is handled entirely in the UI relay and arrives here as IMPORT_PAYLOAD
      throw withCode(new Error(`unknown command: ${cmd}`), 'E_INVALID_ARGS');
  }
}

/**
 * IMPORT_PAYLOAD: consume a FigmaExportPayload (ported EaseUI code.ts import
 * path): styles + variables from tokens → node tree → position → select.
 */
async function importPayload(params: Params): Promise<{ id: string; name: string; warnings: string[] }> {
  const payload = (params.payload ?? params) as FigmaExportPayload;
  if (!payload || typeof payload !== 'object' || !payload.rootNode) {
    throw withCode(new Error('IMPORT_PAYLOAD requires params.payload (FigmaExportPayload with rootNode)'), 'E_INVALID_ARGS');
  }
  resetImportWarnings();
  resetKeyedVariableCache(); // spec-005 P7/P8: one resolve per variable key, per import run

  // 1. Local styles + variables from tokens (variables are de-duped on re-import);
  //    tokenVars (name → Variable) feeds tokenRefs binding during node build (P3 leg B).
  //    spec-005 P6: the map now also carries the file's EXISTING local variables, so a
  //    rebuild from a spec alone (no payload.tokens) reattaches its bindings by name.
  const tokens = payload.tokens ?? { colors: [], typography: [], spacing: [], radii: [], shadows: [] };
  const colorStyles = await createColorStyles(tokens.colors ?? []);
  await createTextStyles(tokens.typography ?? []);
  await createEffectStyles(tokens.shadows ?? []);
  const tokenVars = await resolveTokenVars(tokens);

  // 2. Build the node tree (tokenRefs bound inline via tokenVars)
  const root = await createFigmaNode(payload.rootNode, colorStyles, tokenVars);
  if (!root) throw new Error('payload rootNode produced no Figma node');

  // 3. Resolve replace target + parent BEFORE positioning
  let replaceTarget: SceneNode | null = null;
  if (typeof params.replaceId === 'string' && params.replaceId) {
    const t = await figma.getNodeByIdAsync(params.replaceId);
    if (t && t.type !== 'DOCUMENT' && t.type !== 'PAGE') replaceTarget = t as SceneNode;
  }
  let parent: BaseNode & ChildrenMixin = figma.currentPage;
  if (typeof params.parentId === 'string' && params.parentId) {
    const p = await figma.getNodeByIdAsync(params.parentId);
    if (p && 'appendChild' in p) parent = p as BaseNode & ChildrenMixin;
  }
  parent.appendChild(root);

  // 4. Position: replace target's coords > explicit x/y > viewport center
  if (replaceTarget) {
    root.x = replaceTarget.x;
    root.y = replaceTarget.y;
    replaceTarget.remove(); // only after the new node is placed successfully
  } else if (typeof params.x === 'number' && typeof params.y === 'number') {
    root.x = params.x;
    root.y = params.y;
  } else {
    root.x = Math.round(figma.viewport.center.x - root.width / 2);
    root.y = Math.round(figma.viewport.center.y - root.height / 2);
  }

  // 5. Select + bring into view (skip silently if parented to another page)
  try {
    figma.currentPage.selection = [root];
    figma.viewport.scrollAndZoomIntoView([root]);
  } catch { /* root not on current page */ }

  figma.notify(`Imported "${payload.name}" (${(tokens.colors ?? []).length} colors, ${(tokens.typography ?? []).length} text styles)`);
  return { id: root.id, name: root.name, warnings: getImportWarnings() };
}

/** BATCH: sequential {cmd, params}[] through the same dispatch; stopOnError optional. */
async function runBatch(params: Params): Promise<{ results: unknown[] }> {
  const ops = Array.isArray(params) ? params : (params.ops as { cmd: CommandName; params?: Params }[]);
  if (!Array.isArray(ops)) {
    throw withCode(new Error('BATCH requires params.ops: {cmd, params}[]'), 'E_INVALID_ARGS');
  }
  const stopOnError = (params as Params).stopOnError === true;
  const results: unknown[] = [];
  for (const op of ops) {
    // Scope note (verified, do not "fix" here): batch children go straight to dispatch
    // and never touch mutationTargetIds/beginAgentMutation/resultMutationIds/
    // recordAgentMutation — that bookkeeping runs only for the top-level request, and
    // BATCH itself yields no target ids. So batch children have no correction-memory
    // record today; per-child commits therefore cannot split a command from bookkeeping
    // that does not exist. Pre-existing gap, out of scope for this wave.
    try {
      results.push({ ok: true, cmd: op.cmd, result: await dispatch(op.cmd, op.params ?? {}) });
      commitIfMutating(op.cmd);
    } catch (err) {
      commitIfMutating(op.cmd);
      results.push({ ok: false, cmd: op.cmd, error: shapeError(err) });
      if (stopOnError) break;
    }
  }
  return { results };
}
