// `figma-agent changes --png <dir>` — an after PNG per owner-edited node in the window,
// and a before PNG ONLY when a prior export of that node predates the edit (there is no
// other honest source of a "before"). Deleted nodes and nodes the plugin can no longer
// find are listed as skipped with a reason; transport failures abort instead of turning
// into a silent empty result.
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../cli/src/transport/broker-client.ts', () => ({ runCommand: vi.fn() }));

import { parseArgs } from '../cli/src/arg-parse.ts';
import { exportChangePngs, pngFileStem } from '../cli/src/commands/changes-png-export.ts';
import { run } from '../cli/src/commands/changes.ts';
import { CliError } from '../cli/src/transport/protocol-helpers.ts';
import { runCommand } from '../cli/src/transport/broker-client.ts';
import type { EditFrame } from '../shared/edit-feed.ts';

const EDIT_TS = 1_700_000_000_000;

function frame(over: Partial<EditFrame> = {}): EditFrame {
  return {
    v: 1, ts: EDIT_TS, actor: 'owner', source: 'live', op: 'updated',
    nodeId: '1:23', nodeName: 'Hero', nodeType: 'FRAME', parentName: 'Page frame',
    changedProps: ['x'], origin: 'LOCAL', page: 'Page 1', fileKey: 'key-1',
    ...over,
  };
}

const png = (label: string): { base64: string; w: number; h: number } =>
  ({ base64: Buffer.from(label).toString('base64'), w: 10, h: 20 });

/** A runner that answers EXPORT_PNG per node id; a missing entry throws the plugin's own
 *  "node not found" refusal (E_INVALID_ARGS, executor-ops.ts getSceneNode). */
function runnerFor(nodes: Record<string, string>): typeof runCommand & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  const runner = (async (cmd: string, params: unknown, opts?: unknown) => {
    calls.push([cmd, params, opts]);
    if (cmd !== 'EXPORT_PNG') throw new Error(`unexpected ${cmd}`);
    const id = (params as { nodeId: string }).nodeId;
    if (!(id in nodes)) throw new CliError('E_INVALID_ARGS', `node not found: ${id}`);
    return png(nodes[id]!);
  }) as typeof runCommand & { calls: unknown[][] };
  runner.calls = calls;
  return runner;
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fa-changes-png-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('pngFileStem', () => {
  it('turns a node id (plain or compound instance id) into a filesystem-safe stem', () => {
    expect(pngFileStem('1:23')).toBe('1-23');
    expect(pngFileStem('I25:3;12:4')).toBe('I25-3-12-4');
  });
});

describe('exportChangePngs', () => {
  it('one after PNG per unique node, read-only, paths in the result; no before when none predates the edit', async () => {
    const runner = runnerFor({ '1:23': 'hero-after' });
    const frames = [frame({ ts: EDIT_TS }), frame({ ts: EDIT_TS + 1, changedProps: ['fills'] })];
    const out = await exportChangePngs(frames, join(dir, 'shots'), { scale: 2, runner });

    expect(out.dir).toBe(join(dir, 'shots'));
    expect(out.exported).toHaveLength(1);
    const [entry] = out.exported;
    expect(entry).toMatchObject({ nodeId: '1:23', nodeName: 'Hero', before: null, beforeSource: null });
    expect(entry!.note).toMatch(/no prior export predates/);
    expect(readFileSync(entry!.after!, 'utf8')).toBe('hero-after');
    expect(entry!.after).toBe(join(dir, 'shots', '1-23.after.png'));
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toEqual(['EXPORT_PNG', { nodeId: '1:23', scale: 2 }, expect.objectContaining({ readOnly: true })]);
    expect(out.skipped).toEqual([]);
  });

  it('a prior after.png OLDER than the edit becomes the before; the new export becomes the after', async () => {
    const shots = join(dir, 'shots');
    mkdirSync(shots, { recursive: true });
    const prior = join(shots, '1-23.after.png');
    writeFileSync(prior, 'hero-before');
    utimesSync(prior, new Date(EDIT_TS - 60_000), new Date(EDIT_TS - 60_000));

    const out = await exportChangePngs([frame()], shots, { scale: 2, runner: runnerFor({ '1:23': 'hero-after' }) });

    const [entry] = out.exported;
    expect(entry).toMatchObject({ before: join(shots, '1-23.before.png'), beforeSource: 'prior-export', after: prior });
    expect(readFileSync(entry!.before!, 'utf8')).toBe('hero-before');
    expect(readFileSync(entry!.after!, 'utf8')).toBe('hero-after');
  });

  it('a prior after.png NEWER than the edit already contains it: overwritten, and honestly no before', async () => {
    const shots = join(dir, 'shots');
    mkdirSync(shots, { recursive: true });
    const prior = join(shots, '1-23.after.png');
    writeFileSync(prior, 'already-edited');
    utimesSync(prior, new Date(EDIT_TS + 60_000), new Date(EDIT_TS + 60_000));

    const out = await exportChangePngs([frame()], shots, { scale: 2, runner: runnerFor({ '1:23': 'hero-after' }) });

    const [entry] = out.exported;
    expect(entry).toMatchObject({ before: null, beforeSource: null });
    expect(readFileSync(entry!.after!, 'utf8')).toBe('hero-after');
    expect(existsSync(join(shots, '1-23.before.png'))).toBe(false);
  });

  it('an existing before.png that predates the edit is kept when the after.png does not qualify', async () => {
    const shots = join(dir, 'shots');
    mkdirSync(shots, { recursive: true });
    const before = join(shots, '1-23.before.png');
    writeFileSync(before, 'old-before');
    utimesSync(before, new Date(EDIT_TS - 120_000), new Date(EDIT_TS - 120_000));
    const after = join(shots, '1-23.after.png');
    writeFileSync(after, 'stale-after');
    utimesSync(after, new Date(EDIT_TS + 1_000), new Date(EDIT_TS + 1_000));

    const out = await exportChangePngs([frame()], shots, { scale: 2, runner: runnerFor({ '1:23': 'hero-after' }) });

    expect(out.exported[0]).toMatchObject({ before, beforeSource: 'prior-export' });
    expect(readFileSync(before, 'utf8')).toBe('old-before');
  });

  it('a node deleted in the window is skipped with a note and never sent to the plugin', async () => {
    const runner = runnerFor({ '1:23': 'hero-after' });
    const out = await exportChangePngs(
      [frame(), frame({ nodeId: '9:9', nodeName: 'Subtitle', op: 'deleted', ts: EDIT_TS + 5 })],
      join(dir, 'shots'), { scale: 2, runner },
    );
    expect(out.exported.map((e) => e.nodeId)).toEqual(['1:23']);
    expect(out.skipped).toEqual([{ nodeId: '9:9', nodeName: 'Subtitle', reason: 'deleted in this window — nothing to export' }]);
    expect(runner.calls).toHaveLength(1);
  });

  it('a node the plugin can no longer find is skipped with the plugin\'s reason; the others still export', async () => {
    const runner = runnerFor({ '1:23': 'hero-after' });
    const out = await exportChangePngs(
      [frame({ nodeId: '7:7', nodeName: 'Gone' }), frame()],
      join(dir, 'shots'), { scale: 2, runner },
    );
    expect(out.skipped).toEqual([{ nodeId: '7:7', nodeName: 'Gone', reason: 'E_INVALID_ARGS: node not found: 7:7' }]);
    expect(out.exported.map((e) => e.nodeId)).toEqual(['1:23']);
  });

  it('a transport failure (no plugin) aborts the whole export rather than reporting an empty success', async () => {
    const runner = (async () => { throw new CliError('E_NO_PLUGIN', 'no plugin'); }) as unknown as typeof runCommand;
    await expect(exportChangePngs([frame()], join(dir, 'shots'), { scale: 2, runner })).rejects.toMatchObject({ code: 'E_NO_PLUGIN' });
  });

  it('an empty window exports nothing and says so without touching the plugin', async () => {
    const runner = runnerFor({});
    const out = await exportChangePngs([], join(dir, 'shots'), { scale: 2, runner });
    expect(out).toMatchObject({ exported: [], skipped: [] });
    expect(runner.calls).toEqual([]);
  });
});

describe('changes --png (run)', () => {
  const prevEnv = process.env['FIGMA_AGENT_CHANGES_DIR'];
  let feedDir: string;

  beforeEach(() => {
    feedDir = mkdtempSync(join(tmpdir(), 'fa-changes-png-run-'));
    process.env['FIGMA_AGENT_CHANGES_DIR'] = feedDir;
    mkdirSync(join(feedDir, 'changes'), { recursive: true });
    const lines = [
      frame({ nodeId: '1:23', ts: 100, actor: 'owner' }),
      frame({ nodeId: '2:2', ts: 200, actor: 'agent', nodeName: 'Agent frame' }),
      frame({ nodeId: '3:3', ts: 300, actor: 'owner', nodeName: 'Card' }),
    ].map((l) => JSON.stringify(l)).join('\n') + '\n';
    writeFileSync(join(feedDir, 'changes', 'vsf-pcp.jsonl'), lines);
    vi.mocked(runCommand).mockReset();
    vi.mocked(runCommand).mockImplementation(async (cmd, params) => png(`png-${(params as { nodeId: string }).nodeId}`));
  });
  afterEach(() => {
    if (prevEnv === undefined) delete process.env['FIGMA_AGENT_CHANGES_DIR'];
    else process.env['FIGMA_AGENT_CHANGES_DIR'] = prevEnv;
    rmSync(feedDir, { recursive: true, force: true });
  });

  it('--owner-only --png <dir> exports the owner-edited nodes of the window and lands every path in the JSON', async () => {
    const shots = join(dir, 'shots');
    const out = await run(parseArgs(['--owner-only', '--png', shots])) as {
      changes: unknown[]; png: { dir: string; exported: Array<{ nodeId: string; after: string | null }>; skipped: unknown[] };
    };
    expect(out.changes).toHaveLength(2);
    expect(out.png.dir).toBe(shots);
    expect(out.png.exported.map((e) => e.nodeId)).toEqual(['1:23', '3:3']);
    for (const e of out.png.exported) expect(readFileSync(e.after!, 'utf8')).toBe(`png-${e.nodeId}`);
    expect(vi.mocked(runCommand).mock.calls.map((c) => c[0])).toEqual(['EXPORT_PNG', 'EXPORT_PNG']);
  });

  it('--limit bounds the PNG count the same way it bounds the listed changes', async () => {
    const out = await run(parseArgs(['--owner-only', '--png', join(dir, 'shots'), '--limit', '1'])) as {
      png: { exported: Array<{ nodeId: string }> };
    };
    expect(out.png.exported.map((e) => e.nodeId)).toEqual(['3:3']);
  });

  it('without --png the command stays pure fs: no broker call, no png key', async () => {
    const out = await run(parseArgs(['--owner-only'])) as { png?: unknown };
    expect(out.png).toBeUndefined();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('--png with no directory value is refused', async () => {
    await expect(run(parseArgs(['--owner-only', '--png']))).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
  });
});
