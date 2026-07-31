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
import { describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import {
  loopbackWsUrl,
  probeBrokerHandshake,
  probeStaleButAlive,
} from '../cli/src/transport/broker-discovery.ts';
import { isConfirmedDeadAfterFailedConnect } from '../cli/src/transport/broker-client.ts';
import { LOOPBACK_HOST } from '../shared/protocol.ts';
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
