import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import {
  makeRequestFrame,
  type EventMsg,
  type ReplyErr,
  type ReplyOk,
  type WireMsg,
} from '../shared/protocol.ts';
import {
  leaseFilePath,
  readProcessStartToken,
  reconcileLeaseDirFor,
  writeLeaseFile,
  type ReconcileLeaseRecord,
} from '../cli/src/transport/reconcile-lease.ts';

let scratchDir: string;
let advertisePath: string;
let scratchLogFile: string;
let sockets: WebSocket[];
const spawnedPids = new Set<number>();
let priorUiBin: string | undefined;

function testExit(): (code: number) => never {
  return (code: number): never => {
    throw new Error(`__TEST_BROKER_EXIT__ code=${code}`);
  };
}

async function startTestBroker(advertiseFile: string, logFile: string): Promise<number> {
  process.env['FIGMA_AGENT_CHANGES_DIR'] = scratchDir;
  process.env['FIGMA_AGENT_BINDS_FILE'] = join(scratchDir, 'binds.json');
  process.env['FIGMA_AGENT_UNBOUND_DIR'] = join(scratchDir, 'unbound-root');
  vi.resetModules();
  const mod = await import('../cli/src/transport/broker-daemon.ts');
  await mod.runBrokerDaemon({ advertisePath: advertiseFile, ports: [0], exit: testExit(), logFile });
  const ad = JSON.parse(readFileSync(advertiseFile, 'utf8')) as { port: number; pid: number };
  return ad.port;
}

function connectSocket(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    sockets.push(ws);
  });
}

function nextFrame<T extends WireMsg | EventMsg>(ws: WebSocket, predicate?: (m: WireMsg) => boolean): Promise<T> {
  return new Promise((resolve) => {
    const handler = (raw: WebSocket.RawData): void => {
      const msg = JSON.parse(raw.toString()) as WireMsg;
      if (!predicate || predicate(msg)) {
        ws.off('message', handler);
        resolve(msg as T);
      }
    };
    ws.on('message', handler);
  });
}

async function helloPlugin(ws: WebSocket, instanceId: string, fileName: string): Promise<void> {
  ws.send(JSON.stringify({
    type: 'PLUGIN_HELLO',
    data: { instanceId, fileName, fileKey: null, caps: ['fileGuard'] },
  } satisfies EventMsg));
  await nextFrame(ws, (m) => (m as EventMsg).type === 'SYNC_CONFIG');
}

async function bindProject(ws: WebSocket, fileName: string, projectDir: string, reqId: string): Promise<void> {
  ws.send(JSON.stringify(makeRequestFrame(reqId, 'PROJECT_BIND', { fileName, projectDir })));
  const reply = await nextFrame<ReplyOk | ReplyErr>(ws, (m) => (m as ReplyOk | ReplyErr).id === reqId);
  if (!reply.ok) throw new Error(`bind failed: ${JSON.stringify((reply as ReplyErr).error)}`);
}

function spawnDummyChild(delayMs = 20_000): { pid: number; kill: () => void } {
  const child = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${delayMs})`], {
    stdio: 'ignore',
  });
  if (child.pid) {
    spawnedPids.add(child.pid);
  }
  return {
    pid: child.pid!,
    kill: () => {
      try {
        child.kill('SIGKILL');
      } catch { /* ignore */ }
    },
  };
}

beforeEach(() => {
  priorUiBin = process.env['FIGMA_AGENT_UI_BIN'];
  scratchDir = mkdtempSync(join(tmpdir(), 'fa-surviving-child-'));
  advertisePath = join(scratchDir, 'broker.json');
  scratchLogFile = join(scratchDir, 'broker.log');
  sockets = [];
});

afterEach(async () => {
  for (const pid of spawnedPids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch { /* ignore */ }
  }
  spawnedPids.clear();

  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'BROKER_SHUTDOWN_REQUEST' }));
      } catch { /* ignore */ }
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const ws of sockets) {
    try {
      ws.terminate();
    } catch { /* ignore */ }
  }
  sockets = [];

  if (priorUiBin === undefined) delete process.env['FIGMA_AGENT_UI_BIN'];
  else process.env['FIGMA_AGENT_UI_BIN'] = priorUiBin;

  rmSync(scratchDir, { recursive: true, force: true });
});

describe('broker daemon harness — surviving reconcile child lease enforcement', () => {
  it('refuses SYNC_REQUEST when surviving reconcile apply child is still alive, and succeeds once stopped', async () => {
    const projectDir = join(scratchDir, 'project-a');
    mkdirSync(join(projectDir, 'design'), { recursive: true });

    // Controlled mock kernel for apply recovery
    const kernel = join(projectDir, 'ui-kernel');
    writeFileSync(kernel, `#!${process.execPath}
const args = process.argv;
const dry = args.includes('--dry-run');
const data = dry ? { delta: { added: [], updated: [] }, pending: [] } : { apply: { added: [], updated: [], deprecated: [], mirrored: [], pending: [], skipped: [], mirrorSkipped: [] } };
console.log(JSON.stringify({ ok: true, data }));
`);
    chmodSync(kernel, 0o755);
    process.env['FIGMA_AGENT_UI_BIN'] = kernel;

    // Simulate surviving child from previous broker session
    const dummy = spawnDummyChild();
    const liveToken = readProcessStartToken(dummy.pid);
    expect(liveToken.state).toBe('alive');
    const token = (liveToken as { token: string }).token;

    const leaseDir = reconcileLeaseDirFor(advertisePath);
    mkdirSync(leaseDir, { recursive: true });
    const leasePath = leaseFilePath(leaseDir, projectDir);
    const existingLease: ReconcileLeaseRecord = {
      version: 1,
      pid: dummy.pid,
      startToken: token,
      phase: 'apply',
      status: 'running',
      projectDir,
      startedAt: new Date().toISOString(),
    };
    writeLeaseFile(leasePath, existingLease);

    // Start broker on the same advertisePath
    const port = await startTestBroker(advertisePath, scratchLogFile);
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'plugin-survive-1', 'Surviving Child File');

    const cli = await connectSocket(port);
    await bindProject(cli, 'Surviving Child File', projectDir, 'bind-surviving-1');

    // Issue SYNC_REQUEST while surviving child is alive -> must be refused with RECONCILE_IN_FLIGHT_SURVIVED
    const firstResultPromise = nextFrame<EventMsg>(plugin, (f) => (f as EventMsg).type === 'SYNC_RESULT');
    plugin.send(JSON.stringify({ type: 'SYNC_REQUEST', data: {} } satisfies EventMsg));
    const firstResult = (await firstResultPromise).data as { ok: boolean; code: string; summary: string };

    expect(firstResult.ok).toBe(false);
    expect(firstResult.code).toBe('RECONCILE_IN_FLIGHT_SURVIVED');
    expect(firstResult.summary).toContain('reconcile admission refused');
    expect(existsSync(leasePath)).toBe(true);

    // Kill the surviving child process and wait for process cleanup
    dummy.kill();
    let deadToken = readProcessStartToken(dummy.pid);
    while (deadToken.state !== 'dead') {
      deadToken = readProcessStartToken(dummy.pid);
    }

    // Now issue another SYNC_REQUEST -> evidence-based recovery proceeds and sync succeeds
    const secondResultPromise = nextFrame<EventMsg>(plugin, (f) => (f as EventMsg).type === 'SYNC_RESULT');
    plugin.send(JSON.stringify({ type: 'SYNC_REQUEST', data: {} } satisfies EventMsg));
    const secondResult = (await secondResultPromise).data as { ok: boolean; summary: string };

    expect(secondResult.ok).toBe(true);
    expect(existsSync(leasePath)).toBe(false);
  });

  it('cancelForShutdown cancels in-flight reconcile child during graceful broker shutdown', async () => {
    const projectDir = join(scratchDir, 'project-b');
    mkdirSync(join(projectDir, 'design'), { recursive: true });

    // Mock kernel with a long delay in dry-run
    const kernel = join(projectDir, 'ui-kernel-slow');
    writeFileSync(kernel, `#!${process.execPath}
const args = process.argv;
const dry = args.includes('--dry-run');
setTimeout(() => {
  const data = dry ? { delta: { added: [], updated: [] }, pending: [] } : { apply: {} };
  console.log(JSON.stringify({ ok: true, data }));
}, 10000);
`);
    chmodSync(kernel, 0o755);
    process.env['FIGMA_AGENT_UI_BIN'] = kernel;

    const port = await startTestBroker(advertisePath, scratchLogFile);
    const plugin = await connectSocket(port);
    await helloPlugin(plugin, 'plugin-shutdown-1', 'Shutdown File');

    const cli = await connectSocket(port);
    await bindProject(cli, 'Shutdown File', projectDir, 'bind-shutdown-1');

    // Trigger SYNC_REQUEST (spawns slow child)
    plugin.send(JSON.stringify({ type: 'SYNC_REQUEST', data: {} } satisfies EventMsg));
    await new Promise((r) => setTimeout(r, 100));

    // Request graceful shutdown via BROKER_SHUTDOWN_REQUEST
    cli.send(JSON.stringify({ type: 'BROKER_SHUTDOWN_REQUEST' }));
    await new Promise((r) => setTimeout(r, 150));

    const logContent = readFileSync(scratchLogFile, 'utf8');
    expect(logContent).toContain('cancelForShutdown invoked (BROKER_SHUTDOWN_REQUEST)');
  });
});
