// Structural guard: a test that reaches `ensureBroker` or targets the live broker's
// default filesystem path (/tmp/figma-agent-broker.json) or listening ports (9410-9419)
// would affect the developer's live broker session.
//
// Every test module gets a broker-discovery whose `ensureBroker` throws; a test that
// legitimately needs a stub declares its own `vi.mock` for the module.
import { vi } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';

vi.mock('../../cli/src/transport/broker-discovery.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../cli/src/transport/broker-discovery.ts')>();
  return {
    ...actual,
    ensureBroker: async () => {
      throw new Error('refusing to reach a real broker from a test');
    },
  };
});

// Idempotent filesystem and network guards against live broker interference
const GUARD_INSTALLED = Symbol.for('design-os.no-live-broker.guard-installed');

if (!(globalThis as Record<symbol, unknown>)[GUARD_INSTALLED]) {
  (globalThis as Record<symbol, unknown>)[GUARD_INSTALLED] = true;

  function isForbiddenBrokerPath(target: unknown): boolean {
    if (typeof target !== 'string' && !Buffer.isBuffer(target) && !(target instanceof URL)) return false;
    let p = typeof target === 'string' ? target : target.toString();
    if (p.startsWith('file://')) {
      try { p = new URL(p).pathname; } catch { return false; }
    }
    const resolved = resolve(p);
    return resolved === '/tmp/figma-agent-broker.json' || resolved === '/tmp/figma-disconnects.jsonl';
  }

  function assertAllowedPath(target: unknown): void {
    if (isForbiddenBrokerPath(target)) {
      throw new Error(`Live broker guard: refusing test filesystem access to ${String(target)}`);
    }
  }

  const origReadFileSync = fs.readFileSync;
  fs.readFileSync = function (this: unknown, ...args: Parameters<typeof origReadFileSync>) {
    assertAllowedPath(args[0]);
    return origReadFileSync.apply(this, args);
  } as typeof fs.readFileSync;

  const origWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = function (this: unknown, ...args: Parameters<typeof origWriteFileSync>) {
    assertAllowedPath(args[0]);
    return origWriteFileSync.apply(this, args);
  } as typeof fs.writeFileSync;

  const origOpenSync = fs.openSync;
  fs.openSync = function (this: unknown, ...args: Parameters<typeof origOpenSync>) {
    assertAllowedPath(args[0]);
    return origOpenSync.apply(this, args);
  } as typeof fs.openSync;

  const origUnlinkSync = fs.unlinkSync;
  fs.unlinkSync = function (this: unknown, ...args: Parameters<typeof origUnlinkSync>) {
    assertAllowedPath(args[0]);
    return origUnlinkSync.apply(this, args);
  } as typeof fs.unlinkSync;

  const origRenameSync = fs.renameSync;
  fs.renameSync = function (this: unknown, ...args: Parameters<typeof origRenameSync>) {
    assertAllowedPath(args[0]);
    assertAllowedPath(args[1]);
    return origRenameSync.apply(this, args);
  } as typeof fs.renameSync;

  const origReadFile = fs.promises.readFile;
  fs.promises.readFile = async function (this: unknown, ...args: Parameters<typeof origReadFile>) {
    assertAllowedPath(args[0]);
    return origReadFile.apply(this, args);
  } as typeof fs.promises.readFile;

  const origWriteFile = fs.promises.writeFile;
  fs.promises.writeFile = async function (this: unknown, ...args: Parameters<typeof origWriteFile>) {
    assertAllowedPath(args[0]);
    return origWriteFile.apply(this, args);
  } as typeof fs.promises.writeFile;

  syncBuiltinESMExports();

  function extractConnectPort(args: unknown[]): number | undefined {
    let first = args[0];
    if (Array.isArray(first)) first = first[0];
    if (typeof first === 'object' && first !== null) {
      const p = (first as { port?: unknown }).port;
      return typeof p === 'string' ? Number.parseInt(p, 10) : typeof p === 'number' ? p : undefined;
    }
    if (typeof first === 'number') return first;
    if (typeof first === 'string') return Number.parseInt(first, 10);
    return undefined;
  }

  const origSocketConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: Parameters<typeof origSocketConnect>) {
    const port = extractConnectPort(args as unknown[]);
    if (typeof port === 'number' && port >= 9410 && port <= 9419) {
      throw new Error(`Live broker guard: refusing test network connection to live broker port ${port}`);
    }
    return origSocketConnect.apply(this, args);
  } as typeof net.Socket.prototype.connect;
}
