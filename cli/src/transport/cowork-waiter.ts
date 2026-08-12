// Pure state machine behind `figma-agent cowork` — the broker holds one waiter per
// registered COWORK request, armed/re-armed by live owner edits, firing after
// `quietMs` of silence since the last owner edit, or expiring at the overall deadline.
// No sockets, no timers here (same shape as file-queue.ts/job-table.ts) — the daemon
// owns those; this module only decides WHEN a waiter should resolve.
import type { EditInput } from '../../../shared/edit-feed.ts';

export interface CoworkEditBatch {
  edits: readonly EditInput[];
  source: 'live' | 'gapfill';
}

export interface CoworkWaiterState {
  readonly quietMs: number;
  readonly deadline: number;
  edits: EditInput[];
  ambiguousCount: number;
  /** Epoch ms of the last OWNER-actor live edit, or null if none has arrived yet. */
  armedAt: number | null;
}

export function createWaiter(quietMs: number, deadline: number): CoworkWaiterState {
  return { quietMs, deadline, edits: [], ambiguousCount: 0, armedAt: null };
}

/**
 * Feed one EDIT_FEED batch into the waiter. Mutates and returns the SAME object.
 * Only LIVE, OWNER-actor edits arm/re-arm the quiet timer:
 * - `source: 'gapfill'` is a replay of edits made while the plugin was closed, never
 *   live typing — ignored outright, regardless of actor.
 * - `actor: 'agent'` edits never arm the timer — the exact class of bug issue #54 fixed
 *   (an agent's own writes must never look like the designer stopping to think).
 * - `actor: 'ambiguous'` edits are counted (never vanish silently) but do not arm
 *   either — a refusal to guess is not the same fact as a confirmed owner edit.
 */
export function onEdits(state: CoworkWaiterState, batch: CoworkEditBatch, now: number): CoworkWaiterState {
  if (batch.source !== 'live') return state;
  const ownerEdits = batch.edits.filter((e) => e.actor === 'owner');
  const ambiguousEdits = batch.edits.filter((e) => e.actor === 'ambiguous');
  state.ambiguousCount += ambiguousEdits.length;
  if (ownerEdits.length === 0) return state;
  state.edits.push(...ownerEdits);
  state.armedAt = now;
  return state;
}

export type WaiterTick = 'fire' | 'expire' | null;

/**
 * Called on every daemon tick to decide whether this waiter should resolve now.
 * - `'fire'`: the quiet window elapsed since the last owner edit (armed case), OR the
 *   overall deadline passed while at least one edit was already recorded — partial
 *   activity is reported, never silently discarded just because the designer kept
 *   going past the budget.
 * - `'expire'`: the overall deadline passed with ZERO edits recorded — a normal,
 *   honest answer (`cycles: 0`), never an error.
 * - `null`: keep waiting.
 */
export function tick(state: CoworkWaiterState, now: number): WaiterTick {
  if (state.armedAt !== null && now - state.armedAt >= state.quietMs) return 'fire';
  if (now >= state.deadline) return state.edits.length > 0 ? 'fire' : 'expire';
  return null;
}
