// Broker discovery: /tmp advertisement file read/write (spec §1) + validate
// (pid alive, protocol, buildMtime) → reuse; otherwise replace a stale broker
// (BROKER_SHUTDOWN_REQUEST) and/or spawn a detached `node <self> __broker`,
// polling until advertised.
import { spawn } from 'node:child_process';
import { readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import {
  BROKER_FILE,
  HEARTBEAT_STALE_MS,
  LOOPBACK_HOST,
  PROTOCOL_VERSION,
  type BrokerAdvertisement,
} from '../../../shared/protocol.ts';
import { CliError } from './protocol-helpers.ts';

const SPAWN_POLL_MS = 50;
const SPAWN_DEADLINE_MS = 5_000;
const SHUTDOWN_WAIT_MS = 3_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Absolute path of the running CLI bundle (cli/dist/figma-agent.js at runtime). */
export function selfBundlePath(): string {
  return fileURLToPath(import.meta.url);
}

let cachedMtime: number | null = null;
/** mtime of the running bundle — a newer build replaces a stale broker. */
export function selfBuildMtime(): number {
  if (cachedMtime === null) cachedMtime = statSync(selfBundlePath()).mtimeMs;
  return cachedMtime;
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'; // alive, owned by someone else
  }
}

/** The one WS URL builder for every loopback connect/probe in this file (and
 *  broker-client.ts) — see LOOPBACK_HOST's doc for why this must never be built
 *  from the bare ambiguous hostname. tests/broker-loopback-host.test.ts locks this
 *  against the daemon's own bind host. */
export function loopbackWsUrl(port: number): string {
  return `ws://${LOOPBACK_HOST}:${port}`;
}

/**
 * `path` defaults to the real, shared advertisement file for every production caller.
 * Closing round (daemon harness ruling) — `runBrokerDaemon`'s own harness override is
 * the ONLY caller that ever passes a different path (a tmpdir scratch file), so a test
 * broker never touches this machine's real live-broker advertisement.
 */
export function readAdvertisement(path: string = BROKER_FILE): BrokerAdvertisement | null {
  try {
    const ad = JSON.parse(readFileSync(path, 'utf8')) as BrokerAdvertisement;
    if (typeof ad?.port !== 'number' || typeof ad?.pid !== 'number') return null;
    return ad;
  } catch {
    return null; // absent or unreadable → treated as no broker
  }
}

/** Live = pid alive AND advertisement refreshed recently (guards pid reuse). */
export function isAdvertisementLive(ad: BrokerAdvertisement): boolean {
  return isPidAlive(ad.pid) && Date.now() - ad.lastSeen < HEARTBEAT_STALE_MS + 30_000;
}

/**
 * Write a file atomically: full write to a process-unique temp file, then
 * `renameSync` onto the target. `rename(2)` is atomic on POSIX, so a reader only
 * ever sees the complete old file or the complete new one — never a truncated or
 * half-written one. A plain `writeFileSync(path, …)` truncates the target first,
 * leaving a window where every 30s heartbeat (and every `figma-agent status`/
 * `ensureBroker` read racing it) can observe an empty or partial file — which
 * `readAdvertisement`'s JSON.parse turns into "no broker" and the orphan-avoidance
 * logic in `ensureBroker`/`runCommand` would read as "advertisement lied", spawning
 * or tearing down a perfectly healthy broker. Adapted from southleft/figma-console-mcp's
 * `writePortFileAtomic`.
 */
function writeFileAtomic(path: string, contents: string): void {
  const tmpPath = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmpPath, contents);
    renameSync(tmpPath, path);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* best-effort */ }
    throw err;
  }
}

/** Write/refresh the daemon's advertisement (called from broker-daemon only). `path`
 *  defaults to the real shared file — see `readAdvertisement`'s doc for the harness override. */
export function writeAdvertisement(port: number, startedAt: number, path: string = BROKER_FILE): void {
  const ad: BrokerAdvertisement = {
    port,
    pid: process.pid,
    protocolV: PROTOCOL_VERSION,
    buildMtime: selfBuildMtime(),
    startedAt,
    lastSeen: Date.now(),
  };
  writeFileAtomic(path, JSON.stringify(ad));
}

/**
 * Liveness handshake against a sibling broker's WS port — connect, wait for the
 * open event (or an error/timeout), close, report the verdict. Used ONLY to
 * decide whether a heartbeat-stale-but-pid-alive advertisement still deserves
 * trust before spawning a competing broker (see `probeStaleButAlive`) — a real
 * reply is not required, a live TCP accept is already proof someone is home.
 */
export function probeBrokerHandshake(port: number, timeoutMs = 1_500): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const ws = new WebSocket(loopbackWsUrl(port));
    const finish = (alive: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.terminate(); } catch { /* already closed */ }
      resolve(alive);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    ws.once('open', () => finish(true));
    ws.once('error', () => finish(false));
  });
}

/**
 * Whether a heartbeat-stale advertisement should still be trusted WITHOUT spawning
 * a competing broker. A stale `lastSeen` alone is not proof of death — a broker
 * under load (GC pause, a big EXEC_JS job) can miss one 30s tick while still being
 * perfectly alive. Deciding "dead" from staleness alone and spawning a second
 * broker on top of it is a split-brain: two live daemons, only the newer one
 * advertised, the older one silently orphaned while still holding the Figma
 * plugin's live WS connection. `isPidAlive` is checked FIRST and cheaply — a dead
 * pid never gets to the network probe (nobody could possibly answer).
 */
export async function probeStaleButAlive(
  ad: BrokerAdvertisement,
  deps: { isPidAlive: typeof isPidAlive; probe: typeof probeBrokerHandshake } = { isPidAlive, probe: probeBrokerHandshake },
): Promise<boolean> {
  if (!deps.isPidAlive(ad.pid)) return false;
  return deps.probe(ad.port);
}

/** Ask a stale-but-alive broker to exit; escalate to SIGTERM if it lingers. */
async function requestBrokerShutdown(ad: BrokerAdvertisement): Promise<void> {
  await new Promise<void>((resolve) => {
    const ws = new WebSocket(loopbackWsUrl(ad.port));
    const done = (): void => {
      try {
        ws.terminate();
      } catch {
        /* already closed */
      }
      resolve();
    };
    const timer = setTimeout(done, 1_500);
    ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'BROKER_SHUTDOWN_REQUEST' }));
      setTimeout(() => {
        clearTimeout(timer);
        done();
      }, 200);
    });
    ws.once('error', () => {
      clearTimeout(timer);
      done();
    });
  });
  const deadline = Date.now() + SHUTDOWN_WAIT_MS;
  while (Date.now() < deadline && isPidAlive(ad.pid)) await sleep(100);
  if (isPidAlive(ad.pid)) {
    try {
      process.kill(ad.pid, 'SIGTERM');
    } catch {
      /* raced to death — fine */
    }
    await sleep(200);
  }
}

/** Spawn a detached broker daemon and poll until it advertises itself. */
async function spawnBroker(): Promise<BrokerAdvertisement> {
  const spawnedAfter = Date.now() - 1_000; // small clock slop
  const child = spawn(process.execPath, [selfBundlePath(), '__broker'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  const deadline = Date.now() + SPAWN_DEADLINE_MS;
  while (Date.now() < deadline) {
    const ad = readAdvertisement();
    // Accept our child OR a concurrent winner (two CLIs racing to spawn).
    if (ad && isPidAlive(ad.pid) && ad.lastSeen >= spawnedAfter) return ad;
    await sleep(SPAWN_POLL_MS);
  }
  throw new CliError('E_NO_BROKER', 'broker did not start within 5s (see /tmp/figma-agent-broker.log)');
}

/**
 * Ensure a healthy broker is running and return its advertisement.
 * Replaces brokers with mismatched protocol or an older bundle build.
 */
export async function ensureBroker(): Promise<BrokerAdvertisement> {
  const myMtime = selfBuildMtime();
  const ad = readAdvertisement();
  if (ad && isAdvertisementLive(ad)) {
    const outdatedBuild = myMtime - ad.buildMtime > 1; // 1ms float tolerance
    if (ad.protocolV === PROTOCOL_VERSION && !outdatedBuild) return ad;
    await requestBrokerShutdown(ad); // stale build / protocol → replace
  } else if (ad && (await probeStaleButAlive(ad))) {
    // Heartbeat looked stale but a handshake proves it is still serving —
    // reuse it instead of spawning a second broker on top of a live one.
    return ad;
  }
  return spawnBroker();
}
