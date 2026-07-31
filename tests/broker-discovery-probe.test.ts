// Broker hardening (issue #5), item 3 — probe-before-kill. Any path that decides an
// advertised broker is dead/stale must PROBE liveness (pid check + a handshake
// connect) before deleting its advertisement or spawning a competing broker.
// Deciding "dead" from a stale heartbeat alone — or from a single failed connect —
// is a split-brain risk: a second broker gets spawned on top of a still-alive one,
// leaving the older instance orphaned while it still holds the Figma plugin's live
// WS connection.
//
// `probeStaleButAlive`/`isConfirmedDeadAfterFailedConnect` did not exist before this
// change (ensureBroker() fell straight through to spawnBroker() on any stale
// heartbeat, and runCommand() unlinked the advertisement on the FIRST failed
// connect) — importing them fails against pre-fix code.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cleanupOrphanedAdvertisementTempFiles,
  decideBrokerAction,
  loopbackWsUrl,
  probeBrokerHandshake,
  probeStaleButAlive,
} from '../cli/src/transport/broker-discovery.ts';
import { isConfirmedDeadAfterFailedConnect, retryAmbiguousConnect } from '../cli/src/transport/broker-client.ts';
import { PROTOCOL_VERSION, LOOPBACK_HOST } from '../shared/protocol.ts';
import type { BrokerAdvertisement } from '../shared/protocol.ts';

function fakeAd(overrides: Partial<BrokerAdvertisement> = {}): BrokerAdvertisement {
  return { port: 9410, pid: 4242, protocolV: 1, buildMtime: 0, startedAt: 0, lastSeen: 0, ...overrides };
}

describe('probeStaleButAlive — heartbeat staleness alone never authorises spawning a competitor', () => {
  it('a dead pid is never trusted, and the network probe is never reached (cheap check first)', async () => {
    const probe = vi.fn().mockResolvedValue(true);
    const trusted = await probeStaleButAlive(fakeAd(), { isPidAlive: () => false, probe });
    expect(trusted).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });

  it('a live pid that answers the handshake is trusted — no competing broker spawned', async () => {
    const trusted = await probeStaleButAlive(fakeAd(), { isPidAlive: () => true, probe: async () => true });
    expect(trusted).toBe(true);
  });

  it('a live pid that fails the handshake is not trusted — genuinely unresponsive', async () => {
    const trusted = await probeStaleButAlive(fakeAd(), { isPidAlive: () => true, probe: async () => false });
    expect(trusted).toBe(false);
  });
});

describe('isConfirmedDeadAfterFailedConnect — a failed connect alone never proves death', () => {
  it('a dead pid confirms death — safe to delete the advertisement and respawn', () => {
    expect(isConfirmedDeadAfterFailedConnect(fakeAd(), () => false)).toBe(true);
  });

  it('a live pid means the failure is ambiguous — must NOT be treated as confirmed dead', () => {
    expect(isConfirmedDeadAfterFailedConnect(fakeAd(), () => true)).toBe(false);
  });
});

// Stage-4 review round, minor #1 — the ambiguous-failure retry had no backoff: it
// re-attempted the connect immediately, landing inside the exact "broker
// mid-accept / busy on another handshake" window that caused the first failure.
// `retryAmbiguousConnect` did not exist before this fix.
describe('retryAmbiguousConnect — waits the backoff BEFORE retrying, not after', () => {
  it('sleeps first, then connects — proves the delay actually gates the retry', async () => {
    const order: string[] = [];
    const sleep = vi.fn(async (ms: number) => { order.push(`sleep:${ms}`); });
    const connect = vi.fn(async () => { order.push('connect'); return {} as WebSocket; });

    await retryAmbiguousConnect(9410, { connect, sleep, delayMs: 200 });

    expect(order).toEqual(['sleep:200', 'connect']);
    expect(sleep).toHaveBeenCalledWith(200);
    expect(connect).toHaveBeenCalledWith(9410);
  });

  it('propagates a second failure once the backoff has already been spent', async () => {
    const sleep = vi.fn(async () => {});
    const connect = vi.fn(async () => { throw new Error('still refused'); });

    await expect(retryAmbiguousConnect(9410, { connect, sleep, delayMs: 50 })).rejects.toThrow('still refused');
    expect(sleep).toHaveBeenCalledTimes(1); // the backoff still ran before giving up
  });
});

describe('probeBrokerHandshake — real WS accept/refuse against an ephemeral port', () => {
  it('resolves true when something is actually listening and accepts the connection', async () => {
    const wss = new WebSocketServer({ host: LOOPBACK_HOST, port: 0 });
    await new Promise<void>((resolve) => wss.once('listening', resolve));
    const addr = wss.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    try {
      await expect(probeBrokerHandshake(port)).resolves.toBe(true);
    } finally {
      wss.close();
    }
  });

  it('resolves false when nothing is listening on the port (connection refused)', async () => {
    // Bind-then-close to get a port that was just freed — near-guaranteed nothing
    // else grabbed it in the same tick, without hardcoding a port number.
    const wss = new WebSocketServer({ host: LOOPBACK_HOST, port: 0 });
    await new Promise<void>((resolve) => wss.once('listening', resolve));
    const addr = wss.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    await new Promise<void>((resolve) => wss.close(() => resolve()));

    await expect(probeBrokerHandshake(port, 500)).resolves.toBe(false);
  });
});

describe('loopbackWsUrl — the ONE host string every connect/probe must agree with bind', () => {
  it('builds a URL against LOOPBACK_HOST, never the ambiguous "localhost"', () => {
    expect(loopbackWsUrl(9410)).toBe(`ws://${LOOPBACK_HOST}:9410`);
    expect(loopbackWsUrl(9410)).not.toContain('localhost');
  });
});

// Stage-4 review round (regression) — a stale-but-alive advertisement (heartbeat
// missed, but the pid is alive and the handshake answers) must go through the
// SAME protocol/build gate as a freshly-heartbeating one, with the SAME
// consequence on a mismatch: 'replace', never a silent 'reuse'. Pre-fix,
// `ensureBroker`'s stale-but-alive branch returned the advertisement
// unconditionally — reachable via "laptop sleeps through a heartbeat window,
// gets rebuilt while asleep, reopens": the old broker's pid is alive and its
// handshake answers, so the CLI would keep talking to a pre-rebuild broker with
// no signal that it did. `decideBrokerAction` did not exist before this fix, so
// this whole describe block fails to even import against pre-fix code.
describe('decideBrokerAction — stale-but-alive gets the SAME protocol/build gate as live', () => {
  const aliveDeps = { isAdvertisementLive: () => false, probeStaleButAlive: async () => true };
  const deadDeps = { isAdvertisementLive: () => false, probeStaleButAlive: async () => false };
  const liveDeps = { isAdvertisementLive: () => true, probeStaleButAlive: async () => true };

  it('no advertisement at all → spawn', async () => {
    expect(await decideBrokerAction(null, 100, aliveDeps)).toBe('spawn');
  });

  it('neither a fresh heartbeat nor a passing handshake → spawn (genuinely dead)', async () => {
    const ad = fakeAd({ protocolV: PROTOCOL_VERSION, buildMtime: 100 });
    expect(await decideBrokerAction(ad, 100, deadDeps)).toBe('spawn');
  });

  it('stale-but-alive + matching protocol + current build → reuse', async () => {
    const ad = fakeAd({ protocolV: PROTOCOL_VERSION, buildMtime: 100 });
    expect(await decideBrokerAction(ad, 100, aliveDeps)).toBe('reuse');
  });

  it('REGRESSION LOCK: stale-but-alive + OUTDATED build → replace, never reuse', async () => {
    const ad = fakeAd({ protocolV: PROTOCOL_VERSION, buildMtime: 100 }); // old build
    const myMtime = 100 + 10_000; // this CLI was rebuilt after the broker started
    expect(await decideBrokerAction(ad, myMtime, aliveDeps)).toBe('replace');
  });

  it('stale-but-alive + mismatched protocol → replace, never reuse', async () => {
    const ad = fakeAd({ protocolV: PROTOCOL_VERSION - 1, buildMtime: 100 });
    expect(await decideBrokerAction(ad, 100, aliveDeps)).toBe('replace');
  });

  it('a freshly-heartbeating (live) advertisement with an outdated build also replaces — parity with the stale-but-alive path', async () => {
    const ad = fakeAd({ protocolV: PROTOCOL_VERSION, buildMtime: 100 });
    expect(await decideBrokerAction(ad, 100 + 10_000, liveDeps)).toBe('replace');
  });

  it('a freshly-heartbeating advertisement with a current build reuses', async () => {
    const ad = fakeAd({ protocolV: PROTOCOL_VERSION, buildMtime: 100 });
    expect(await decideBrokerAction(ad, 100, liveDeps)).toBe('reuse');
  });
});

// Stage-4 review round, minor #3 — `isAdvertisementLive`'s staleness slack must
// derive from the SAME env-overridable cadence broker-daemon.ts's refresh
// interval runs on (FIGMA_AGENT_HEARTBEAT_MS), not a second hardcoded 30_000 that
// could silently drift from it. `HEARTBEAT_MS` is read at broker-discovery.ts's
// MODULE LOAD TIME, so this needs a fresh import after setting the env var —
// the same pattern tests/broker-daemon-harness.test.ts already uses for
// broker-daemon.ts's own env-derived constants.
describe('isAdvertisementLive — staleness slack derives from the shared heartbeat cadence (m3)', () => {
  afterEach(() => {
    delete process.env.FIGMA_AGENT_HEARTBEAT_MS;
  });

  it('an advertisement stale past HEARTBEAT_STALE_MS + the SHRUNK override is dead, even though it would still be "live" under the old hardcoded 30s slack', async () => {
    process.env.FIGMA_AGENT_HEARTBEAT_MS = '1000';
    vi.resetModules();
    const mod = await import('../cli/src/transport/broker-discovery.ts');
    const { HEARTBEAT_STALE_MS } = await import('../shared/protocol.ts');

    // 500ms past the STALE_MS + 1000ms-override boundary: dead under the new
    // (env-derived) slack, but well under STALE_MS + the old hardcoded 30_000 —
    // this age value only reads as "dead" if the fix's derivation is in effect.
    const ad = fakeAd({ pid: process.pid, lastSeen: Date.now() - (HEARTBEAT_STALE_MS + 1_000 + 500) });
    expect(mod.isAdvertisementLive(ad)).toBe(false);
  });

  it('the same advertisement reads live under the override\'s own tolerance window', async () => {
    process.env.FIGMA_AGENT_HEARTBEAT_MS = '1000';
    vi.resetModules();
    const mod = await import('../cli/src/transport/broker-discovery.ts');
    const { HEARTBEAT_STALE_MS } = await import('../shared/protocol.ts');

    const ad = fakeAd({ pid: process.pid, lastSeen: Date.now() - (HEARTBEAT_STALE_MS + 500) });
    expect(mod.isAdvertisementLive(ad)).toBe(true);
  });
});

// Broker hardening (issue #5), minor round — a SIGKILL between writeFileAtomic's
// temp write and its renameSync leaves `${path}.<dead-pid>.tmp` behind forever
// (the process that would have run its own catch-block cleanup no longer
// exists). `cleanupOrphanedAdvertisementTempFiles` did not exist before this fix.
describe('cleanupOrphanedAdvertisementTempFiles — sweeps only its own dead-pid temp files', () => {
  let scratchDir: string;
  let advertisePath: string;

  beforeEach(() => {
    scratchDir = mkdtempSync(join(tmpdir(), 'fa-orphan-sweep-'));
    advertisePath = join(scratchDir, 'broker.json');
  });

  afterEach(() => {
    rmSync(scratchDir, { recursive: true, force: true });
  });

  it('removes a temp file whose embedded pid is dead', () => {
    // PID 999999 is not a real process on any dev machine or CI runner.
    const orphan = `${advertisePath}.999999.tmp`;
    writeFileSync(orphan, '{}');
    const cleaned = cleanupOrphanedAdvertisementTempFiles(advertisePath);
    expect(cleaned).toBe(1);
    expect(existsSync(orphan)).toBe(false);
  });

  it('leaves a temp file whose embedded pid is alive (this test process itself)', () => {
    const inFlight = `${advertisePath}.${process.pid}.tmp`;
    writeFileSync(inFlight, '{}');
    const cleaned = cleanupOrphanedAdvertisementTempFiles(advertisePath);
    expect(cleaned).toBe(0);
    expect(existsSync(inFlight)).toBe(true);
  });

  it('never touches a file outside its own naming pattern', () => {
    const unrelated = join(scratchDir, 'unrelated.tmp');
    writeFileSync(unrelated, 'keep me');
    cleanupOrphanedAdvertisementTempFiles(advertisePath);
    expect(existsSync(unrelated)).toBe(true);
  });

  it('a missing directory is a no-op, not a throw', () => {
    expect(() => cleanupOrphanedAdvertisementTempFiles(join(scratchDir, 'gone', 'broker.json'))).not.toThrow();
  });

  it('leaves nothing extra behind after a mixed sweep', () => {
    writeFileSync(`${advertisePath}.999999.tmp`, '{}'); // dead → swept
    writeFileSync(`${advertisePath}.${process.pid}.tmp`, '{}'); // alive → kept
    cleanupOrphanedAdvertisementTempFiles(advertisePath);
    expect(readdirSync(scratchDir)).toEqual([`broker.json.${process.pid}.tmp`]);
  });
});
