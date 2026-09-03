// `figma-agent status`'s `plugin.coverage`: the plugin's own statement, merged with the
// rows only the broker can see, printed as ONE answer an agent reads first on connect.
//
// The pure row builder is exercised directly; the merge is exercised end to end against a
// REAL scratch broker (the same injected-`ensureBroker` pattern tests/status-wait.test.ts
// uses), because the thing worth proving is that a fake plugin's STATUS reply and the
// broker's own registry meet correctly in one object.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import type { CommandArgs } from '../cli/src/arg-parse.ts';
import type { SessionCoverage } from '../shared/protocol.ts';
import { COVERAGE_SEE_TARGETS } from '../shared/session-coverage.ts';
import { brokerCoverageRows } from '../cli/src/transport/broker-coverage-rows.ts';
import { COMMANDS } from '../cli/src/command-catalog.ts';

vi.mock('../cli/src/transport/broker-discovery.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../cli/src/transport/broker-discovery.ts')>();
  return { ...actual, ensureBroker: vi.fn() };
});

const { ensureBroker } = await import('../cli/src/transport/broker-discovery.ts');
const { run } = await import('../cli/src/commands/status.ts');
const { setExpectedFile } = await import('../cli/src/transport/broker-client.ts');

vi.setConfig({ testTimeout: 30_000 });

type BrokerDaemonModule = typeof import('../cli/src/transport/broker-daemon.ts');

let scratchDir: string;
let advertisePath: string;
let sockets: WebSocket[];

function fakeArgs(flags: Record<string, string | boolean> = {}): CommandArgs {
  return {
    positionals: [],
    str: (name) => (typeof flags[name] === 'string' ? (flags[name] as string) : undefined),
    req: (name) => {
      const v = flags[name];
      if (typeof v !== 'string') throw new Error(`missing --${name}`);
      return v;
    },
    num: (name) => (typeof flags[name] === 'string' ? Number(flags[name]) : undefined),
    bool: (name) => flags[name] === true || flags[name] === 'true',
  };
}

async function loadBrokerDaemon(): Promise<BrokerDaemonModule> {
  process.env.FIGMA_AGENT_CHANGES_DIR = scratchDir;
  process.env.FIGMA_AGENT_BINDS_FILE = join(scratchDir, 'binds.json');
  process.env.FIGMA_AGENT_UNBOUND_DIR = join(scratchDir, 'unbound-root');
  vi.resetModules();
  return import('../cli/src/transport/broker-daemon.ts');
}

function testExit(): (code: number) => never {
  return (code: number): never => { throw new Error(`__TEST_BROKER_EXIT__ code=${code}`); };
}

function connectSocket(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    sockets.push(ws);
  });
}

/** A fake plugin that answers STATUS with the coverage block a real one would carry
 *  (`undefined` = an older bundle that has no coverage statement at all). */
async function helloPlugin(
  ws: WebSocket, instanceId: string, fileName: string, coverage?: SessionCoverage,
  fileKey: string | null = null,
): Promise<void> {
  ws.send(JSON.stringify({
    type: 'PLUGIN_HELLO', data: { instanceId, fileName, fileKey, caps: ['fileGuard'] },
  }));
  await new Promise<void>((resolve) => {
    const handler = (raw: WebSocket.RawData): void => {
      if ((JSON.parse(raw.toString()) as { type?: string }).type === 'SYNC_CONFIG') {
        ws.off('message', handler);
        resolve();
      }
    };
    ws.on('message', handler);
  });
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString()) as { id?: unknown; cmd?: unknown };
    if (typeof msg.id === 'string' && typeof msg.cmd === 'string') {
      ws.send(JSON.stringify({ id: msg.id, ok: true, result: coverage ? { coverage } : {} }));
    }
  });
}

const settle = (ms = 60): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'fa-coverage-status-'));
  advertisePath = join(scratchDir, 'broker.json');
  sockets = [];
});

afterEach(async () => {
  const live = sockets.find((ws) => ws.readyState === WebSocket.OPEN);
  if (live) {
    try { live.send(JSON.stringify({ type: 'BROKER_SHUTDOWN_REQUEST' })); } catch { /* already gone */ }
    await settle(20);
  }
  for (const ws of sockets) { try { ws.terminate(); } catch { /* already gone */ } }
  rmSync(scratchDir, { recursive: true, force: true });
  vi.mocked(ensureBroker).mockReset();
});

describe('brokerCoverageRows — what the plugin cannot say about itself', () => {
  it('a clean single-file session produces no rows at all', () => {
    expect(brokerCoverageRows({ fileRows: [{}], otherFiles: 0, pluginsField: 'plugins' }).filter(Boolean))
      .toEqual([]);
  });

  it('each row points at the field on THIS reply that carries its number', () => {
    expect(brokerCoverageRows({
      fileRows: [{ relayDroppedFrames: 6, replayedBatches: 2 }], otherFiles: 0, pluginsField: 'plugins',
    })).toEqual([
      { kind: 'relay-dropped-frames', count: 6, see: 'status.plugins[].relayDroppedFrames' },
      { kind: 'replayed-batches', count: 2, see: 'status.plugins[].replayedBatches' },
      null,
    ]);
  });

  it('under --file the same rows point at pluginsAll, the list that still holds the counted rows', () => {
    expect(brokerCoverageRows({
      fileRows: [{ relayDroppedFrames: 1, replayedBatches: 1 }], otherFiles: 1, pluginsField: 'pluginsAll',
    })).toEqual([
      { kind: 'relay-dropped-frames', count: 1, see: 'status.pluginsAll[].relayDroppedFrames' },
      { kind: 'replayed-batches', count: 1, see: 'status.pluginsAll[].replayedBatches' },
      { kind: 'other-files-connected', count: 1, see: 'status.pluginsAll' },
    ]);
  });

  it('two sessions on the SAME file punched holes in the same feed, so their losses add up', () => {
    expect(brokerCoverageRows({
      fileRows: [{ relayDroppedFrames: 4 }, { relayDroppedFrames: 3 }], otherFiles: 0, pluginsField: 'plugins',
    })[0]).toEqual({ kind: 'relay-dropped-frames', count: 7, see: 'status.plugins[].relayDroppedFrames' });
  });

  it('other connected files are their own row — their edits are not in this view', () => {
    expect(brokerCoverageRows({ fileRows: [{}], otherFiles: 2, pluginsField: 'plugins' })[2])
      .toEqual({ kind: 'other-files-connected', count: 2, see: 'status.plugins' });
  });
});

describe('figma-agent status — plugin.coverage', () => {
  it('a plugin reporting a complete session, alone on the broker, reads as complete', async () => {
    const mod = await loadBrokerDaemon();
    await mod.runBrokerDaemon({ advertisePath, ports: [0], exit: testExit() });
    const ad = JSON.parse(readFileSync(advertisePath, 'utf8')) as { port: number; pid: number };
    vi.mocked(ensureBroker).mockResolvedValue({
      port: ad.port, pid: ad.pid, protocolV: 1, buildMtime: 0, startedAt: Date.now(), lastSeen: Date.now(),
    });
    const ws = await connectSocket(ad.port);
    await helloPlugin(ws, 'p_1', 'Only File', { complete: true, gaps: [] });

    const result = await run(fakeArgs()) as { plugin: { coverage: SessionCoverage } };
    expect(result.plugin.coverage).toEqual({ complete: true, gaps: [] });
  });

  it('a second connected file is a gap the plugin could not know about', async () => {
    const mod = await loadBrokerDaemon();
    await mod.runBrokerDaemon({ advertisePath, ports: [0], exit: testExit() });
    const ad = JSON.parse(readFileSync(advertisePath, 'utf8')) as { port: number; pid: number };
    vi.mocked(ensureBroker).mockResolvedValue({
      port: ad.port, pid: ad.pid, protocolV: 1, buildMtime: 0, startedAt: Date.now(), lastSeen: Date.now(),
    });
    await helloPlugin(await connectSocket(ad.port), 'p_1', 'First File', { complete: true, gaps: [] });
    await helloPlugin(await connectSocket(ad.port), 'p_2', 'Second File', { complete: true, gaps: [] });
    await settle();

    const result = await run(fakeArgs()) as { plugin: { coverage: SessionCoverage } };
    expect(result.plugin.coverage.complete).toBe(false);
    expect(result.plugin.coverage.gaps)
      .toEqual([{ kind: 'other-files-connected', count: 1, see: 'status.plugins' }]);
  });

  it('a plugin that reports no coverage at all leaves the verdict unknown — never a default true', async () => {
    const mod = await loadBrokerDaemon();
    await mod.runBrokerDaemon({ advertisePath, ports: [0], exit: testExit() });
    const ad = JSON.parse(readFileSync(advertisePath, 'utf8')) as { port: number; pid: number };
    vi.mocked(ensureBroker).mockResolvedValue({
      port: ad.port, pid: ad.pid, protocolV: 1, buildMtime: 0, startedAt: Date.now(), lastSeen: Date.now(),
    });
    await helloPlugin(await connectSocket(ad.port), 'p_1', 'Older Bundle');

    const result = await run(fakeArgs()) as { plugin: { coverage: SessionCoverage } };
    expect(result.plugin.coverage).toEqual({ complete: null, gaps: [] });
  });

  it('two windows on ONE other file are ONE other file, not two', async () => {
    const mod = await loadBrokerDaemon();
    await mod.runBrokerDaemon({ advertisePath, ports: [0], exit: testExit() });
    const ad = JSON.parse(readFileSync(advertisePath, 'utf8')) as { port: number; pid: number };
    vi.mocked(ensureBroker).mockResolvedValue({
      port: ad.port, pid: ad.pid, protocolV: 1, buildMtime: 0, startedAt: Date.now(), lastSeen: Date.now(),
    });
    await helloPlugin(await connectSocket(ad.port), 'p_other_a', 'Second File', { complete: true, gaps: [] });
    await helloPlugin(await connectSocket(ad.port), 'p_other_b', 'Second File', { complete: true, gaps: [] });
    await helloPlugin(await connectSocket(ad.port), 'p_1', 'First File', { complete: true, gaps: [] });
    await settle();

    const result = await run(fakeArgs()) as { plugin: { coverage: SessionCoverage } };
    expect(result.plugin.coverage.gaps)
      .toEqual([{ kind: 'other-files-connected', count: 1, see: 'status.plugins' }]);
  });

  it('under --file the row points at pluginsAll — plugins[] no longer holds what was counted', async () => {
    const mod = await loadBrokerDaemon();
    await mod.runBrokerDaemon({ advertisePath, ports: [0], exit: testExit() });
    const ad = JSON.parse(readFileSync(advertisePath, 'utf8')) as { port: number; pid: number };
    vi.mocked(ensureBroker).mockResolvedValue({
      port: ad.port, pid: ad.pid, protocolV: 1, buildMtime: 0, startedAt: Date.now(), lastSeen: Date.now(),
    });
    await helloPlugin(await connectSocket(ad.port), 'p_1', 'First File', { complete: true, gaps: [] });
    await helloPlugin(await connectSocket(ad.port), 'p_2', 'Second File', { complete: true, gaps: [] });
    await settle();

    const result = await run(fakeArgs({ file: 'First File' })) as {
      plugin: { coverage: SessionCoverage }; plugins: unknown[]; pluginsAll: unknown[];
    };
    expect(result.plugins).toHaveLength(1);        // filtered — the counted file is not here
    expect(result.pluginsAll).toHaveLength(2);     // …it is here
    expect(result.plugin.coverage.gaps)
      .toEqual([{ kind: 'other-files-connected', count: 1, see: 'status.pluginsAll' }]);
  });

  it('two OTHER files that share a name are two files — the key tells them apart', async () => {
    const mod = await loadBrokerDaemon();
    await mod.runBrokerDaemon({ advertisePath, ports: [0], exit: testExit() });
    const ad = JSON.parse(readFileSync(advertisePath, 'utf8')) as { port: number; pid: number };
    vi.mocked(ensureBroker).mockResolvedValue({
      port: ad.port, pid: ad.pid, protocolV: 1, buildMtime: 0, startedAt: Date.now(), lastSeen: Date.now(),
    });
    // `Untitled` is Figma's default file name, so two of them at once is an ordinary
    // desktop state, not a contrived one.
    const clean: SessionCoverage = { complete: true, gaps: [] };
    await helloPlugin(await connectSocket(ad.port), 'p_a', 'Untitled', clean, 'KEY_A');
    await helloPlugin(await connectSocket(ad.port), 'p_b', 'Untitled', clean, 'KEY_B');
    await helloPlugin(await connectSocket(ad.port), 'p_active', 'Design File', clean, 'KEY_ACTIVE');
    await settle();

    const result = await run(fakeArgs()) as { plugin: { coverage: SessionCoverage } };
    expect(result.plugin.coverage.gaps)
      .toEqual([{ kind: 'other-files-connected', count: 2, see: 'status.plugins' }]);
  });

  it("a same-named OTHER file's losses never land on the active session's statement", async () => {
    const mod = await loadBrokerDaemon();
    await mod.runBrokerDaemon({ advertisePath, ports: [0], exit: testExit() });
    const ad = JSON.parse(readFileSync(advertisePath, 'utf8')) as { port: number; pid: number };
    vi.mocked(ensureBroker).mockResolvedValue({
      port: ad.port, pid: ad.pid, protocolV: 1, buildMtime: 0, startedAt: Date.now(), lastSeen: Date.now(),
    });
    const clean: SessionCoverage = { complete: true, gaps: [] };
    // The LOSSY one connects FIRST, so a name-keyed roll-up that happens to pick the first
    // matching row cannot pass this by luck of insertion order.
    const lossy = await connectSocket(ad.port);
    await helloPlugin(lossy, 'p_lossy', 'Untitled', clean, 'KEY_OTHER');
    lossy.send(JSON.stringify({
      type: 'PLUGIN_RELAY_STATS',
      data: { dropped: { frames: 7, chars: 70 }, sessionTotal: { frames: 7, chars: 70 } },
    }));
    await settle();
    await helloPlugin(await connectSocket(ad.port), 'p_active', 'Untitled', clean, 'KEY_ACTIVE');
    await settle();

    const result = await run(fakeArgs()) as { plugin: { coverage: SessionCoverage } };
    // The active session lost nothing; the other file's 7 frames stay on ITS plugins[] row.
    expect(result.plugin.coverage.gaps)
      .toEqual([{ kind: 'other-files-connected', count: 1, see: 'status.plugins' }]);
  });

  it('relay frames the plugin lost before connecting ride the same statement', async () => {
    const mod = await loadBrokerDaemon();
    await mod.runBrokerDaemon({ advertisePath, ports: [0], exit: testExit() });
    const ad = JSON.parse(readFileSync(advertisePath, 'utf8')) as { port: number; pid: number };
    vi.mocked(ensureBroker).mockResolvedValue({
      port: ad.port, pid: ad.pid, protocolV: 1, buildMtime: 0, startedAt: Date.now(), lastSeen: Date.now(),
    });
    const ws = await connectSocket(ad.port);
    await helloPlugin(ws, 'p_1', 'Lossy File', { complete: true, gaps: [] });
    ws.send(JSON.stringify({
      type: 'PLUGIN_RELAY_STATS',
      data: { dropped: { frames: 2, chars: 20 }, sessionTotal: { frames: 5, chars: 50 } },
    }));
    await settle();

    const result = await run(fakeArgs()) as { plugin: { coverage: SessionCoverage } };
    expect(result.plugin.coverage).toEqual({
      complete: false,
      gaps: [{ kind: 'relay-dropped-frames', count: 5, see: 'status.plugins[].relayDroppedFrames' }],
    });
  });
});

describe('figma-agent status — ambiguous --file diagnoses instead of failing', () => {
  afterEach(() => { setExpectedFile(undefined); });

  it('two files sharing a name diagnose as ambiguous instead of failing the round-trip', async () => {
    const mod = await loadBrokerDaemon();
    await mod.runBrokerDaemon({ advertisePath, ports: [0], exit: testExit() });
    const ad = JSON.parse(readFileSync(advertisePath, 'utf8')) as { port: number; pid: number };
    vi.mocked(ensureBroker).mockResolvedValue({
      port: ad.port, pid: ad.pid, protocolV: 1, buildMtime: 0, startedAt: Date.now(), lastSeen: Date.now(),
    });
    const clean: SessionCoverage = { complete: true, gaps: [] };
    await helloPlugin(await connectSocket(ad.port), 'p_a', 'Untitled', clean, 'KEY_A');
    await helloPlugin(await connectSocket(ad.port), 'p_b', 'Untitled', clean, 'KEY_B');
    await settle();

    // Production wiring: figma-agent.ts's main() calls `setExpectedFile(args.str('file'))`
    // once per process, which is what makes the STATUS round-trip below carry `expectedFile`
    // and hit the broker's ROUTE ambiguity refusal — `run(fakeArgs({file}))` alone does not.
    setExpectedFile('Untitled');
    const result = await run(fakeArgs({ file: 'Untitled' })) as {
      plugin: { connected: boolean; state: string; ambiguous?: number; coverage: SessionCoverage };
      plugins: unknown[];
      pluginsAll: unknown[];
    };

    expect(result.plugin.connected).toBe(false);
    expect(result.plugin.state).toBe('ambiguous');
    expect(result.plugin.ambiguous).toBe(2);
    expect(result.plugins).toHaveLength(2);
    expect(result.pluginsAll).toHaveLength(2);
    expect(result.plugin.coverage.complete).toBeNull();
  });

  it('nothing is IN VIEW when ambiguous — every distinct connected identity counts, none excluded as "active"', async () => {
    const mod = await loadBrokerDaemon();
    await mod.runBrokerDaemon({ advertisePath, ports: [0], exit: testExit() });
    const ad = JSON.parse(readFileSync(advertisePath, 'utf8')) as { port: number; pid: number };
    vi.mocked(ensureBroker).mockResolvedValue({
      port: ad.port, pid: ad.pid, protocolV: 1, buildMtime: 0, startedAt: Date.now(), lastSeen: Date.now(),
    });
    const clean: SessionCoverage = { complete: true, gaps: [] };
    await helloPlugin(await connectSocket(ad.port), 'p_a', 'Untitled', clean, 'KEY_A');
    await helloPlugin(await connectSocket(ad.port), 'p_b', 'Untitled', clean, 'KEY_B');
    await helloPlugin(await connectSocket(ad.port), 'p_c', 'Design System', clean, 'KEY_C');
    await settle();

    setExpectedFile('Untitled');
    const result = await run(fakeArgs({ file: 'Untitled' })) as {
      plugin: { coverage: SessionCoverage };
    };

    // Distinct connected identities: KEY_A, KEY_B, KEY_C = 3. An ambiguous --file reaches
    // no plugin, so NONE of them is "the active session" excluded from the count — not
    // even the two Untitled rows the caller's --file matched.
    expect(result.plugin.coverage.gaps)
      .toEqual([{ kind: 'other-files-connected', count: 3, see: 'status.pluginsAll' }]);
  });
});

// Drift guard for `see`: every value a coverage row can carry must name something that
// EXISTS — a CLI command, or a field on this very reply. A row pointing at a field the
// reply does not carry is worse than no pointer at all.
function resolveTarget(target: string, result: Record<string, unknown>): unknown {
  const segments = target.split('.');
  if (segments[0] !== 'status') return undefined;
  // ONE root: the reply itself. Accepting `result.plugin` as a second root would let
  // `status.gapfill` and `status.plugin.gapfill` both "resolve", which is exactly the
  // ambiguity a pointer must not have — the agent following it has one place to look.
  let cursor: unknown = result;
  for (const segment of segments.slice(1)) {
    const isList = segment.endsWith('[]');
    const key = isList ? segment.slice(0, -2) : segment;
    cursor = (cursor as Record<string, unknown> | undefined)?.[key];
    if (isList) cursor = Array.isArray(cursor) ? cursor[0] : undefined;
    if (cursor === undefined) return undefined;
  }
  return cursor;
}

describe('every `see` target names something that exists', () => {
  it('each one resolves on a real `status` reply, or is a real CLI command', async () => {
    const mod = await loadBrokerDaemon();
    await mod.runBrokerDaemon({ advertisePath, ports: [0], exit: testExit() });
    const ad = JSON.parse(readFileSync(advertisePath, 'utf8')) as { port: number; pid: number };
    vi.mocked(ensureBroker).mockResolvedValue({
      port: ad.port, pid: ad.pid, protocolV: 1, buildMtime: 0, startedAt: Date.now(), lastSeen: Date.now(),
    });
    const ws = await connectSocket(ad.port);
    ws.send(JSON.stringify({
      type: 'PLUGIN_HELLO', data: { instanceId: 'p_rich', fileName: 'Rich File', caps: ['fileGuard'] },
    }));
    await new Promise<void>((resolve) => {
      const handler = (raw: WebSocket.RawData): void => {
        if ((JSON.parse(raw.toString()) as { type?: string }).type === 'SYNC_CONFIG') {
          ws.off('message', handler);
          resolve();
        }
      };
      ws.on('message', handler);
    });
    // A STATUS reply carrying every block a coverage row can point at.
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as { id?: unknown; cmd?: unknown };
      if (typeof msg.id === 'string' && typeof msg.cmd === 'string') {
        ws.send(JSON.stringify({
          id: msg.id,
          ok: true,
          result: {
            coverage: { complete: true, gaps: [] },
            gapfill: { pagesDiffed: 1, pagesTruncated: 0, pagesTopLevelOnly: 0, baselineWrittenAt: null, baselineBytes: 0 },
            captureErrors: ['store write failed'],
            perf: { bootLoadAllPagesMs: 1, pageLoadAsyncMaxMs: 0, bootWalkMs: 1, bootWalkMaxSliceMs: 1, bootSlices: 1, idleWalkMs: 0, idleWalkMaxSliceMs: 0 },
          },
        }));
      }
    });
    ws.send(JSON.stringify({
      type: 'PLUGIN_RELAY_STATS',
      data: { dropped: { frames: 1, chars: 10 }, sessionTotal: { frames: 1, chars: 10 } },
    }));
    ws.send(JSON.stringify({
      type: 'EDIT_FEED',
      data: {
        fileName: 'Rich File', fileKey: null, source: 'live', replayed: true,
        edits: [{
          op: 'update', nodeId: '1:2', nodeName: 'Card', nodeType: 'FRAME', parentName: 'Home',
          changedProps: ['x'], origin: 'owner', page: 'Home', actor: 'owner',
        }],
      },
    }));
    await settle();

    const plain = await run(fakeArgs()) as Record<string, unknown>;
    const filtered = await run(fakeArgs({ file: 'Rich File' })) as Record<string, unknown>;
    const commandNames = new Set(COMMANDS.map((c) => c.name));

    for (const target of COVERAGE_SEE_TARGETS) {
      if (!target.startsWith('status.')) {
        expect(commandNames, `\`see: ${target}\` is not a CLI command`).toContain(target);
        continue;
      }
      const found = resolveTarget(target, plain) ?? resolveTarget(target, filtered);
      expect(found, `\`see: ${target}\` resolves to nothing on a real status reply`).toBeDefined();
    }
  });
});
