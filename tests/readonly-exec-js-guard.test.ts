// Read-only EXEC_JS enforcement (issue #38) — the SAME wiring main.ts's `onmessage` uses
// (readonly-guard.ts's snapshot/record/violated trio), driven against REAL `opExecJs`
// runs instead of synthetic counters, so a genuinely mutating script and a genuinely
// read-only one are exercised end to end.
//
// main.ts itself cannot be imported here (it calls `figma.showUI` at module load — see
// shared/mutating-commands.ts's comment), so this test patches the mock's `createFrame`
// to invoke the documentchange callback the instant it mutates — modeling "Figma fires
// documentchange for a write" directly at the point of the write, rather than firing
// unconditionally after every script regardless of whether one happened (which would
// prove nothing about a genuinely read-only script). Figma's OWN internal batching/
// timing (whether the real host fires documentchange before this dispatch's `await`
// resolves) cannot be verified in this sandbox — that is a documented residual: this
// test proves the ATTRIBUTION LOGIC is correct once a batch arrives, not exactly when
// the real host delivers it.
import { describe, it, expect, beforeEach } from 'vitest';
import { installMockFigma } from './helpers/mock-figma.ts';
import { opExecJs } from '../plugin/src/main/executor-exec-js.ts';
import {
  createReadOnlyGuardState, isReadOnlyExecJs, recordDocumentChangeBatch,
  snapshotChangeEvents, violatedSinceSnapshot,
} from '../plugin/src/main/readonly-guard.ts';

/** Minimal `figma.commitUndo`/`triggerUndo` stand-ins the shared mock
 *  (tests/helpers/mock-figma.ts) does not model — that fixture is built for node-tree
 *  round-trips, not undo bookkeeping. Added directly here since only this feature needs
 *  them (none of these scripts pass `undoGroup: true`, so they are never actually
 *  called — present only so a future test that does pass it does not crash on a
 *  missing method). Then wraps `createFrame` to call `onMutate` at the exact point a
 *  mutation happens — the mock's stand-in for "Figma fires documentchange for this
 *  write", scoped to the one creator these tests' scripts use. */
function wireMutationSignal(onMutate: () => void): void {
  const figmaGlobal = globalThis as unknown as {
    figma: { commitUndo: () => void; triggerUndo: () => void; createFrame: () => unknown };
  };
  figmaGlobal.figma.commitUndo = () => { /* no undo-group script in these tests */ };
  figmaGlobal.figma.triggerUndo = () => { /* no undo-group script in these tests */ };
  const baseCreateFrame = figmaGlobal.figma.createFrame.bind(figmaGlobal.figma);
  figmaGlobal.figma.createFrame = () => {
    const node = baseCreateFrame();
    onMutate();
    return node;
  };
}

describe('read-only EXEC_JS guard — real opExecJs runs', () => {
  beforeEach(() => {
    installMockFigma();
  });

  it('test-first #1: a --read-only EXEC_JS that mutates (creates a node) is flagged', async () => {
    const state = createReadOnlyGuardState();
    // Solo dispatch (activeCount === 1 throughout) is main.ts's own contract for when a
    // batch is attributable — see readonly-guard.ts.
    wireMutationSignal(() => recordDocumentChangeBatch(state, 1));
    const enforceReadOnly = isReadOnlyExecJs('EXEC_JS', true);
    const snapshot = enforceReadOnly ? snapshotChangeEvents(state) : 0;

    await opExecJs({ code: 'figma.createFrame()' });

    expect(violatedSinceSnapshot(state, snapshot)).toBe(true);
  });

  it('test-first #3: a genuinely read-only exec-js under --read-only succeeds with no violation', async () => {
    const state = createReadOnlyGuardState();
    wireMutationSignal(() => recordDocumentChangeBatch(state, 1)); // never invoked below — nothing mutates
    const snapshot = snapshotChangeEvents(state);

    const result = await opExecJs({ code: 'figma.currentPage.name' });

    expect(result.result).toBe('Page 1'); // the read actually ran and returned a real value
    expect(violatedSinceSnapshot(state, snapshot)).toBe(false);
  });

  it('a script that throws before mutating is an eval error, never a false read-only violation', async () => {
    const state = createReadOnlyGuardState();
    wireMutationSignal(() => recordDocumentChangeBatch(state, 1));
    const snapshot = snapshotChangeEvents(state);

    await expect(opExecJs({ code: 'throw new Error("boom")' })).rejects.toThrow('boom');

    expect(violatedSinceSnapshot(state, snapshot)).toBe(false);
  });
});
