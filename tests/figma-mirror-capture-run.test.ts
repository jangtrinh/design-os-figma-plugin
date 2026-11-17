// spec 005 P4 — the capture pass that feeds `ui figma reconcile --apply --mirror-file`.
//
// Only the PURE seams are unit-testable here: which components a delta asks us to scan,
// and how a scan-node child's stdout is read. Spawning the real child needs a live broker
// + an open Figma file — that is the P5 owner-in-the-loop gate, not a unit test.
import { describe, it, expect } from 'vitest';
import {
  captureMirror,
  mergeTargetsPendingFirst,
  MIRROR_SCAN_CHILD_BOUNDS,
  parseScan,
  pendingTargetsFromEnvelope,
  scanNode,
  splitAtScanCap,
  targetsFromDelta,
} from '../cli/src/transport/figma-mirror-capture-run.ts';
import type { ChildBounds, ChildOutcome } from '../cli/src/transport/bounded-child-process.ts';

describe('targetsFromDelta', () => {
  it('takes ADD + EDIT, never DELETE (a deleted node has nothing to scan)', () => {
    const targets = targetsFromDelta({
      delta: {
        added: [{ name: 'Card/Compact', nodeId: '2:9' }],
        updated: [{ name: 'Button/Primary', nodeId: '1:1' }],
        deprecated: [{ name: 'Old/Thing', nodeId: '9:9' }],
      },
    });
    expect(targets).toEqual([
      { nodeId: '2:9', name: 'Card/Compact' },
      { nodeId: '1:1', name: 'Button/Primary' },
    ]);
  });

  it('drops entries with no usable identity rather than scanning a guess', () => {
    const targets = targetsFromDelta({
      delta: { added: [{ name: '', nodeId: '1:1' }, { nodeId: '2:2' }, { name: 'A/B' }, 'junk'], updated: [] },
    });
    expect(targets).toEqual([]);
  });

  it('survives an envelope with no delta at all', () => {
    expect(targetsFromDelta(null)).toEqual([]);
    expect(targetsFromDelta({})).toEqual([]);
    expect(targetsFromDelta({ delta: { added: 'nope' } })).toEqual([]);
  });
});

describe('captureMirror', () => {
  it('no targets → no capture file (apply then runs mirror-less)', async () => {
    await expect(captureMirror([])).resolves.toEqual({ captured: 0, failed: 0, dropped: 0, droppedTargets: [] });
  });
});

describe('splitAtScanCap — the MAX_SCANS boundary (registry-integrity phase 02 §3)', () => {
  it('45 targets, cap 40: 40 scanned, 5 dropped BY NAME (not just a count)', () => {
    const targets = Array.from({ length: 45 }, (_, i) => ({ nodeId: `n${i}`, name: `Comp/${i}` }));
    const { scanned, dropped } = splitAtScanCap(targets);
    expect(scanned).toHaveLength(40);
    expect(dropped).toHaveLength(5);
    expect(dropped).toEqual(targets.slice(40));
    expect(dropped[0]).toEqual({ nodeId: 'n40', name: 'Comp/40' });
  });

  it('at or under the cap: nothing is dropped', () => {
    const targets = Array.from({ length: 40 }, (_, i) => ({ nodeId: `n${i}`, name: `Comp/${i}` }));
    expect(splitAtScanCap(targets).dropped).toEqual([]);
    expect(splitAtScanCap([]).dropped).toEqual([]);
  });
});

describe('pendingTargetsFromEnvelope — the kernel retry queue (registry-integrity phase 02 §4)', () => {
  it('reads nodeId+name off the dry-run envelope\'s `pending` array', () => {
    const targets = pendingTargetsFromEnvelope({
      pending: [
        { nodeId: 'n40', name: 'Comp/A', firstFrameIndex: 40, attempts: 1, lastReason: 'dropped', firstSeenTs: 1 },
        { nodeId: 'n41', name: 'Comp/B', firstFrameIndex: 41, attempts: 2, lastReason: 'scan failed', firstSeenTs: 1, skipped: true },
      ],
    });
    expect(targets).toEqual([{ nodeId: 'n40', name: 'Comp/A' }, { nodeId: 'n41', name: 'Comp/B' }]);
  });

  it('survives an envelope with no pending field at all (older kernel, or a clean queue)', () => {
    expect(pendingTargetsFromEnvelope(null)).toEqual([]);
    expect(pendingTargetsFromEnvelope({})).toEqual([]);
    expect(pendingTargetsFromEnvelope({ pending: 'nope' })).toEqual([]);
  });

  it('drops a malformed entry rather than scanning a guess', () => {
    expect(pendingTargetsFromEnvelope({ pending: [{ nodeId: 'n1' }, { name: 'A/B' }, 'junk'] })).toEqual([]);
  });

  // Fix round, finding 1: without this, the same first MAX_SCANS names win every run —
  // a chronically-failing target must rotate BEHIND one that has never had a turn.
  it('sorts least-recently-attempted first — a never-attempted target (no lastAttemptedAt) comes before one just attempted', () => {
    const targets = pendingTargetsFromEnvelope({
      pending: [
        { nodeId: 'stale', name: 'Comp/Stale', lastAttemptedAt: 5_000 },
        { nodeId: 'fresh', name: 'Comp/Fresh' }, // never attempted
        { nodeId: 'older', name: 'Comp/Older', lastAttemptedAt: 1_000 },
      ],
    });
    expect(targets.map((t) => t.nodeId)).toEqual(['fresh', 'older', 'stale']);
  });
});

describe('mergeTargetsPendingFirst — the queue must not starve (registry-integrity phase 02 §4)', () => {
  it('puts pending targets BEFORE fresh ones, so they win a MAX_SCANS slot', () => {
    const pending = [{ nodeId: 'n40', name: 'Comp/A' }, { nodeId: 'n41', name: 'Comp/B' }];
    const fresh = [{ nodeId: 'n0', name: 'Comp/New1' }, { nodeId: 'n1', name: 'Comp/New2' }];
    expect(mergeTargetsPendingFirst(pending, fresh)).toEqual([...pending, ...fresh]);
  });

  it('de-duplicates by nodeId — a target queued AND rediscovered is scanned once, from its queued slot', () => {
    const pending = [{ nodeId: 'n40', name: 'Comp/A' }];
    const fresh = [{ nodeId: 'n40', name: 'Comp/A' }, { nodeId: 'n0', name: 'Comp/New' }];
    expect(mergeTargetsPendingFirst(pending, fresh)).toEqual([
      { nodeId: 'n40', name: 'Comp/A' },
      { nodeId: 'n0', name: 'Comp/New' },
    ]);
  });

  it('45 total, cap 40: pending-first means the SAME 5 from run 1 are exactly what run 2 scans first', () => {
    // Simulates the two-run drain scenario end to end at the pure-function level (the
    // live capture itself needs a broker — see this file's header).
    const allFresh = Array.from({ length: 45 }, (_, i) => ({ nodeId: `n${i}`, name: `Comp/${i}` }));
    const run1 = splitAtScanCap(mergeTargetsPendingFirst([], allFresh));
    expect(run1.scanned).toHaveLength(40);
    expect(run1.dropped).toHaveLength(5); // n40..n44 queued

    // run 2: the 5 dropped are now the kernel's `pending` — merged ahead of any (here: no)
    // newly-discovered targets, so they are the FIRST (and only) 5 scanned, never starved.
    const run2 = splitAtScanCap(mergeTargetsPendingFirst(run1.dropped, []));
    expect(run2.scanned).toEqual(run1.dropped);
    expect(run2.dropped).toEqual([]);
  });

  // Fix round, finding 1: "45 pending, first 40 fail twice → 41-45 get attempted on run 2."
  it('45 pending, first 40 chronically failing: the 5 never-attempted ones are GUARANTEED a scan slot, never starved', () => {
    const now = Date.now();
    // The kernel's own envelope shape: the first 40 were JUST attempted (failed) twice —
    // stamped with a recent lastAttemptedAt. The last 5 have NEVER been attempted because
    // they were always past the MAX_SCANS cap in every prior run (the starvation bug).
    const chronicallyFailing = Array.from({ length: 40 }, (_, i) => (
      { nodeId: `n${i}`, name: `Comp/${i}`, lastAttemptedAt: now }
    ));
    const neverAttempted = Array.from({ length: 5 }, (_, i) => ({ nodeId: `m${i}`, name: `New/${i}` }));
    const ordered = pendingTargetsFromEnvelope({ pending: [...chronicallyFailing, ...neverAttempted] });

    const { scanned, dropped } = splitAtScanCap(mergeTargetsPendingFirst(ordered, []));
    expect(scanned).toHaveLength(40);
    expect(dropped).toHaveLength(5);
    // Every never-attempted target is in THIS run's scan batch — not starved behind the
    // chronically-failing 40.
    for (const t of neverAttempted) expect(scanned.some((s) => s.nodeId === t.nodeId)).toBe(true);
    // The 5 rotated out this run are from the chronically-failing set, never the fresh ones.
    for (const d of dropped) expect(chronicallyFailing.some((f) => f.nodeId === d.nodeId)).toBe(true);
  });
});

describe('scanNode bounds and honest reporting', () => {
  const dummyBounds: ChildBounds = {
    stdoutBytes: 1024,
    stderrBytes: 512,
    deadlineMs: 1000,
    termGraceMs: 100,
    closeGraceMs: 50,
    reapGraceMs: 200,
  };

  function mockRunner(outcome: Partial<ChildOutcome>) {
    return (
      _command: string,
      _args: readonly string[],
      _options: { bounds?: Readonly<ChildBounds> },
      done: (res: ChildOutcome) => void,
    ) => {
      done({
        spawned: true,
        exited: true,
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: '',
        stdoutBytes: 0,
        stdoutTruncated: false,
        stderr: '',
        stderrBytes: 0,
        stderrRetainedBytes: 0,
        stderrTruncated: false,
        ...outcome,
      });
      return {
        pid: 12345,
        terminate: () => true,
      };
    };
  }

  it('exports default mirror scan child bounds', () => {
    expect(MIRROR_SCAN_CHILD_BOUNDS).toEqual({
      stdoutBytes: 4 * 1024 * 1024,
      stderrBytes: 256 * 1024,
      deadlineMs: 35_000,
      termGraceMs: 2_000,
      closeGraceMs: 1_000,
      reapGraceMs: 3_000,
    });
  });

  it('handles clean scan output', async () => {
    const runner = mockRunner({
      stdout: JSON.stringify({ result: { id: '1:1', type: 'FRAME' } }),
    });
    const res = await scanNode('1:1', 'TestFile', dummyBounds, runner);
    expect(res).toEqual({ node: { id: '1:1', type: 'FRAME' } });
  });

  it('reports launch failure honestly when process is not spawned', async () => {
    const runner = mockRunner({
      spawned: false,
      launchError: 'ENOENT ui command missing',
      launchErrorKind: 'error',
    });
    const res = await scanNode('1:1', undefined, dummyBounds, runner);
    expect(res).toEqual({ reason: 'cannot launch scan-node: ENOENT ui command missing' });
  });

  it('reports timeout honestly with configured deadlineMs', async () => {
    const runner = mockRunner({
      timedOut: true,
    });
    const res = await scanNode('1:1', undefined, dummyBounds, runner);
    expect(res).toEqual({ reason: 'scan-node timed out after 1000ms' });
  });

  it('reports stdout truncation overflow honestly with configured stdoutBytes', async () => {
    const runner = mockRunner({
      stdoutTruncated: true,
      stdout: '{"result":',
    });
    const res = await scanNode('1:1', undefined, dummyBounds, runner);
    expect(res).toEqual({ reason: 'scan-node stdout exceeded bounded limit (1024 bytes)' });
  });

  it('reports unconfirmed child exit honestly when process refuses kill', async () => {
    const runner = mockRunner({
      exited: false,
    });
    const res = await scanNode('1:1', undefined, dummyBounds, runner);
    expect(res).toEqual({ reason: 'scan-node child exit not confirmed after SIGKILL' });
  });

  it('reports non-zero exit code and trimmed stderr honestly', async () => {
    const runner = mockRunner({
      exitCode: 1,
      stderr: '  figma-agent: socket closed abruptly  \n',
    });
    const res = await scanNode('1:1', undefined, dummyBounds, runner);
    expect(res).toEqual({ reason: 'figma-agent: socket closed abruptly' });
  });

  it('reports termination signal honestly when stderr is empty', async () => {
    const runner = mockRunner({
      signal: 'SIGTERM',
      exitCode: null,
      stderr: '',
    });
    const res = await scanNode('1:1', undefined, dummyBounds, runner);
    expect(res).toEqual({ reason: 'killed by SIGTERM' });
  });

  it('reports parse errors when scan-node produces malformed or empty output', () => {
    expect(parseScan('', '')).toEqual({ reason: 'scan-node produced no JSON (is the plugin open?)' });
    expect(parseScan('not-json', 'socket error')).toEqual({ reason: 'socket error' });
    expect(parseScan(JSON.stringify({ error: { message: 'Node not found' } }), '')).toEqual({ reason: 'Node not found' });
    expect(parseScan(JSON.stringify({ error: { code: 'NOT_FOUND' } }), '')).toEqual({ reason: 'NOT_FOUND' });
    expect(parseScan(JSON.stringify({}), '')).toEqual({ reason: 'scan-node returned no node spec' });
  });
});
