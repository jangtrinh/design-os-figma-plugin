// Read-only EXEC_JS enforcement — attribution for the one command whose
// target nodes are never known ahead of time. Pure over injected state, no `figma`, no
// clock read inside — same shape as edit-actor.ts, and for the same reason: main.ts
// cannot be imported outside a live plugin sandbox (it calls `figma.showUI` at module
// load), so the part worth trusting has to be testable without one.
//
// The six typed mutating commands declare their target ids BEFORE they run
// (`mutationTargetIds` → `beginAgentMutation`/`declaredIds`, main.ts), so a
// documentchange landing on one of those ids while its dispatch is in flight is
// unambiguously that dispatch's own write. EXEC_JS is an opaque script — it can mutate
// ANY node, so there is no id to pre-declare, and per-node declaration is not an option
// here (the same limit edit-actor.ts already documents for undeclared creates).
//
// What an EXEC_JS dispatch DOES have, like every other command, is `activeCount`
// (main.ts) — how many dispatches this plugin instance currently has in flight. When
// that count is exactly 1, the lone active dispatch IS whichever call is asking "did I
// just mutate?" — no other dispatch exists that could have caused it. A documentchange
// batch that lands while `activeCount === 1` is therefore attributable to the one
// dispatch that is, at that moment, the only possible agent-side cause.
//
// This is coarser than per-node declaration (a whole batch, not a node) and it goes
// deliberately narrow rather than deep: a genuinely concurrent SEPARATE dispatch
// (typed or another EXEC_JS) pushes `activeCount` to 2+ for as long as it runs, and any
// documentchange landing in that window is excluded here entirely — never attributed
// to EITHER dispatch. That is the residual gap this module accepts: two EXEC_JS calls
// racing at once (one of them a `--read-only` read, the other genuinely mutating)
// cannot be told apart by this signal, so neither is flagged for that overlap. A false
// NEGATIVE in that narrow, opaque-vs-opaque case is the deliberate trade for never
// producing a false POSITIVE that would refuse a legitimate read overlapping someone
// else's real, DECLARED mutation on other nodes — the load-bearing guarantee this
// module exists to hold (see readonly-guard.test.ts).
export interface ReadOnlyGuardState {
  /** Bumped once per documentchange batch that lands while exactly one dispatch is
   *  active — i.e. a change reliably attributable to that one dispatch. Never reset:
   *  only ever compared via a before/after snapshot, so it never needs pruning. */
  soleActorChangeEvents: number;
}

export function createReadOnlyGuardState(): ReadOnlyGuardState {
  return { soleActorChangeEvents: 0 };
}

/**
 * Call once per documentchange batch (main.ts's `onDocumentChange`, once per fired
 * event — not once per `event.documentChanges` entry: the question this answers is "did
 * a change land during my window", not which node changed).
 */
export function recordDocumentChangeBatch(state: ReadOnlyGuardState, activeCount: number): void {
  if (activeCount === 1) state.soleActorChangeEvents += 1;
}

/**
 * Snapshot to compare against once a dispatch completes. Call the moment a dispatch
 * becomes active (main.ts's `activeCount += 1`), before `await dispatch(...)` — so the
 * window covers this dispatch's entire run, including any change that lands the instant
 * it starts.
 */
export function snapshotChangeEvents(state: ReadOnlyGuardState): number {
  return state.soleActorChangeEvents;
}

/**
 * Whether a change attributable to the sole-active dispatch landed since `snapshot` was
 * taken. Call after `await dispatch(...)` resolves, before that dispatch's own
 * `activeCount -= 1` runs — the whole point is that THIS dispatch is still the "1"
 * being measured for every batch that could possibly belong to it.
 */
export function violatedSinceSnapshot(state: ReadOnlyGuardState, snapshot: number): boolean {
  return state.soleActorChangeEvents > snapshot;
}

/**
 * The one gate for this whole feature — EXEC_JS only, and only when the caller declared
 * `--read-only`. A typed mutating command is never expected here at all: the CLI already
 * refuses `--read-only` on every one of them (`refusesReadOnlyAssertion`,
 * cli/src/transport/broker-client.ts) before a request carrying both is ever sent — this
 * gate exists so main.ts's own enforcement stays scoped to EXEC_JS regardless, rather
 * than trusting that upstream refusal alone.
 */
export function isReadOnlyExecJs(cmd: string, readOnly: boolean | undefined): boolean {
  return cmd === 'EXEC_JS' && readOnly === true;
}
