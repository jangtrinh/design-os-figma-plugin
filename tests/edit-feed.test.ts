// shared/edit-feed.ts — the owner-edit feed's own contract, independent of
// shared/figma-changes.ts's ChangeFrame (spec: "the widened feed cannot share the
// existing log file"). Round-trip, structural-guard, and forward-compatibility coverage.
import { describe, it, expect } from 'vitest';
import {
  EDIT_FEED_SCHEMA_VERSION, buildEditFrame, isValidEditFrame, isValidEditInput, coalesceEdits,
  type EditInput, type EditBatchMeta,
} from '../shared/edit-feed.ts';
import type { EditIntent } from '../shared/edit-intent.ts';

const baseInput = (over: Partial<EditInput> = {}): EditInput => ({
  op: 'updated',
  nodeId: 'node-1',
  nodeName: 'Hero card',
  nodeType: 'FRAME',
  parentName: 'Page frame',
  changedProps: ['x', 'y'],
  origin: 'LOCAL',
  page: 'Page 1',
  actor: 'owner',
  ...over,
});

const baseMeta = (over: Partial<EditBatchMeta> = {}): EditBatchMeta => ({
  fileKey: 'file-key-1',
  fileName: 'VSF - PCP',
  source: 'live',
  ...over,
});

describe('buildEditFrame', () => {
  it('round-trips every field of a well-formed input', () => {
    const frame = buildEditFrame(baseInput(), baseMeta(), 1_700_000_000_000);
    expect(frame).toEqual({
      v: EDIT_FEED_SCHEMA_VERSION,
      ts: 1_700_000_000_000,
      actor: 'owner',
      source: 'live',
      op: 'updated',
      nodeId: 'node-1',
      nodeName: 'Hero card',
      nodeType: 'FRAME',
      parentName: 'Page frame',
      changedProps: ['x', 'y'],
      origin: 'LOCAL',
      page: 'Page 1',
      fileKey: 'file-key-1',
      fileName: 'VSF - PCP',
    });
  });

  // Phase 02 fix — mirrors figma-changes.ts's ChangeFrame.fileName: needed so `--file
  // <name>` (phase 02 §1) can match a Figma-Free file (fileKey null) by its human name,
  // not just the feed's own on-disk slug.
  it('stamps fileName from the batch meta onto the frame', () => {
    const frame = buildEditFrame(baseInput(), baseMeta({ fileName: 'Platform - Design System' }), 1);
    expect(frame.fileName).toBe('Platform - Design System');
  });

  it('omits fileName entirely (not empty string) when the meta carries none', () => {
    const frame = buildEditFrame(baseInput(), baseMeta({ fileName: '' }), 1);
    expect(frame).not.toHaveProperty('fileName');
  });

  it('a delete carries null name/parent honestly rather than inventing one', () => {
    const frame = buildEditFrame(
      baseInput({ op: 'deleted', nodeName: null, parentName: null, changedProps: [] }),
      baseMeta(),
      1,
    );
    expect(frame.nodeName).toBeNull();
    expect(frame.parentName).toBeNull();
  });

  it('coerces a non-LOCAL/REMOTE origin to LOCAL and a non-array changedProps to []', () => {
    const frame = buildEditFrame(
      baseInput({ origin: 'garbage' as EditInput['origin'], changedProps: 'oops' as unknown as string[] }),
      baseMeta(),
      1,
    );
    expect(frame.origin).toBe('LOCAL');
    expect(frame.changedProps).toEqual([]);
  });

  it('stamps fileKey from the batch meta, not the input', () => {
    const frame = buildEditFrame(baseInput(), baseMeta({ fileKey: null }), 1);
    expect(frame.fileKey).toBeNull();
  });
});

describe('isValidEditInput', () => {
  it('accepts a well-formed input', () => {
    expect(isValidEditInput(baseInput())).toBe(true);
  });

  it('rejects a missing op', () => {
    const { op: _op, ...rest } = baseInput();
    expect(isValidEditInput(rest)).toBe(false);
  });

  it('rejects an invalid op', () => {
    expect(isValidEditInput(baseInput({ op: 'moved' as EditInput['op'] }))).toBe(false);
  });

  it('rejects a missing nodeId', () => {
    const { nodeId: _nodeId, ...rest } = baseInput();
    expect(isValidEditInput(rest)).toBe(false);
  });

  it('rejects an empty nodeId', () => {
    expect(isValidEditInput(baseInput({ nodeId: '' }))).toBe(false);
  });

  it('rejects a missing or invalid actor — this feed never guesses who made an edit', () => {
    const { actor: _actor, ...rest } = baseInput();
    expect(isValidEditInput(rest)).toBe(false);
    expect(isValidEditInput(baseInput({ actor: 'unknown' as EditInput['actor'] }))).toBe(false);
  });

  it('rejects null and non-objects', () => {
    expect(isValidEditInput(null)).toBe(false);
    expect(isValidEditInput('a string')).toBe(false);
    expect(isValidEditInput(42)).toBe(false);
  });

  // Post-review (Codex P1): every field is validated, not just op/nodeId/actor.
  it('rejects a nodeName that is neither a string nor null', () => {
    expect(isValidEditInput(baseInput({ nodeName: 42 as unknown as string }))).toBe(false);
  });

  it('rejects a non-string nodeType', () => {
    expect(isValidEditInput(baseInput({ nodeType: 42 as unknown as string }))).toBe(false);
  });

  it('rejects a parentName that is neither a string nor null', () => {
    expect(isValidEditInput(baseInput({ parentName: 42 as unknown as string }))).toBe(false);
  });

  it('rejects a non-array changedProps', () => {
    expect(isValidEditInput(baseInput({ changedProps: 'x' as unknown as string[] }))).toBe(false);
  });

  it('rejects changedProps with a non-string element', () => {
    expect(isValidEditInput(baseInput({ changedProps: ['x', 42 as unknown as string] }))).toBe(false);
  });

  it('rejects an origin that is not LOCAL or REMOTE', () => {
    expect(isValidEditInput(baseInput({ origin: 'garbage' as unknown as EditInput['origin'] }))).toBe(false);
  });

  it('rejects a non-string page', () => {
    expect(isValidEditInput(baseInput({ page: 42 as unknown as string }))).toBe(false);
  });

  it('accepts a null nodeName/parentName (the honest delete shape)', () => {
    expect(isValidEditInput(baseInput({ nodeName: null, parentName: null }))).toBe(true);
  });
});

describe('forward compatibility', () => {
  it('an unknown extra key on a frame survives JSON.parse/stringify untouched', () => {
    const frame = buildEditFrame(baseInput(), baseMeta(), 1);
    const withExtra = { ...frame, futureField: 'from-a-later-phase' };
    const roundTripped = JSON.parse(JSON.stringify(withExtra));
    expect(roundTripped.futureField).toBe('from-a-later-phase');
    expect(roundTripped.v).toBe(EDIT_FEED_SCHEMA_VERSION);
  });
});

describe('coalesceEdits', () => {
  it('coalesces multiple raw edits on the same node into one, per-node, per-batch', () => {
    const out = coalesceEdits([
      baseInput({ op: 'updated', changedProps: ['x'] }),
      baseInput({ op: 'updated', changedProps: ['y'] }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].changedProps).toEqual(['x', 'y']);
  });

  // Post-review (Codex P1): last op in the batch wins — the phase's own contract, NOT a
  // ranked precedence like figma-changes.ts's coalesceChanges. An update→delete settles
  // deleted (the node really is gone by batch end); a create→update settles updated (it
  // exists and was then edited); a delete→create settles created (it's back — reporting
  // it as "deleted" would misreport a node that was deleted then immediately recreated
  // as still gone).
  it('an update→delete batch settles as deleted', () => {
    const out = coalesceEdits([
      baseInput({ op: 'updated' }),
      baseInput({ op: 'deleted', nodeName: null, parentName: null }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].op).toBe('deleted');
  });

  it('a create→update batch settles as updated, not created', () => {
    const out = coalesceEdits([
      baseInput({ op: 'created' }),
      baseInput({ op: 'updated', changedProps: ['fills'] }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].op).toBe('updated');
  });

  it('a delete→create batch settles as created, not deleted', () => {
    const out = coalesceEdits([
      baseInput({ op: 'deleted', nodeName: null, parentName: null }),
      baseInput({ op: 'created' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].op).toBe('created');
  });

  it('the last op in a longer sequence wins, regardless of any rank', () => {
    const out = coalesceEdits([
      baseInput({ nodeId: 'a', op: 'created' }),
      baseInput({ nodeId: 'a', op: 'updated' }),
      baseInput({ nodeId: 'a', op: 'deleted', nodeName: null, parentName: null }),
      baseInput({ nodeId: 'b', op: 'deleted', nodeName: null, parentName: null }),
      baseInput({ nodeId: 'b', op: 'created' }),
      baseInput({ nodeId: 'b', op: 'updated', changedProps: ['x'] }),
    ]);
    const byId = new Map(out.map((e) => [e.nodeId, e]));
    expect(byId.get('a')?.op).toBe('deleted');
    expect(byId.get('b')?.op).toBe('updated');
  });

  it('keeps the first non-null nodeName/parentName seen for a node', () => {
    const out = coalesceEdits([
      baseInput({ op: 'deleted', nodeName: null, parentName: null }),
      baseInput({ op: 'updated', nodeName: 'Hero card', parentName: 'Page frame' }),
    ]);
    expect(out[0].nodeName).toBe('Hero card');
    expect(out[0].parentName).toBe('Page frame');
  });

  it('marks origin REMOTE if any contributing edit is remote', () => {
    const out = coalesceEdits([
      baseInput({ origin: 'LOCAL' }),
      baseInput({ origin: 'REMOTE' }),
    ]);
    expect(out[0].origin).toBe('REMOTE');
  });

  it('the last classification in the batch wins for actor', () => {
    const out = coalesceEdits([
      baseInput({ actor: 'ambiguous' }),
      baseInput({ actor: 'owner' }),
    ]);
    expect(out[0].actor).toBe('owner');
  });

  it('output is sorted by nodeId and is idempotent on already-coalesced input', () => {
    const raw = [baseInput({ nodeId: 'b' }), baseInput({ nodeId: 'a' })];
    const once = coalesceEdits(raw);
    expect(once.map((e) => e.nodeId)).toEqual(['a', 'b']);
    const twice = coalesceEdits(once);
    expect(twice).toEqual(once);
  });
});

// A frame the plugin held through an outage and replayed on reconnect is HISTORY. It
// lands in the feed dated to its capture, and it says so on the frame itself, so a
// reader can never mistake a recovered gap for something that just happened. Additive:
// EDIT_FEED_SCHEMA_VERSION stays 1 and a frame written before the marker existed still
// parses.
describe('buildEditFrame — a replayed capture is marked as one', () => {
  it('carries the marker when the batch was replayed', () => {
    const frame = buildEditFrame(baseInput(), baseMeta({ replayed: true }), 1_700_000_000_000);
    expect(frame.replayed).toBe(true);
    expect(frame.ts).toBe(1_700_000_000_000);
  });

  it('omits the marker entirely on a live batch — the ordinary frame is unchanged', () => {
    expect(buildEditFrame(baseInput(), baseMeta(), 1)).not.toHaveProperty('replayed');
    expect(buildEditFrame(baseInput(), baseMeta({ replayed: false }), 1)).not.toHaveProperty('replayed');
  });
});

describe('isValidEditFrame — the replay marker is additive, never required', () => {
  it('accepts a frame written before the marker existed', () => {
    expect(isValidEditFrame(buildEditFrame(baseInput(), baseMeta(), 1))).toBe(true);
  });

  it('accepts a marked replay', () => {
    expect(isValidEditFrame(buildEditFrame(baseInput(), baseMeta({ replayed: true }), 1))).toBe(true);
  });

  it('refuses a non-boolean marker rather than admitting a line it cannot read', () => {
    const frame = { ...buildEditFrame(baseInput(), baseMeta(), 1), replayed: 'yes' };
    expect(isValidEditFrame(frame)).toBe(false);
  });
});

// Designer intent (a component's description, a node's annotations) rides ALONGSIDE the
// property name the frame already lists. Two boundaries matter: a frame that carries no
// intent must stay byte-for-byte what it was before intent existed, and a frame that does
// carry one must survive the reader's guard.
describe('intent — additive, and byte-identical when absent', () => {
  it('an ordinary edit produces exactly the bytes it did before intent existed', () => {
    const frame = buildEditFrame(baseInput(), baseMeta(), 1_700_000_000_000);
    expect(JSON.stringify(frame)).toBe(
      '{"v":1,"ts":1700000000000,"actor":"owner","source":"live","op":"updated","nodeId":"node-1",'
      + '"nodeName":"Hero card","nodeType":"FRAME","parentName":"Page frame","changedProps":["x","y"],'
      + '"origin":"LOCAL","page":"Page 1","fileKey":"file-key-1","fileName":"VSF - PCP"}',
    );
    expect(frame).not.toHaveProperty('intent');
  });

  it('carries a well-formed intent onto the frame untouched', () => {
    const intent = { description: 'The primary action', annotations: [{ label: 'a11y' }] };
    const frame = buildEditFrame(baseInput({ changedProps: ['description'], intent }), baseMeta(), 1);
    expect(frame.intent).toEqual(intent);
    expect(isValidEditFrame(frame)).toBe(true);
  });

  it('a refused read reaches the reader as an error, with the property name still listed', () => {
    const input = baseInput({
      changedProps: ['description'],
      intent: { intentReadError: 'Cannot read description of a removed node' },
    });
    const frame = buildEditFrame(input, baseMeta(), 1);
    expect(frame.changedProps).toEqual(['description']);
    expect(frame.intent).toEqual({ intentReadError: 'Cannot read description of a removed node' });
  });

  it('drops a structurally invalid intent rather than passing it through to disk', () => {
    const frame = buildEditFrame(
      baseInput({ intent: { description: 7 } as unknown as EditIntent }), baseMeta(), 1,
    );
    expect(frame).not.toHaveProperty('intent');
  });

  // ONE policy on every side: the property name is the fact, the value is the extra. A
  // malformed intent costs the intent — never the edit it was attached to.
  it('the input guard admits the edit and lets the writer strip the intent', () => {
    expect(isValidEditInput(baseInput({ intent: { annotations: 'one' } as unknown as EditIntent }))).toBe(true);
    expect(isValidEditInput(baseInput({ intent: null as unknown as EditIntent }))).toBe(true);
    expect(isValidEditInput(baseInput({ intent: { description: 'ok' } }))).toBe(true);
    const frame = buildEditFrame(
      baseInput({ intent: { annotations: 'one' } as unknown as EditIntent }), baseMeta(), 1,
    );
    expect(frame).not.toHaveProperty('intent');
    expect(frame.changedProps).toEqual(['x', 'y']);
  });

  it('the frame guard admits a line whose intent is malformed — the reader strips it', () => {
    const frame = { ...buildEditFrame(baseInput(), baseMeta(), 1), intent: { description: 7 } };
    expect(isValidEditFrame(frame)).toBe(true);
  });

  it('a frame with no intent still passes the frame guard — every feed line predates it', () => {
    expect(isValidEditFrame(buildEditFrame(baseInput(), baseMeta(), 1))).toBe(true);
  });
});

describe('coalesceEdits — intent merges field by field, last value wins', () => {
  const withIntent = (intent: EditIntent, over: Partial<EditInput> = {}): EditInput =>
    baseInput({ changedProps: ['description'], intent, ...over });

  it('a later description replaces an earlier one for the same node', () => {
    const [out] = coalesceEdits([
      withIntent({ description: 'first' }),
      withIntent({ description: 'second' }),
    ]);
    expect(out!.intent).toEqual({ description: 'second' });
  });

  it('two different fields in one batch both survive on one frame', () => {
    const [out] = coalesceEdits([
      withIntent({ description: 'words' }),
      withIntent({ annotations: [{ label: 'a11y' }] }, { changedProps: ['annotations'] }),
    ]);
    expect(out!.intent).toEqual({ description: 'words', annotations: [{ label: 'a11y' }] });
    expect(out!.changedProps).toEqual(['annotations', 'description']);
  });

  it('an intent arriving LATE in the batch reaches a node that had none', () => {
    const [out] = coalesceEdits([
      baseInput({ changedProps: ['x'] }),
      withIntent({ description: 'words' }),
    ]);
    expect(out!.intent).toEqual({ description: 'words' });
  });

  it('an intent on the FIRST edit survives an ordinary later edit of the same node', () => {
    const [out] = coalesceEdits([
      withIntent({ description: 'words' }),
      baseInput({ changedProps: ['x'] }),
    ]);
    expect(out!.intent).toEqual({ description: 'words' });
  });

  it('a read refusal from earlier in the batch is never dropped by a later success', () => {
    const [out] = coalesceEdits([
      withIntent({ intentReadError: 'refused' }),
      withIntent({ annotations: [] }, { changedProps: ['annotations'] }),
    ]);
    expect(out!.intent).toEqual({ intentReadError: 'refused', annotations: [] });
  });

  it('a node with no intent anywhere in the batch gains no intent key', () => {
    const [out] = coalesceEdits([baseInput({ changedProps: ['x'] }), baseInput({ changedProps: ['y'] })]);
    expect(out).not.toHaveProperty('intent');
  });
});

// The caps are a property of the FEED, not of one producer. The plugin caps at capture, and
// the frame builder caps again at the boundary — a relay, a replay, or a future producer
// cannot widen them by writing straight to the broker.
describe('buildEditFrame — the caps hold at the write boundary', () => {
  it('caps an oversized intent from a producer that did not', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ label: `a${i}` }));
    const frame = buildEditFrame(
      baseInput({ changedProps: ['description', 'annotations'], intent: { description: 'x'.repeat(9_000), annotations: many } }),
      baseMeta(), 1,
    );
    expect(frame.intent!.description).toHaveLength(2_000);
    expect(frame.intent!.intentTruncated).toBe(true);
    expect(frame.intent!.annotations).toHaveLength(20);
    expect(frame.intent!.annotationsTotal).toBe(40);
  });

  it('leaves an already-capped intent exactly as it was (idempotent at the boundary)', () => {
    const intent: EditIntent = { description: 'The primary action', annotations: [{ label: 'a11y' }] };
    expect(buildEditFrame(baseInput({ intent }), baseMeta(), 1).intent).toEqual(intent);
  });

  it('drops a block whose count contradicts its own list, and keeps the edit', () => {
    const frame = buildEditFrame(
      baseInput({ changedProps: ['annotations'], intent: { annotations: [{ label: 'a' }], annotationsTotal: 1 } }),
      baseMeta(), 1,
    );
    expect(frame).not.toHaveProperty('intent');
    expect(frame.changedProps).toEqual(['annotations']);
  });
});
