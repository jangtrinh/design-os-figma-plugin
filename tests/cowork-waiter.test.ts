// Pure state machine for `figma-agent cowork`'s broker-side waiter — no sockets, no
// timers, an injected `now` throughout. `createWaiter`/`onEdits`/`tick` are the whole
// contract; the daemon owns actually calling `tick()` on an interval and actually
// sending frames.
import { describe, expect, it } from 'vitest';
import { createWaiter, onEdits, tick, type CoworkEditBatch } from '../cli/src/transport/cowork-waiter.ts';
import type { EditInput } from '../shared/edit-feed.ts';
import { createDocumentChangeCapture } from '../plugin/src/main/document-change-capture.ts';
import { createEditIdentityCache } from '../plugin/src/main/change-node-identity.ts';

function ownerEdit(nodeId: string): EditInput {
  return {
    op: 'updated', nodeId, nodeName: `Node ${nodeId}`, nodeType: 'FRAME',
    parentName: null, changedProps: ['fills'], origin: 'LOCAL', page: 'Page 1', actor: 'owner',
  };
}
function agentEdit(nodeId: string): EditInput {
  return { ...ownerEdit(nodeId), actor: 'agent' };
}
function ambiguousEdit(nodeId: string): EditInput {
  return { ...ownerEdit(nodeId), actor: 'ambiguous' };
}
function liveBatch(edits: EditInput[]): CoworkEditBatch {
  return { edits, source: 'live' };
}
function gapfillBatch(edits: EditInput[]): CoworkEditBatch {
  return { edits, source: 'gapfill' };
}

describe('createWaiter / onEdits — arming', () => {
  it('a live owner-actor batch arms the quiet timer', () => {
    const w = createWaiter(3_000, 100_000);
    onEdits(w, liveBatch([ownerEdit('1:1')]), 1_000);
    expect(w.armedAt).toBe(1_000);
    expect(w.edits).toHaveLength(1);
  });

  it('a SECOND owner batch RE-arms (resets the quiet clock)', () => {
    const w = createWaiter(3_000, 100_000);
    onEdits(w, liveBatch([ownerEdit('1:1')]), 1_000);
    onEdits(w, liveBatch([ownerEdit('1:2')]), 2_500);
    expect(w.armedAt).toBe(2_500);
    expect(w.edits).toHaveLength(2);
  });

  it('an agent-only batch never arms — the agent must never trigger its own cycle', () => {
    const w = createWaiter(3_000, 100_000);
    onEdits(w, liveBatch([agentEdit('1:1')]), 1_000);
    expect(w.armedAt).toBeNull();
    expect(w.edits).toHaveLength(0);
  });

  it('an ambiguous-only batch never arms, but IS counted (nothing vanishes silently)', () => {
    const w = createWaiter(3_000, 100_000);
    onEdits(w, liveBatch([ambiguousEdit('1:1')]), 1_000);
    expect(w.armedAt).toBeNull();
    expect(w.ambiguousCount).toBe(1);
  });

  it('a mixed batch (owner + agent + ambiguous) arms on the owner edit ONLY — agent/ambiguous edits are not recorded as the cycle payload', () => {
    const w = createWaiter(3_000, 100_000);
    onEdits(w, liveBatch([ownerEdit('1:1'), agentEdit('1:2'), ambiguousEdit('1:3')]), 1_000);
    expect(w.armedAt).toBe(1_000);
    expect(w.edits).toHaveLength(1);
    expect(w.edits[0].nodeId).toBe('1:1');
    expect(w.ambiguousCount).toBe(1);
  });

  it('a gapfill batch never arms, even with owner-actor edits — a replay of edits made while the plugin was closed is not live typing', () => {
    const w = createWaiter(3_000, 100_000);
    onEdits(w, gapfillBatch([ownerEdit('1:1')]), 1_000);
    expect(w.armedAt).toBeNull();
    expect(w.edits).toHaveLength(0);
  });
});

describe('tick — fire / expire / keep-waiting', () => {
  it('never armed, before the deadline → null (keep waiting)', () => {
    const w = createWaiter(3_000, 100_000);
    expect(tick(w, 50_000)).toBeNull();
  });

  it('armed, quiet window not yet elapsed → null', () => {
    const w = createWaiter(3_000, 100_000);
    onEdits(w, liveBatch([ownerEdit('1:1')]), 1_000);
    expect(tick(w, 3_500)).toBeNull(); // only 2.5s of quiet so far
  });

  it('armed, quiet window elapsed with >=1 edit recorded → fire', () => {
    const w = createWaiter(3_000, 100_000);
    onEdits(w, liveBatch([ownerEdit('1:1')]), 1_000);
    expect(tick(w, 4_000)).toBe('fire'); // exactly 3s of quiet
  });

  it('a re-arm pushes the fire point out — ticking at the OLD fire time no longer fires', () => {
    const w = createWaiter(3_000, 100_000);
    onEdits(w, liveBatch([ownerEdit('1:1')]), 1_000);
    onEdits(w, liveBatch([ownerEdit('1:2')]), 3_000); // re-armed before the first would have fired
    expect(tick(w, 4_000)).toBeNull(); // only 1s quiet since the re-arm
    expect(tick(w, 6_000)).toBe('fire'); // 3s quiet since the re-arm
  });

  it('never armed, deadline passed, ZERO edits recorded → expire (exit 0, not an error)', () => {
    const w = createWaiter(3_000, 10_000);
    expect(tick(w, 10_000)).toBe('expire');
  });

  it('armed but deadline reached before the quiet window elapsed, WITH edits recorded → fire (partial activity still reported, never silently discarded)', () => {
    const w = createWaiter(3_000, 10_000);
    onEdits(w, liveBatch([ownerEdit('1:1')]), 9_000); // armed 1s before the deadline
    expect(tick(w, 10_000)).toBe('fire'); // deadline hit, but there IS something to report
  });

  it('ambiguous-only traffic the whole budget still expires — ambiguous edits never substitute for a real owner cycle', () => {
    const w = createWaiter(3_000, 10_000);
    onEdits(w, liveBatch([ambiguousEdit('1:1')]), 5_000);
    expect(tick(w, 10_000)).toBe('expire');
    expect(w.ambiguousCount).toBe(1); // still on the record, just not a fired cycle
  });
});

// The reason the intent quiet window folds on the LEADING edge rather than the trailing
// one. `cowork --wait` declares a cycle complete after 3 s of owner silence, and only a
// POSTED owner frame arms it: if the whole of a typed description were held back, eight
// seconds of typing would look like eight seconds of silence and the cycle would be
// declared finished mid-sentence — the exact collision cowork exists to prevent. This
// drives the real capture pass and feeds what it actually posts into the real waiter.
describe('a typed description arms the waiter on the FIRST keystroke', () => {
  const COMPONENT = {
    id: 'c1', name: 'Button / Primary', type: 'COMPONENT', description: '',
    parent: { id: 'f1', name: 'Card', type: 'FRAME', parent: { id: 'p1', name: 'Page 1', type: 'PAGE', parent: null } },
  };

  function typingHarness() {
    (globalThis as never as { figma: unknown }).figma = {
      fileKey: 'k', currentPage: { id: 'p1', name: 'Page 1' }, root: { name: 'Test File' },
    };
    let now = 1_000;
    const timers: Array<{ at: number; fn: () => void }> = [];
    const posted: Array<{ type: string; data: CoworkEditBatch }> = [];
    const capture = createDocumentChangeCapture<null>({
      now: () => now,
      setTimer: (fn, ms) => {
        const entry = { at: now + ms, fn };
        timers.push(entry);
        return () => { const i = timers.indexOf(entry); if (i >= 0) timers.splice(i, 1); };
      },
      onBatchStart: () => {},
      actorState: () => ({ activeCount: 0, lastDrainAt: 0, declared: new Map(), lastAgentAt: new Map() }),
      identity: createEditIdentityCache(),
      corrections: { begin: () => null, record: () => {}, flush: () => {} },
      noteChangedNodes: () => {},
      post: (m) => { if (m.type === 'EDIT_FEED') posted.push(m as never); },
      noteComponentChanges: () => {},
      notePageDirty: () => {},
      armIdle: () => {},
    });
    return {
      posted,
      at: () => now,
      type(words: string): void {
        COMPONENT.description = words;
        capture.onDocumentChange({ documentChanges: [{ type: 'PROPERTY_CHANGE', node: COMPONENT, properties: ['description'], origin: 'LOCAL' }] } as never);
      },
      advance(ms: number): void {
        now += ms;
        for (const t of [...timers].filter((x) => x.at <= now)) {
          const i = timers.indexOf(t);
          if (i >= 0) { timers.splice(i, 1); t.fn(); }
        }
      },
    };
  }

  it('the waiter is armed at the first keystroke, and stays armed through the typing', () => {
    const h = typingHarness();
    const w = createWaiter(3_000, 1_000_000);

    h.type('P');
    const firstKeystrokeAt = h.at();
    for (const m of h.posted.splice(0)) onEdits(w, m.data, h.at());

    expect(w.armedAt).toBe(firstKeystrokeAt); // NOT 1.5 s later, and not never
    expect(tick(w, firstKeystrokeAt + 2_999)).toBeNull();

    // Eight more seconds of typing. Nothing else posts until the window closes, so the
    // waiter must not have been left un-armed by the leading edge.
    for (const words of ['Pa', 'Pag', 'Page', 'Page ', 'Page c']) {
      h.advance(300);
      h.type(words);
      for (const m of h.posted.splice(0)) onEdits(w, m.data, h.at());
    }
    h.advance(1_500);
    for (const m of h.posted.splice(0)) onEdits(w, m.data, h.at());

    // The folded follow-up re-armed it at the flush, and it carries the finished sentence.
    expect(w.armedAt).toBe(h.at());
    expect(w.edits.at(-1)?.intent).toEqual({ description: 'Page c' });
  });
});
