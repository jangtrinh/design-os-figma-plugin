// The broker end of the session coverage statement, against a REAL in-process broker and
// real `ws` sockets — the seam pure unit tests cannot see: whether the per-instance tally
// actually survives the socket close that deletes the registry entry, and whether it
// reaches `plugins[]` on the next BROKER_HELLO.
//
// Isolation follows the daemon-harness pattern: an OS-assigned ephemeral port
// (`ports: [0]`), a tmpdir advertisement path + change dirs, and an `exit` stub that
// throws instead of killing the vitest worker — this never touches the machine's real
// /tmp advertisement, the 9410-9419 range, or a live broker.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import type { EventMsg } from '../shared/protocol.ts';
import { SESSION_TALLY_MAX } from '../cli/src/transport/session-tallies.ts';

vi.setConfig({ testTimeout: 30_000 });

type BrokerDaemonModule = typeof import('../cli/src/transport/broker-daemon.ts');
type PluginRow = { instanceId: string; relayDroppedFrames?: number; replayedBatches?: number };

let scratchDir: string;
let advertisePath: string;
let scratchLogFile: string;
let sockets: WebSocket[];

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

/** Connect a CLI-side client and resolve with its greeting BROKER_HELLO — the exact data
 *  `figma-agent status` reads. */
function readHelloPlugins(port: number): Promise<PluginRow[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    sockets.push(ws);
    ws.once('error', reject);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as EventMsg;
      if (msg.type === 'BROKER_HELLO') {
        ws.close();
        resolve((msg.data as { plugins: PluginRow[] }).plugins);
      }
    });
  });
}

async function helloPlugin(ws: WebSocket, instanceId: string): Promise<void> {
  ws.send(JSON.stringify({ type: 'PLUGIN_HELLO', data: { instanceId, fileName: 'Coverage File', caps: ['fileGuard'] } }));
  await new Promise<void>((resolve) => {
    const handler = (raw: WebSocket.RawData): void => {
      if ((JSON.parse(raw.toString()) as { type?: string }).type === 'SYNC_CONFIG') {
        ws.off('message', handler);
        resolve();
      }
    };
    ws.on('message', handler);
  });
}

const settle = (ms = 120): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

// ONE capture batch as the plugin actually posts it: a DOC_CHANGE frame AND an EDIT_FEED
// frame for the same edits (document-change-capture.ts posts both), each stamped
// `replayed` when the relay had buffered it through an outage.
const captureBatch = (replayed: boolean): string[] => [
  JSON.stringify({
    type: 'DOC_CHANGE',
    data: {
      page: 'Home', fileKey: null, fileName: 'Coverage File', replayed,
      changes: [{ type: 'PROPERTY_CHANGE', id: '1:2', name: 'Card' }],
    },
  }),
  JSON.stringify({
    type: 'EDIT_FEED',
    data: {
      fileName: 'Coverage File', fileKey: null, source: 'live', replayed,
      edits: [{
        op: 'update', nodeId: '1:2', nodeName: 'Card', nodeType: 'FRAME', parentName: 'Home',
        changedProps: ['x'], origin: 'owner', page: 'Home', actor: 'owner',
      }],
    },
  }),
];

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'fa-coverage-tally-'));
  advertisePath = join(scratchDir, 'broker.json');
  scratchLogFile = join(scratchDir, 'broker.log');
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
});

describe('the broker records what only it can see about a plugin session', () => {
  it('a relay drop report reaches plugins[]; a reconnect that reports nothing does not erase it', async () => {
    const mod = await loadBrokerDaemon();
    await mod.runBrokerDaemon({ advertisePath, ports: [0], exit: testExit() });
    const { port } = JSON.parse(readFileSync(advertisePath, 'utf8')) as { port: number };

    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'p_cov');
    plugin.send(JSON.stringify({
      type: 'PLUGIN_RELAY_STATS',
      data: { dropped: { frames: 2, chars: 20 }, sessionTotal: { frames: 6, chars: 60 } },
    }));
    await settle();

    // The SESSION total is what a coverage row must state — the delta is only what this
    // one frame had not yet had confirmed.
    expect((await readHelloPlugins(port))[0]).toMatchObject({ instanceId: 'p_cov', relayDroppedFrames: 6 });

    // Reconnect: the close deletes the registry entry, and the relay re-reports ONLY when
    // it has new loss to declare — so a tally kept on that entry would silently reset to
    // zero here and the session would read as complete.
    plugin.close();
    await settle();
    const reconnected = await connectSocket(port);
    await helloPlugin(reconnected, 'p_cov');
    await settle();
    expect((await readHelloPlugins(port))[0]).toMatchObject({ instanceId: 'p_cov', relayDroppedFrames: 6 });

    // A later report restates the whole session total: it REPLACES, it never sums.
    reconnected.send(JSON.stringify({
      type: 'PLUGIN_RELAY_STATS',
      data: { dropped: { frames: 3, chars: 30 }, sessionTotal: { frames: 9, chars: 90 } },
    }));
    await settle();
    expect((await readHelloPlugins(port))[0]).toMatchObject({ relayDroppedFrames: 9 });
  });

  it('ONE replayed batch counts ONCE, though it arrives as both a DOC_CHANGE and an EDIT_FEED', async () => {
    const mod = await loadBrokerDaemon();
    await mod.runBrokerDaemon({ advertisePath, ports: [0], exit: testExit() });
    const { port } = JSON.parse(readFileSync(advertisePath, 'utf8')) as { port: number };

    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'p_replay');
    for (const frame of captureBatch(false)) plugin.send(frame);
    await settle();
    expect('replayedBatches' in (await readHelloPlugins(port))[0]).toBe(false);

    // One outage, one batch replayed out of the relay's buffer — two frames, one batch.
    for (const frame of captureBatch(true)) plugin.send(frame);
    await settle();
    expect((await readHelloPlugins(port))[0]).toMatchObject({ replayedBatches: 1 });
  });

  it('past the cap the OLDEST tally is evicted and the eviction is LOGGED, never silent', async () => {
    const mod = await loadBrokerDaemon();
    await mod.runBrokerDaemon({ advertisePath, ports: [0], exit: testExit(), logFile: scratchLogFile });
    const { port } = JSON.parse(readFileSync(advertisePath, 'utf8')) as { port: number };

    // One socket per instance is enough — the tally lives in a daemon-scoped map keyed
    // by instanceId, independent of the registry entry a reconnect would otherwise erase
    // (see session-tallies.ts's own header). SESSION_TALLY_MAX + 1 distinct instances
    // pushes the oldest ('evict-0') out.
    for (let i = 0; i <= SESSION_TALLY_MAX; i++) {
      const ws = await connectSocket(port);
      ws.send(JSON.stringify({
        type: 'PLUGIN_HELLO', data: { instanceId: `evict-${i}`, fileName: 'Coverage File', caps: ['fileGuard'] },
      }));
      ws.send(JSON.stringify({
        type: 'PLUGIN_RELAY_STATS',
        data: { dropped: { frames: 1, chars: 10 }, sessionTotal: { frames: 1, chars: 10 } },
      }));
    }
    await settle(500);

    expect(readFileSync(scratchLogFile, 'utf8')).toMatch(/session tally evicted for \[evict-0\]/);
  });
});
