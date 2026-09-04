// The quiet window for designer INTENT — the per-node table that turns "one frame per
// keystroke" back into two frames per typed description.
//
// Measured on the owner's file: typing "Page content of IDP Review queue" into a component
// description produced 17 `documentchange` batches in 5 s — each keystroke its OWN batch, so
// `coalesceEdits` (which never sees more than one) had nothing to merge.
//
// The fold is LEADING-EDGE, and that is not a detail: `cowork --wait` ends a cycle after a
// few seconds of owner silence and is armed only by a POSTED owner frame, so holding a
// whole typed description would make eight seconds of typing look like eight seconds of
// silence and end the cycle mid-sentence. So the FIRST intent-only edit for a node is
// posted immediately, on today's timing, and opens the window; every further keystroke
// folds into ONE held follow-up, out 1.5 s after the last of them with the final value and
// `coalescedFrames: N` counting all N keystrokes, the leading one included. A window that
// folded nothing posts nothing. Only an edit whose `changedProps` are NOTHING BUT intent
// props (INTENT_PROPS), on a node that is still there, ever folds.
//
// Pure except for the injected timer: no figma API, no DOM, no network. The capture pass
// (document-change-capture.ts) decides WHAT is intent-only and owns the posting; this
// module owns the slots, the counters, the window and the flush order.

import { INTENT_PROPS, mergeIntent } from '../../../shared/edit-intent';
import type { EditInput } from '../../../shared/edit-feed';
import type { ComponentChange } from '../../../shared/figma-changes';

/** How long the designer must be quiet before a held follow-up goes out — longer than the
 *  ~300 ms between keystroke batches the live capture showed, short enough that an agent
 *  asking "what just changed" is not left waiting. */
export const INTENT_QUIET_WINDOW_MS = 1_500;

/** How many windows may be open at once — a bound on memory AND on live timers; reaching it
 *  closes the oldest, flushing its follow-up if it has one. 64 is far past any real session,
 *  so the bound makes a runaway impossible rather than shaping normal behaviour. */
export const MAX_PARKED_INTENT_NODES = 64;

/** Is this change nothing BUT designer intent? An empty list is not (a CREATE or DELETE
 *  names no properties); nor is `description` AND `x` — the move is a fact of its own. */
export function isIntentOnlyProps(changedProps: readonly string[]): boolean {
  return changedProps.length > 0 && changedProps.every((p) => INTENT_PROPS.includes(p));
}

/** One window's accumulated frame. POSTED only once `frames >= 2`; at 1 it is the leading
 *  edit, which the caller already posted itself. */
export interface ParkedIntentFrame {
  edit: EditInput;
  /** The DOC_CHANGE twin when the node is (or is inside) a component: `figma.changes.jsonl`
   *  is flooded by the same batches, so it rides the SAME slot. */
  change: ComponentChange | null;
  /** The LAST keystroke's page — the fallback for the re-read below. */
  page: string;

  /** The page AT FLUSH, read from the node itself; `null` when the node is gone, detached
   *  or refuses. Built by the capture pass (this module holds no figma reference); the
   *  caller prefers its answer and falls back to `page`. */
  resolvePageAtFlush: () => string | null;
  /** Capture frames this window stands for, the leading one included. */
  frames: number;
  /** The LAST keystroke's time, posted as the batch's `capturedAt` so the broker dates the
   *  frame when it was typed: dated at the flush it would sort after later edits. */
  capturedAt: number;
}

/** The two session counters this table owns, both on STATUS (`opStatus`): neither the fold
 *  nor a frame still being held is allowed to be invisible. */
export interface IntentParkingStats {
  /** Follow-ups held RIGHT NOW — a gauge, counting only windows that hold something. The
   *  plugin has no usable close hook (main.ts): a panel closed inside the window loses that
   *  many final values. */
  intentFramesParked: number;
  /** Capture frames folded away this session, cumulative: 17 keystrokes fold 16. */
  intentFramesCoalesced: number;
}

export interface IntentFrameParkingDeps {
  /** Arm a one-shot timer, returning its canceller. Injected because a test needs a fake
   *  clock, and a canceller keeps the host's timer handle type out of this module. */
  setTimer: (fn: () => void, ms: number) => () => void;
  /** Post one held follow-up — from the window's fire, an eviction, or a `release`. */
  flush: (frame: ParkedIntentFrame) => void;
  stats: IntentParkingStats;
}

export interface FoldInput {
  edit: EditInput;
  change: ComponentChange | null;
  page: string;
  resolvePageAtFlush: () => string | null;
  /** This keystroke's time — the window's deadline, and the frame's `capturedAt`. */
  at: number;
}

export interface IntentFrameParking {
  /** Offer one intent-only edit to the window. TRUE when it folded into a held follow-up
   *  (the caller must not post it); FALSE when it is a new window's leading edge (the
   *  caller posts it now, exactly as it did before this module existed). */
  fold: (input: FoldInput) => boolean;
  /** Close this node's window, flushing a held follow-up if there is one — called BEFORE
   *  the caller posts a non-intent edit or a delete for it, so order is preserved. */
  release: (nodeId: string) => void;
}

export function createIntentFrameParking(deps: IntentFrameParkingDeps): IntentFrameParking {
  interface Slot { frame: ParkedIntentFrame; firstAt: number; cancel: () => void }
  const slots = new Map<string, Slot>();
  /** Take the slot out of the table (timer cancelled, gauge down) and post what it holds.
   *  The ONLY exit, so a held follow-up can only leave by being posted; an empty window
   *  just closes. */
  function closeSlot(nodeId: string, slot: Slot): void {
    slots.delete(nodeId);
    slot.cancel();
    if (slot.frame.frames < 2) return; // only the leading edit, already posted by the caller
    deps.stats.intentFramesParked -= 1;
    deps.flush(slot.frame);
  }

  function release(nodeId: string): void {
    if (slots.size === 0) return; // the hot path (a drag batch) pays one size check
    const slot = slots.get(nodeId);
    if (slot !== undefined) closeSlot(nodeId, slot);
  }

  /** Close the oldest window, by the arrival of its LEADING keystroke. */
  function evictOldest(): void {
    let oldestId: string | null = null;
    let oldestAt = Infinity;
    for (const [id, slot] of slots) {
      if (slot.firstAt < oldestAt) { oldestAt = slot.firstAt; oldestId = id; }
    }
    if (oldestId === null) return;
    closeSlot(oldestId, slots.get(oldestId)!);
  }

  function arm(nodeId: string, frame: ParkedIntentFrame, firstAt: number): void {
    slots.set(nodeId, {
      frame,
      firstAt,
      cancel: deps.setTimer(() => {
        // The window fired. Read the slot back out of the table rather than closing over
        // this one: a `release` or an eviction may already have posted it, and the same
        // frame twice is a duplicate fact, not a recovered one. A canceller that did not
        // actually stop the host timer lands here too, and is stopped by this.
        const current = slots.get(nodeId);
        if (current !== undefined) closeSlot(nodeId, current);
      }, INTENT_QUIET_WINDOW_MS),
    });
  }

  /** The deduped, sorted list `coalesceEdits`/`coalesceChanges` would have produced — held
   *  frames skip those. It also gives the slot its OWN array: the pass shares one
   *  `changedProps` between an edit and its twin, and that must not be held for 1.5 s. */
  const normalise = (props: readonly string[]): string[] => [...new Set(props)].sort();

  function fold({ edit, change, page, resolvePageAtFlush, at }: FoldInput): boolean {
    const slot = slots.get(edit.nodeId);
    if (slot === undefined) {
      if (slots.size >= MAX_PARKED_INTENT_NODES) evictOldest();
      const changedProps = normalise(edit.changedProps);
      arm(edit.nodeId, {
        edit: { ...edit, changedProps },
        change: change === null ? null : { ...change, changedProps },
        page,
        resolvePageAtFlush,
        frames: 1,
        capturedAt: at,
      }, at);
      return false; // the leading edge: the caller posts it now, on today's timing
    }

    // Folding: the LATER value wins field by field (`mergeIntent`, the rule `coalesceEdits`
    // applies within one batch), and the property names UNION across the WHOLE window, the
    // leading keystroke included — the follow-up stands for all of them (that is what its
    // count says), so naming only the last would under-report it.
    const prev = slot.frame;
    slot.cancel(); // the window runs from the LAST keystroke, not the first
    const changedProps = normalise([...prev.edit.changedProps, ...edit.changedProps]);
    const merged: EditInput = {
      ...edit,
      changedProps,
      ...(prev.edit.intent !== undefined || edit.intent !== undefined
        ? { intent: mergeIntent(prev.edit.intent, edit.intent ?? {}) }
        : {}),
    };
    // The component-scoped twin follows the edit: a later batch that resolved an identity
    // the first one did not (or vice versa) keeps whichever exists, with the same unioned
    // property names, so the two feeds never disagree about the fold.
    const twin = change ?? prev.change;
    if (prev.frames === 1) deps.stats.intentFramesParked += 1; // this window now holds a frame
    deps.stats.intentFramesCoalesced += 1; // one more capture frame folded, counted as it happens
    arm(edit.nodeId, {
      edit: merged,
      change: twin === null ? null : { ...twin, changedProps },
      page,                 // the LAST keystroke's page
      resolvePageAtFlush,   // …and the newest way to re-read it
      frames: prev.frames + 1,
      capturedAt: at,
    }, slot.firstAt);
    return true;
  }

  return { fold, release };
}
