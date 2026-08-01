// Read-only EXEC_JS enforcement — attribution unit tests. Pure state, no
// `figma`: main.ts cannot be imported outside a live plugin sandbox (it calls
// `figma.showUI` at module load — see shared/mutating-commands.ts's own comment), so
// the load-bearing guarantee below is proven at the level that IS importable: the
// per-dispatch attribution logic readonly-guard.ts exports.
import { describe, it, expect } from 'vitest';
import {
  createReadOnlyGuardState, isReadOnlyExecJs, recordDocumentChangeBatch,
  snapshotChangeEvents, violatedSinceSnapshot,
} from '../plugin/src/main/readonly-guard.ts';

describe('readOnlyExecJsViolated — solo dispatch (test-first #1: a read-only EXEC_JS that mutates)', () => {
  it('a documentchange batch landing while activeCount === 1 (only this dispatch active) is a violation', () => {
    const state = createReadOnlyGuardState();
    const snapshot = snapshotChangeEvents(state); // taken before this dispatch's own `dispatch()` call
    // The dispatch is the ONLY thing running (activeCount === 1) and its own script
    // mutates the scene — Figma fires documentchange for that write.
    recordDocumentChangeBatch(state, 1);
    expect(violatedSinceSnapshot(state, snapshot)).toBe(true);
  });

  it('no documentchange at all (test-first #3: a genuinely read-only exec-js) — never flagged', () => {
    const state = createReadOnlyGuardState();
    const snapshot = snapshotChangeEvents(state);
    // Nothing fires: the script only read.
    expect(violatedSinceSnapshot(state, snapshot)).toBe(false);
  });
});

describe('readOnlyExecJsViolated — the concurrency false-positive case (test-first #2, LOAD-BEARING)', () => {
  it('a read-only read overlapping a SEPARATE legitimate mutation dispatch is NOT flagged', () => {
    const state = createReadOnlyGuardState();

    // Dispatch B (--read-only EXEC_JS) starts alone: activeCount 0 → 1.
    const bSnapshot = snapshotChangeEvents(state);

    // While B is still running, a SEPARATE typed mutating dispatch A arrives and starts:
    // activeCount 1 → 2. A mutates OTHER nodes — its own documentchange fires while
    // BOTH dispatches are active (activeCount === 2), so it is excluded from the
    // "solely attributable to one dispatch" count entirely.
    recordDocumentChangeBatch(state, 2);

    // A finishes: activeCount 2 → 1. B's own script never touched the scene (a genuine
    // read), so B's dispatch() now resolves with nothing further recorded.
    expect(violatedSinceSnapshot(state, bSnapshot)).toBe(false);
  });

  it('the same overlap, but THIS TIME the read-only dispatch itself also mutates — only IT is flagged', () => {
    const state = createReadOnlyGuardState();
    const bSnapshot = snapshotChangeEvents(state);

    // Same concurrent legitimate mutation as above (excluded, activeCount === 2).
    recordDocumentChangeBatch(state, 2);
    // A drains; now B is sole-active again (activeCount === 1) and B's OWN script
    // mutates — THIS is attributable to B alone.
    recordDocumentChangeBatch(state, 1);

    expect(violatedSinceSnapshot(state, bSnapshot)).toBe(true);
  });

  it('documented residual gap: two undeclared EXEC_JS dispatches racing (activeCount stays 2) cannot be told apart', () => {
    const state = createReadOnlyGuardState();
    const snapshot = snapshotChangeEvents(state);
    // Two EXEC_JS calls overlap the whole time (activeCount never drops to 1) — one of
    // them mutates. Neither dispatch's own window ever sees activeCount === 1, so this
    // module — by design — records nothing attributable to either. A false NEGATIVE,
    // never a false POSITIVE; see readonly-guard.ts's header for why that trade is
    // deliberate.
    recordDocumentChangeBatch(state, 2);
    expect(violatedSinceSnapshot(state, snapshot)).toBe(false);
  });
});

describe('isReadOnlyExecJs — scope gate (EXEC_JS only; never re-gates typed commands)', () => {
  it('true only for EXEC_JS with readOnly === true', () => {
    expect(isReadOnlyExecJs('EXEC_JS', true)).toBe(true);
  });

  it('false for EXEC_JS without readOnly', () => {
    expect(isReadOnlyExecJs('EXEC_JS', undefined)).toBe(false);
    expect(isReadOnlyExecJs('EXEC_JS', false)).toBe(false);
  });

  it('false for a typed mutating command even if readOnly were somehow true — never re-gated here', () => {
    expect(isReadOnlyExecJs('SET_TEXT', true)).toBe(false);
    expect(isReadOnlyExecJs('CREATE_FRAME', true)).toBe(false);
  });
});
