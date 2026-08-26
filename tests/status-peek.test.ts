// `status --peek` must never spawn a broker (see broker-peek.ts's header) — this
// suite proves it two ways: (1) in-process against a REAL broker + a fake plugin
// WS, using the same daemon-harness isolation broker-daemon-harness.test.ts
// established (scratch tmpdir advertisement, ports:[0], a throwing `exit` stub,
// CHANGES_DIR/BINDS_FILE/UNBOUND_DIR redirected so this never touches the real
// /tmp state); (2) a real subprocess run of the BUILT cli/dist bundle with no
// broker at all, proving idle peek exits 0 and creates nothing on disk.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { peek, projectReadiness } from '../cli/src/transport/broker-peek.ts';
import { mutationGatePathFor } from '../cli/src/transport/mutation-admission-gate.ts';

/** Accepts a TCP connection and then says nothing, forever — the ONLY way to
 *  actually exercise the deadline-timer branch of peek()'s race (a closed port
 *  refuses instantly and never reaches it). */
function startSilentListener(): Promise<{ server: Server; port: number }> {
  return new Promise((resolvePromise) => {
    const server = createServer(() => { /* accept, then never speak */ });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolvePromise({ server, port });
    });
  });
}

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CLI_DIST = join(ROOT, 'cli', 'dist', 'figma-agent.js');

type BrokerDaemonModule = typeof import('../cli/src/transport/broker-daemon.ts');

let scratchDir: string;
let advertisePath: string;
let sockets: WebSocket[];

/** Mirrors tests/broker-daemon-harness.test.ts's loadBrokerDaemon — the module-load-time
 *  CHANGES_DIR/BINDS_FILE/UNBOUND_DIR constants need env vars set BEFORE a fresh import. */
async function loadBrokerDaemon(): Promise<BrokerDaemonModule> {
  process.env.FIGMA_AGENT_CHANGES_DIR = scratchDir;
  process.env.FIGMA_AGENT_BINDS_FILE = join(scratchDir, 'binds.json');
  process.env.FIGMA_AGENT_UNBOUND_DIR = join(scratchDir, 'unbound-root');
  vi.resetModules();
  return import('../cli/src/transport/broker-daemon.ts');
}

function testExit(): (code: number) => never {
  return (code: number): never => {
    throw new Error(`__TEST_BROKER_EXIT__ code=${code}`);
  };
}

function connectSocket(port: number): Promise<WebSocket> {
  return new Promise((resolvePromise, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('open', () => resolvePromise(ws));
    ws.once('error', reject);
    sockets.push(ws);
  });
}

async function helloPlugin(ws: WebSocket, instanceId: string, fileName: string, pluginVersion: string, protocolV: number): Promise<void> {
  ws.send(JSON.stringify({
    type: 'PLUGIN_HELLO',
    data: { instanceId, fileName, fileKey: null, caps: ['fileGuard'], pluginVersion, protocolV },
  }));
  await new Promise<void>((resolvePromise) => {
    const handler = (raw: WebSocket.RawData): void => {
      const msg = JSON.parse(raw.toString()) as { type?: string };
      if (msg.type === 'SYNC_CONFIG') {
        ws.off('message', handler);
        resolvePromise();
      }
    };
    ws.on('message', handler);
  });
}

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'fa-peek-'));
  advertisePath = join(scratchDir, 'broker.json');
  sockets = [];
});

afterEach(async () => {
  const shutdownSocket = sockets.find((ws) => ws.readyState === WebSocket.OPEN);
  if (shutdownSocket) {
    try { shutdownSocket.send(JSON.stringify({ type: 'BROKER_SHUTDOWN_REQUEST' })); } catch { /* already closed */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  for (const ws of sockets) { try { ws.terminate(); } catch { /* already closed */ } }
  rmSync(scratchDir, { recursive: true, force: true });
});

describe('peek() — in-process, real broker + fake plugin', () => {
  it('idle: no advertisement at all → connected:false, idle:true, no error', async () => {
    const result = await peek({ path: join(scratchDir, 'none.json') });
    expect(result).toMatchObject({ connected: false, broker: null, idle: true });
  });

  it('live broker, no plugin connected → connected:false, broker present, plugins empty', async () => {
    const mod = await loadBrokerDaemon();
    await mod.runBrokerDaemon({ advertisePath, ports: [0], exit: testExit() });
    const result = await peek({ path: advertisePath });
    expect(result.connected).toBe(false);
    expect(result.broker).not.toBeNull();
    expect(result.broker?.pid).toBe(process.pid);
    expect(result.plugins).toEqual([]);
  });

  it('keeps disconnected persisted mutation-gate rows and store health in the non-spawning projection', async () => {
    writeFileSync(mutationGatePathFor(advertisePath), JSON.stringify({
      schemaVersion: 1,
      sequence: 7,
      gates: { 'Raw Key / disconnected': { state: 'paused', lastTransitionRevision: 7 } },
      latestTransition: {
        fileKey: 'Raw Key / disconnected', from: 'open', to: 'paused', at: 1, revision: 7,
      },
    }));
    const mod = await loadBrokerDaemon();
    await mod.runBrokerDaemon({ advertisePath, ports: [0], exit: testExit() });

    const result = await peek({ path: advertisePath });
    expect(result.connected).toBe(false);
    expect(result.broker).toMatchObject({ targetFileKeyAdmissionV: 1 });
    expect(result.mutationGates).toEqual([
      { fileKey: 'Raw Key / disconnected', state: 'paused', lastTransitionRevision: 7 },
    ]);
    expect(result.mutationGateStoreHealth).toMatchObject({ state: 'healthy', path: mutationGatePathFor(advertisePath) });
  });

  it('a matching plugin build reports versionMatch/protocolMatch true', async () => {
    const mod = await loadBrokerDaemon();
    await mod.runBrokerDaemon({ advertisePath, ports: [0], exit: testExit() });
    const ad = JSON.parse(readFileSync(advertisePath, 'utf8')) as { port: number };
    const ws = await connectSocket(ad.port);
    await helloPlugin(ws, 'p_1', 'Test File', '0.1.0', 1);
    const result = await peek({ path: advertisePath });
    expect(result.connected).toBe(true);
    expect(result.plugins?.[0]).toMatchObject({ fileName: 'Test File', pluginVersion: '0.1.0', protocolV: 1, versionMatch: true, protocolMatch: true });
    expect(result.versionMatch).toBe(true);
    expect(result.protocolMatch).toBe(true);
    expect(result.broker).toMatchObject({ appReadinessVersion: 1, appReadinessVersionMatch: true });
    expect(result.plugins?.[0]).toMatchObject({ appReady: true, appState: 'ready', appHeartbeatMode: 'legacy' });
  });

  it('old and unsupported broker payloads never fabricate readiness', () => {
    const advertised = { appReady: true, appState: 'ready' as const, appHeartbeatMode: 'correlated' as const, appReadinessAge: 1 };
    expect(projectReadiness(advertised, undefined)).toEqual({
      appReady: null, appState: 'unknown', appHeartbeatMode: 'unknown', appReadinessAge: null,
    });
    expect(projectReadiness(advertised, 99)).toEqual({
      appReady: null, appState: 'unknown', appHeartbeatMode: 'unknown', appReadinessAge: null,
    });
  });

  it('a plugin build with no version at all reports versionMatch/protocolMatch null (unknown, not mismatched)', async () => {
    const mod = await loadBrokerDaemon();
    await mod.runBrokerDaemon({ advertisePath, ports: [0], exit: testExit() });
    const ad = JSON.parse(readFileSync(advertisePath, 'utf8')) as { port: number };
    const ws = await connectSocket(ad.port);
    ws.send(JSON.stringify({ type: 'PLUGIN_HELLO', data: { instanceId: 'p_1', fileName: 'Old Build', fileKey: null, caps: ['fileGuard'] } }));
    await new Promise<void>((resolvePromise) => {
      const handler = (raw: WebSocket.RawData): void => {
        const msg = JSON.parse(raw.toString()) as { type?: string };
        if (msg.type === 'SYNC_CONFIG') { ws.off('message', handler); resolvePromise(); }
      };
      ws.on('message', handler);
    });
    const result = await peek({ path: advertisePath });
    expect(result.plugins?.[0]).toMatchObject({ fileName: 'Old Build', versionMatch: null, protocolMatch: null });
    expect(result.plugins?.[0]).not.toHaveProperty('pluginVersion');
    expect(result.versionMatch).toBeNull();
  });

  it('a dead/stale advertisement (pid never existed) reads as idle, never as connected', async () => {
    writeFileSync(advertisePath, JSON.stringify({ port: 9999, pid: 999999, protocolV: 1, buildMtime: 0, startedAt: 0, lastSeen: Date.now() }));
    const result = await peek({ path: advertisePath });
    expect(result).toMatchObject({ connected: false, idle: true });
  });

  it('a closed port refuses INSTANTLY — reports the real refusal reason, never a fabricated timeout label', async () => {
    // A live pid (this test process) advertised on a port nothing is listening on:
    // the WS connect fails with a real refusal, well before any deadline could fire.
    writeFileSync(advertisePath, JSON.stringify({ port: 65530, pid: process.pid, protocolV: 1, buildMtime: 0, startedAt: Date.now(), lastSeen: Date.now() }));
    const started = Date.now();
    const result = await peek({ path: advertisePath, queryMs: 200 });
    const elapsed = Date.now() - started;
    expect(result.connected).toBeNull(); // unknown, not a fabricated "not connected"
    expect(result.degraded).toBeDefined();
    expect(result.degraded).not.toMatch(/did not answer within 200ms/); // must not relabel a refusal as a timeout
    expect(elapsed).toBeLessThan(150); // refused well short of the 200ms deadline
    expect(result.broker).toMatchObject({ port: 65530, pid: process.pid });
  });

  it('a broker that accepts the socket and then goes silent hits the REAL deadline — connected:null, degraded names the timeout', async () => {
    const { server, port } = await startSilentListener();
    try {
      writeFileSync(advertisePath, JSON.stringify({ port, pid: process.pid, protocolV: 1, buildMtime: 0, startedAt: Date.now(), lastSeen: Date.now() }));
      const started = Date.now();
      const result = await peek({ path: advertisePath, queryMs: 200 });
      const elapsed = Date.now() - started;
      expect(result.connected).toBeNull();
      expect(result.degraded).toMatch(/did not answer within 200ms/);
      expect(elapsed).toBeGreaterThanOrEqual(190); // actually waited out the deadline, not an instant refusal
      expect(result.broker).toMatchObject({ port, pid: process.pid });
    } finally {
      server.close();
    }
  });
});

describe('status --peek — subprocess, no broker present', () => {
  beforeAll(() => {
    execFileSync(process.execPath, ['scripts/build.mjs', 'cli'], { cwd: ROOT }); // measured ~134ms
  });

  it('exits 0, reports connected:false, and creates no advertisement file', () => {
    const noneDir = mkdtempSync(join(tmpdir(), 'fa-peek-subprocess-'));
    const nonePath = join(noneDir, 'none.json');
    try {
      const out = execFileSync(process.execPath, [CLI_DIST, 'status', '--peek', '--json'], {
        cwd: ROOT,
        env: { ...process.env, FIGMA_AGENT_BROKER_FILE: nonePath },
        encoding: 'utf8',
      });
      const parsed = JSON.parse(out) as { connected: boolean; idle?: boolean };
      expect(parsed.connected).toBe(false);
      expect(parsed.idle).toBe(true);
      expect(existsSync(nonePath)).toBe(false);
      expect(readdirSync(noneDir)).toEqual([]); // nothing at all was written, not even a temp file
    } finally {
      rmSync(noneDir, { recursive: true, force: true });
    }
  });

  it('completes well under the 200ms budget when idle', () => {
    const noneDir = mkdtempSync(join(tmpdir(), 'fa-peek-budget-'));
    try {
      const nonePath = join(noneDir, 'none.json');
      const started = Date.now();
      execFileSync(process.execPath, [CLI_DIST, 'status', '--peek'], {
        cwd: ROOT,
        env: { ...process.env, FIGMA_AGENT_BROKER_FILE: nonePath },
      });
      expect(Date.now() - started).toBeLessThan(2_000); // generous subprocess-startup allowance; peek() itself is <200ms
    } finally {
      rmSync(noneDir, { recursive: true, force: true });
    }
  });

  it('validates --target-file-key before non-spawning peek and preserves its distinct selector contract', () => {
    const noneDir = mkdtempSync(join(tmpdir(), 'fa-peek-target-key-'));
    const nonePath = join(noneDir, 'none.json');
    const errorFor = (args: string[]): { error: { code: string; message: string } } => {
      try {
        execFileSync(process.execPath, [CLI_DIST, 'status', '--peek', ...args], {
          cwd: ROOT,
          env: { ...process.env, FIGMA_AGENT_BROKER_FILE: nonePath },
          encoding: 'utf8',
        });
      } catch (err) {
        return JSON.parse(String((err as { stdout?: string }).stdout));
      }
      throw new Error('expected --target-file-key validation to reject before status --peek');
    };
    try {
      expect(errorFor(['--target-file-key', ' Raw/Key'])).toMatchObject({ error: { code: 'E_INVALID_ARGS' } });
      expect(errorFor(['--target-file-key', 'Raw/Key', '--file', 'Other file'])).toMatchObject({ error: { code: 'E_INVALID_ARGS' } });
      expect(existsSync(nonePath)).toBe(false);
    } finally {
      rmSync(noneDir, { recursive: true, force: true });
    }
  });
});
