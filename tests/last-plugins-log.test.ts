// Broker-restart reconnect visibility (`last-plugins.json`) — the fs layer + pure
// filtering functions, tested without a live broker (mkdtempSync scratch dirs only, per
// this repo's own convention for fs-layer modules — see contention-log.ts's own tests).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearReconnected, filterAwaitingReconnect, lastPluginsPathFor, readLastPlugins,
  toAwaitingReconnectStatus, writeLastPluginsAtomic, type AwaitingReconnectEntry, type LastPluginRecord,
} from '../cli/src/transport/last-plugins-log.ts';

const TEN_MIN_MS = 10 * 60_000;
const THIRTY_MIN_MS = 30 * 60_000;

let scratchDir: string;

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'fa-last-plugins-'));
});

afterEach(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

describe('lastPluginsPathFor', () => {
  it('resolves beside the advertisement file, never a project dir', () => {
    expect(lastPluginsPathFor('/tmp/figma-agent-broker.json')).toBe('/tmp/last-plugins.json');
    expect(lastPluginsPathFor(join(scratchDir, 'broker.json'))).toBe(join(scratchDir, 'last-plugins.json'));
  });
});

describe('readLastPlugins', () => {
  it('a missing file reads as empty, not an error', () => {
    expect(readLastPlugins(join(scratchDir, 'nope.json'))).toEqual([]);
  });

  it('a corrupt (unparsable) file reads as empty', () => {
    const path = join(scratchDir, 'corrupt.json');
    writeLastPluginsAtomic(path, []); // create it, then corrupt it
    writeFileSync(path, '{ not json', 'utf8');
    expect(readLastPlugins(path)).toEqual([]);
  });

  it('a malformed entry is dropped, valid entries survive', () => {
    const path = join(scratchDir, 'mixed.json');
    writeFileSync(
      path,
      JSON.stringify([
        { instanceId: 'p1', fileName: 'F1', lastSeenAt: 1000 },
        { instanceId: 'p2' }, // missing lastSeenAt — invalid
        'garbage',
        { instanceId: 'p3', fileName: null, lastSeenAt: 2000 },
      ]),
      'utf8',
    );
    expect(readLastPlugins(path)).toEqual([
      { instanceId: 'p1', fileName: 'F1', lastSeenAt: 1000 },
      { instanceId: 'p3', fileName: null, lastSeenAt: 2000 },
    ]);
  });
});

describe('writeLastPluginsAtomic + readLastPlugins — round trip', () => {
  it('what is written is exactly what is read back', () => {
    const path = join(scratchDir, 'last-plugins.json');
    const records: LastPluginRecord[] = [
      { instanceId: 'p1', fileName: 'FigJam A', lastSeenAt: 5000 },
      { instanceId: 'p2', fileName: null, lastSeenAt: 6000 },
    ];
    writeLastPluginsAtomic(path, records);
    expect(existsSync(path)).toBe(true);
    expect(readLastPlugins(path)).toEqual(records);
    // No leftover temp file after a successful rename.
    expect(existsSync(`${path}.${process.pid}.tmp`)).toBe(false);
  });

  it('creates the parent directory if it does not exist yet', () => {
    const path = join(scratchDir, 'nested', 'dir', 'last-plugins.json');
    writeLastPluginsAtomic(path, [{ instanceId: 'p1', fileName: 'F', lastSeenAt: 1 }]);
    expect(readFileSync(path, 'utf8')).toContain('p1');
  });

  it('a later write fully replaces the earlier snapshot (no accumulation)', () => {
    const path = join(scratchDir, 'last-plugins.json');
    writeLastPluginsAtomic(path, [{ instanceId: 'p1', fileName: 'F1', lastSeenAt: 1 }]);
    writeLastPluginsAtomic(path, [{ instanceId: 'p2', fileName: 'F2', lastSeenAt: 2 }]);
    expect(readLastPlugins(path)).toEqual([{ instanceId: 'p2', fileName: 'F2', lastSeenAt: 2 }]);
  });
});

describe('filterAwaitingReconnect — test 1 (round-trip threshold)', () => {
  it('a plugin last seen recently (< 10 min before start) is held; a stale one (>= 10 min) is not', () => {
    const startedAt = 1_000_000;
    const records: LastPluginRecord[] = [
      { instanceId: 'recent', fileName: 'Recent File', lastSeenAt: startedAt - 60_000 }, // 1 min before
      { instanceId: 'boundary', fileName: 'Boundary File', lastSeenAt: startedAt - (TEN_MIN_MS - 1) }, // just inside
      { instanceId: 'stale', fileName: 'Stale File', lastSeenAt: startedAt - TEN_MIN_MS }, // exactly at threshold — excluded
      { instanceId: 'very-stale', fileName: 'Very Stale File', lastSeenAt: startedAt - (TEN_MIN_MS + 60_000) },
    ];
    const held = filterAwaitingReconnect(records, startedAt, TEN_MIN_MS);
    expect(held.map((e) => e.instanceId).sort()).toEqual(['boundary', 'recent']);
  });

  it('an empty persisted set holds nothing', () => {
    expect(filterAwaitingReconnect([], 1_000_000, TEN_MIN_MS)).toEqual([]);
  });
});

describe('clearReconnected — test 2 (clear-on-reconnect)', () => {
  const entries: AwaitingReconnectEntry[] = [
    { instanceId: 'old-inst-a', fileName: 'File A', lastSeenAt: 100 },
    { instanceId: 'old-inst-b', fileName: 'File B', lastSeenAt: 200 },
  ];

  it('clears by instanceId when it matches directly', () => {
    const result = clearReconnected(entries, 'old-inst-a', 'File A');
    expect(result).toEqual([{ instanceId: 'old-inst-b', fileName: 'File B', lastSeenAt: 200 }]);
  });

  it('falls back to fileName when the instanceId is a FRESH one (iframe reload mints a new id)', () => {
    const result = clearReconnected(entries, 'brand-new-instance-id', 'File A');
    expect(result).toEqual([{ instanceId: 'old-inst-b', fileName: 'File B', lastSeenAt: 200 }]);
  });

  it('a fileName of null never matches by fallback (no accidental mass-clear of unnamed files)', () => {
    const withUnnamed: AwaitingReconnectEntry[] = [
      { instanceId: 'inst-unnamed', fileName: null, lastSeenAt: 100 },
    ];
    const result = clearReconnected(withUnnamed, 'brand-new-id', null);
    expect(result).toEqual(withUnnamed); // untouched — null is never a fallback key
  });

  it('no match (different instanceId AND different fileName) leaves the list untouched', () => {
    const result = clearReconnected(entries, 'unrelated-instance', 'Unrelated File');
    expect(result).toEqual(entries);
  });

  it('is pure — never mutates the input array', () => {
    const original = [...entries];
    clearReconnected(entries, 'old-inst-a', 'File A');
    expect(entries).toEqual(original);
  });
});

describe('toAwaitingReconnectStatus — test 3 (expiry) + status shape', () => {
  const entries: AwaitingReconnectEntry[] = [
    { instanceId: 'p1', fileName: 'F1', lastSeenAt: 500 },
    { instanceId: 'p2', fileName: null, lastSeenAt: 600 },
  ];

  it('strips instanceId, renames lastSeenAt → lastSeenBeforeShutdown, while under the expiry window', () => {
    const status = toAwaitingReconnectStatus(entries, THIRTY_MIN_MS - 1, THIRTY_MIN_MS);
    expect(status).toEqual([
      { fileName: 'F1', lastSeenBeforeShutdown: 500 },
      { fileName: null, lastSeenBeforeShutdown: 600 },
    ]);
  });

  it('goes empty once uptime reaches the expiry window, even with unreconnected entries still held', () => {
    expect(toAwaitingReconnectStatus(entries, THIRTY_MIN_MS, THIRTY_MIN_MS)).toEqual([]);
    expect(toAwaitingReconnectStatus(entries, THIRTY_MIN_MS + 1, THIRTY_MIN_MS)).toEqual([]);
  });

  it('an empty entries list stays empty regardless of uptime', () => {
    expect(toAwaitingReconnectStatus([], 0, THIRTY_MIN_MS)).toEqual([]);
  });
});

describe('test 4 — awaitingReconnect is structurally distinct from a live plugins[] row', () => {
  it('the status entry shape carries no instanceId/ws-identifying field at all', () => {
    const status = toAwaitingReconnectStatus(
      [{ instanceId: 'p1', fileName: 'F1', lastSeenAt: 1 }], 0, THIRTY_MIN_MS,
    );
    expect(Object.keys(status[0]!).sort()).toEqual(['fileName', 'lastSeenBeforeShutdown']);
    expect('instanceId' in status[0]!).toBe(false);
  });
});
