// Broker hardening (issue #5), item 1 — advertisement writes must be atomic
// (temp file + renameSync), never a truncate-then-write `writeFileSync` straight
// onto the shared /tmp/figma-agent-broker.json. A truncating write leaves a window
// where every 30s heartbeat (and every concurrent `figma-agent status`/`ensureBroker`
// read racing it) can observe an empty or partial file — readAdvertisement's
// JSON.parse turns that into "no broker", which the orphan-avoidance logic in
// ensureBroker()/runCommand() reads as "advertisement lied", spawning or tearing
// down a perfectly healthy broker.
//
// This test is white-box on purpose: it asserts the fs call SEQUENCE
// (exclusive open of a temp path, descriptor write, THEN rename onto the target), which is the
// only way to observe atomicity without a real concurrent-reader race. Against
// pre-fix code (a bare `writeFileSync(path, …)`), `renameSync` is never called and
// `writeFileSync` targets `path` directly — this test fails there.
//
// `node:fs`'s ESM namespace exports are not configurable (vi.spyOn can't touch
// them directly — see https://vitest.dev/guide/browser/#limitations), so the spies
// are wired through vi.mock + vi.hoisted, wrapping the real implementation rather
// than replacing it: every call still hits the real filesystem, this file just
// also records the call order and arguments.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrokerAdvertisement } from '../shared/protocol.ts';

const fsSpies = vi.hoisted(() => ({
  sequence: [] as string[],
  openSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const fd = actual.openSync(...args);
      fsSpies.sequence.push('open');
      fsSpies.openSync(...args, fd);
      return fd;
    },
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      fsSpies.sequence.push('write');
      fsSpies.writeFileSync(...args);
      return actual.writeFileSync(...args);
    },
    closeSync: (...args: Parameters<typeof actual.closeSync>) => {
      const result = actual.closeSync(...args);
      fsSpies.sequence.push('close');
      return result;
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      fsSpies.sequence.push('rename');
      fsSpies.renameSync(...args);
      return actual.renameSync(...args);
    },
  };
});

// Imported AFTER the mock is declared — vitest hoists `vi.mock` above all imports
// in the same module regardless of source position, so broker-discovery.ts's own
// `import { writeFileSync, renameSync } from 'node:fs'` resolves to the wrapped
// versions above.
const { writeAdvertisement } = await import('../cli/src/transport/broker-discovery.ts');

let scratchDir: string;
let advertisePath: string;

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'fa-advertise-atomic-'));
  advertisePath = join(scratchDir, 'broker.json');
  fsSpies.openSync.mockClear();
  fsSpies.sequence.length = 0;
  fsSpies.writeFileSync.mockClear();
  fsSpies.renameSync.mockClear();
});

afterEach(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

describe('writeAdvertisement — atomic temp-file + rename', () => {
  it('writes to a temp path and renames onto the target, never truncating it directly', () => {
    writeAdvertisement(9410, Date.now(), advertisePath);

    expect(fsSpies.writeFileSync).toHaveBeenCalledTimes(1);
    const [writtenFd] = fsSpies.writeFileSync.mock.calls[0]!;
    expect(fsSpies.openSync).toHaveBeenCalledTimes(1);
    const [writtenPath, flag, mode, openedFd] = fsSpies.openSync.mock.calls[0]!;
    expect(flag).toBe('wx');
    expect(mode).toBe(0o600);
    expect(writtenFd).toBe(openedFd);
    expect(writtenPath).not.toBe(advertisePath); // never a direct truncating write onto the real file
    expect(String(writtenPath)).toMatch(new RegExp(`^${advertisePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.\\d+\\.tmp$`));

    expect(fsSpies.renameSync).toHaveBeenCalledTimes(1);
    const [fromPath, toPath] = fsSpies.renameSync.mock.calls[0]!;
    expect(fromPath).toBe(writtenPath); // renames the SAME temp file it just wrote
    expect(toPath).toBe(advertisePath);
    expect(fsSpies.sequence).toEqual(['open', 'write', 'close', 'rename']);

    // The temp file must be gone (renamed away) — only the real target remains.
    expect(existsSync(String(writtenPath))).toBe(false);
    expect(existsSync(advertisePath)).toBe(true);
  });

  it('the final file is valid, complete JSON — never a partially-written artifact', () => {
    writeAdvertisement(9411, 12_345, advertisePath);
    const ad = JSON.parse(readFileSync(advertisePath, 'utf8')) as BrokerAdvertisement;
    expect(ad.port).toBe(9411);
    expect(ad.startedAt).toBe(12_345);
    expect(ad.pid).toBe(process.pid);
  });

  it('a temp file from an interrupted write never lingers after a clean write', () => {
    writeAdvertisement(9412, Date.now(), advertisePath);
    const leftovers = readdirSync(scratchDir).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });
});
