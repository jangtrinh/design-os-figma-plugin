// Live-sync capture — the `documentchange` handler, lifted out of main.ts so the hottest
// loop in the plugin can be tested without a sandbox (main.ts calls `figma.showUI` at
// module load, so importing it outside a live plugin is impossible).
//
// Two collections run over ONE pass of the batch:
//   1. component-scoped changes → DOC_CHANGE → the broker's `figma.changes.jsonl`;
//   2. the widened edit feed → EDIT_FEED → the per-file feed (shared/edit-feed.ts).
// Everything the handler needs that is session state (the actor counters, the idle timer,
// the read-only guard, the correction store) is injected: this module owns the pass, main.ts
// owns the state.

import {
  coalesceChanges, isPluginBookkeepingChange, mapChangeType,
  type ChangeOrigin, type ComponentChange,
} from '../../../shared/figma-changes';
import { coalesceEdits, type EditInput, type EditOrigin } from '../../../shared/edit-feed';
import type { EditIntent } from '../../../shared/edit-intent';
import { classifyActor, type ActorState } from './edit-actor';
import { readEditIntent } from './edit-intent-reader';
import {
  enclosingName, resolveComponentIdentity, type CachedIdentity, type EditIdentityCache,
} from './change-node-identity';
import { pageOf } from './page-of-node';
import { isSentinelId } from './undo-sentinel-registry';

/**
 * The correction store, as this handler uses it: ONE read and at most ONE write per
 * delivered batch. Injected as three calls rather than the store module itself so a test
 * can count exactly what the batch touched.
 */
export interface CorrectionRecorder<TBatch> {
  begin: () => TBatch;
  record: (batch: TBatch, nodeId: string, traits: Record<string, unknown>) => void;
  flush: (batch: TBatch) => void;
}

export interface DocumentChangeCaptureDeps<TBatch> {
  now: () => number;
  /** Per-batch bookkeeping main.ts owns: pruning expired agent declarations and recording
   *  the batch for read-only EXEC_JS attribution. Called once, before the pass. */
  onBatchStart: (now: number) => void;
  actorState: () => ActorState;
  identity: EditIdentityCache;
  corrections: CorrectionRecorder<TBatch>;
  /** The connector index's "these ids moved" hook (debounced by its own module). */
  noteChangedNodes: (nodeIds: string[]) => void;
  post: (message: { type: string; data: unknown }) => void;
  /** N component-level changes were posted — main.ts's idle-prompt count. */
  noteComponentChanges: (count: number) => void;
  /** This page has an edit the stored gap-fill baseline does not know about yet. main.ts
   *  keeps the set; the next idle re-walks exactly these pages and carries every other
   *  page's entry forward, so a one-frame edit costs one page instead of the document. */
  notePageDirty: (pageId: string) => void;
  /** This batch was real activity — push the idle debounce out. */
  armIdle: () => void;
}

/**
 * What this session's capture had to drop, guess or give up on. Every field is
 * present-only-when-non-zero in STATUS (executor-ops.ts's `opStatus`): a filtered change is
 * still a change that happened, a substituted page is still someone's edit filed somewhere
 * it may not belong, and a refused store read is still a refusal — each leaves a counter
 * behind rather than vanishing.
 */
export interface DocumentChangeCaptureStats {
  pluginDataChangesDropped: number;
  /** Raw `documentchange` entries dropped because the node id belongs to the plugin's OWN
   *  undo sentinel (executor-exec-js.ts's `figmaUndoBracket`, tracked by
   *  undo-sentinel-registry.ts) — its CREATE, PROPERTY_CHANGE and DELETE are the sentinel's
   *  own lifecycle, never a designer edit, and matched by id so a user frame that happens
   *  to share its name is never caught. */
  sentinelChangesDropped: number;
  /** How many changed nodes this session had NO page for — a live node with neither its
   *  own chain nor an identity-cache entry, or a deleted node the session never saw — and
   *  were therefore filed under `figma.currentPage`. That name is a guess about someone
   *  else's edit, so it is never made silently. */
  pageFallbacks: number;
  /** Capture-side failures this session: a correction-store per-node read or batch flush
   *  that threw, or a designer-intent read that escaped its own guard. The feed is posted
   *  regardless — bookkeeping about the edits must not cost the edits. */
  errorCount: number;
  /** The FIRST failure message, verbatim: the one describing the original cause rather
   *  than a cascade from it. Same convention as `gapfill.errors` in STATUS. */
  firstError: string | null;
}

export interface DocumentChangeCapture {
  onDocumentChange: (event: DocumentChangeEvent) => void;
  stats: DocumentChangeCaptureStats;
}

export function createDocumentChangeCapture<TBatch>(
  deps: DocumentChangeCaptureDeps<TBatch>,
): DocumentChangeCapture {
  const stats: DocumentChangeCaptureStats = {
    pluginDataChangesDropped: 0, sentinelChangesDropped: 0, pageFallbacks: 0, errorCount: 0, firstError: null,
  };

  /** WHERE an edit happened: the name the feed files it under AND the id the idle re-walk
   *  needs. One resolution, so the two can never disagree about the same edit. */
  interface EditPage { name: string; id: string }

  /** The page for a LIVE node: its own chain first, then the last page this session saw it
   *  on, then — counted, never silent — the page the designer is currently looking at. */
  function resolvedPage(node: SceneNode, remembered: CachedIdentity | undefined): EditPage {
    const own = pageOf(node);
    if (own) return { name: own.name, id: own.id };
    if (remembered !== undefined) return { name: remembered.page, id: remembered.pageId };
    stats.pageFallbacks += 1;
    return { name: figma.currentPage.name, id: figma.currentPage.id };
  }

  /** The page for a REMOVED node: the identity cache is its only record (a RemovedNode
   *  carries no parent chain to walk), so a node this session never saw degrades to the
   *  current page — same guess, same counter, as the live-node fallback above. The cost of
   *  a wrong guess is bounded: that page's baseline simply is not refreshed this idle, so
   *  the next boot re-reports the edit (a duplicate), never loses it. */
  function resolvedRemovedPage(remembered: CachedIdentity | undefined): EditPage {
    if (remembered !== undefined) return { name: remembered.page, id: remembered.pageId };
    stats.pageFallbacks += 1;
    return { name: figma.currentPage.name, id: figma.currentPage.id };
  }

  /** Every failure counts; the first message is kept because it describes the cause. */
  function recordCaptureError(error: unknown): void {
    stats.errorCount += 1;
    if (stats.firstError === null) {
      stats.firstError = error instanceof Error ? error.message : String(error);
    }
  }

  function onDocumentChange(event: DocumentChangeEvent): void {
    const now = deps.now();
    const connectorTouched: string[] = [];
    deps.onBatchStart(now);
    // Correction bookkeeping is ABOUT the edits; it is never allowed to cost them.
    // Opening the batch does no I/O (`beginCorrectionBatch` just allocates
    // `{ events: null, appended: 0 }`) — the store is read lazily, at most once, the
    // first time a per-node `record` call actually needs it, and written at most once by
    // the flush at the end. Both of THOSE reach `sharedPluginData`, which Figma refuses on
    // a file the user cannot edit and throws at its per-entry byte cap — and both run
    // guarded, because an escaping throw would otherwise take the whole delivered batch
    // with it, including the changes already processed. A read refusal disables
    // corrections for the rest of THIS batch (one error for the batch, not one per node)
    // and skips the flush; a flush refusal loses this batch's corrections (there is no
    // scoped copy to retry with — the next batch reads the document afresh) but likewise
    // never escapes. Either way the pass continues and the feed goes out.
    const correctionBatch: TBatch = deps.corrections.begin();
    let correctionsUsable = true;
    const raw: ComponentChange[] = [];
    const edits: EditInput[] = [];
    for (const dc of event.documentChanges) {
      // Filter the TYPE first — before any node dereference. A StyleChange payload
      // carries `style`, not `node`; casting every DocumentChange to `{ node }` and
      // testing `'removed' in changedNode` BEFORE this filter throws on `undefined`
      // for a STYLE_* change — a latent crash (one style edit away from killing
      // capture entirely).
      const op = mapChangeType(dc.type);
      if (op === null) continue; // STYLE_* — filtered before any node dereference
      const node = (dc as { node?: SceneNode | RemovedNode }).node;
      if (!node) continue; // defensive: a node-less change type

      // ONE copy of the property list per change, shared by the correction traits, the
      // component record and the edit record below. Neither `coalesceChanges` nor
      // `coalesceEdits` mutates an input's array (both build a fresh one), so sharing is
      // safe and saves a copy per change in the middle of a drag batch.
      const changedProps = dc.type === 'PROPERTY_CHANGE' ? [...dc.properties] : [];

      // The undo sentinel's own lifecycle (executor-exec-js.ts's `figmaUndoBracket`) comes
      // back through this very handler too: its CREATE, any PROPERTY_CHANGE, and — the leak
      // a designer could otherwise see as "Deleted a FRAME node" — its DELETE once
      // `commit()` removes it. Matched by node id (undo-sentinel-registry.ts), never by
      // name, so a user frame merely NAMED like the sentinel is never caught. Dropped
      // before the bookkeeping filter, same reason as that filter below: none of the
      // correction store, connector index, feed or idle timer may ever see it.
      if (isSentinelId(node.id)) {
        stats.sentinelChangesDropped += 1;
        continue;
      }

      // The plugin's own bookkeeping writes (correction store, connector index, relaunch
      // data) come back through this very handler. Dropped HERE, at the top — before the
      // correction store, the connector index, the feed and the idle timer — because each
      // of those would otherwise read the plugin's own echo as an owner edit and, in the
      // idle timer's case, keep re-arming itself.
      if (isPluginBookkeepingChange(dc.type, changedProps)) {
        stats.pluginDataChangesDropped += 1;
        continue;
      }

      if (correctionsUsable && (!('removed' in node) || !node.removed)) {
        try {
          deps.corrections.record(correctionBatch, node.id, { changeType: dc.type, properties: changedProps });
        } catch (error) {
          recordCaptureError(error);
          correctionsUsable = false;
        }
      }
      // Every touched id, for the connector index — a connector's endpoint may be nested far
      // below whatever actually moved, and only the ancestor chain can bridge that.
      connectorTouched.push(node.id);

      // ── Component-scoped capture (figma.changes.jsonl) ──
      const identity = resolveComponentIdentity(node);
      if (identity) {
        raw.push({
          op,
          nodeId: identity.id,
          nodeName: identity.name,
          nodeType: identity.type,
          changedProps,
          origin: dc.origin as ChangeOrigin,
        });
      }

      // ── Widened capture — every node, not just components ──
      const removed = 'removed' in node && node.removed;
      const known = deps.identity.get(node.id);
      // A RemovedNode carries ONLY id + type — no name, no parent, no page — so a delete
      // reads from the identity cache; a node the session never saw degrades honestly to
      // null (the sentence layer says "Deleted a TEXT node" rather than inventing a name).
      const parentName = removed ? known?.parentName ?? null : enclosingName(node);
      const page = removed
        // A delete carries no parent chain at all, so the cache is the only record of where
        // the node lived; a node this session never saw degrades to the current page —
        // counted the same as the live-node substitution below, never silently.
        ? resolvedRemovedPage(known)
        // A live node resolves through its OWN chain, at any depth. Only a node with no page
        // in it (detached, or reparented out mid-batch) reaches a substitute: the last page
        // this session saw it on, else — as the final resort — the current page, which is a
        // guess and is counted as one rather than passed off as a resolved fact.
        : resolvedPage(node, known);
      deps.notePageDirty(page.id);
      // What the designer SAID, read HERE or never: `documentchange` names the property
      // (`description`, `annotations`) and never the value, and nothing recovers it later.
      // A removed node is skipped — a RemovedNode carries only id + type, so every read
      // would refuse and the frame would fill with refusals that say nothing. Gap-fill posts
      // its own batches and never reaches this pass, so a closed-window intent edit is
      // reported as a property change with no value rather than with a guessed one.
      let intent: EditIntent | undefined;
      if (!removed) {
        // Guarded like every other host read in this loop, not because `readEditIntent`
        // throws today (each getter sits in its own try, and a refusal comes back as
        // `intentReadError` ON the frame) but because an escaping throw here would take the
        // whole delivered batch with it — including the edits already processed.
        try {
          intent = readEditIntent(node as unknown as Record<string, unknown>, changedProps);
        } catch (error) {
          recordCaptureError(error);
        }
      }
      edits.push({
        op,
        nodeId: node.id,
        nodeName: removed ? known?.name ?? null : node.name,
        nodeType: node.type,
        parentName,
        page: page.name,
        changedProps,
        origin: dc.origin as EditOrigin,
        actor: classifyActor(node.id, op, now, deps.actorState()),
        ...(intent !== undefined && { intent }),
      });
      if (!removed) {
        deps.identity.remember(node.id, {
          name: node.name, type: node.type, parentName, page: page.name, pageId: page.id,
        });
      }
    }

    if (connectorTouched.length > 0) deps.noteChangedNodes(connectorTouched);

    const changes = coalesceChanges(raw);
    if (changes.length > 0) {
      deps.post({
        // fileName rides alongside fileKey — fileKey is null whenever the manifest lacks
        // enablePrivatePluginApi, so without a name the slug chain collapses every such
        // file to 'unknown' and keeps coalescing them.
        type: 'DOC_CHANGE',
        data: { changes, page: figma.currentPage.name, fileKey: figma.fileKey ?? null, fileName: figma.root.name },
      });
      deps.noteComponentChanges(changes.length);
    }

    if (edits.length > 0) {
      deps.post({
        type: 'EDIT_FEED',
        data: {
          edits: coalesceEdits(edits), fileKey: figma.fileKey ?? null,
          fileName: figma.root.name, source: 'live',
        },
      });
    }

    // Either kind of activity pushes the idle-commit prompt (and the gap-fill snapshot
    // refresh) further out — a session with ONLY widened (non-component) edits must still
    // debounce, not just a component-scoped one. A batch that was nothing but the plugin's
    // own bookkeeping reaches here with both lists empty and arms nothing.
    if (changes.length > 0 || edits.length > 0) deps.armIdle();

    // ONE store write for the whole batch — never one per changed node — and deliberately
    // LAST. Figma refuses a `sharedPluginData` write on a file the user cannot edit and
    // throws at its per-entry byte cap; the edits above are the design facts this feed
    // exists to carry, so they are already posted by the time a refusal can propagate.
    // Skipped outright when the batch's own reads already failed: there is nothing
    // trustworthy to write back, and the failure is already counted. A refusal HERE is
    // guarded the same way: this batch's corrections are lost (there is no scoped copy to
    // retry with — the next batch reads the document afresh), but the refusal itself is
    // counted rather than escaping the `documentchange` listener and taking the feed,
    // idle-arming, and the caller down with it.
    if (correctionsUsable) {
      try {
        deps.corrections.flush(correctionBatch);
      } catch (error) {
        recordCaptureError(error);
      }
    }
  }

  return { onDocumentChange, stats };
}
