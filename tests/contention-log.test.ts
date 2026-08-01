// Durable per-file/per-day contention counter — fs layer for the broker. Mirrors
// error-log.test.ts's shape (tmpdir + FIGMA_AGENT_CHANGES_DIR override), but this store
// is a single keyed JSON object (a running total), not an append-only JSONL log — so
// these tests exercise accumulation + retention pruning instead of append-only growth.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONTENTION_LOG_FILENAME, CONTENTION_RETENTION_DAYS,
  addQueued, contentionLogPath, contentionLogPathFor, readContentionStore, utcDayKey,
} from '../cli/src/transport/contention-log.ts';

let dir: string;
const prevEnv = process.env['FIGMA_AGENT_CHANGES_DIR'];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fa-contention-log-'));
  process.env['FIGMA_AGENT_CHANGES_DIR'] = dir;
});
afterEach(() => {
  if (prevEnv === undefined) delete process.env['FIGMA_AGENT_CHANGES_DIR'];
  else process.env['FIGMA_AGENT_CHANGES_DIR'] = prevEnv;
  rmSync(dir, { recursive: true, force: true });
});

const DAY_MS = 24 * 60 * 60 * 1000;
// A fixed, deterministic UTC instant — noon, so a ±1 day nudge never crosses a
// calendar-day boundary by accident.
const T0 = Date.UTC(2026, 0, 15, 12, 0, 0);

describe('contentionLogPath / contentionLogPathFor', () => {
  it('the default lives at <changeLogDir()>/figma-contention.json', () => {
    expect(contentionLogPath()).toBe(join(dir, CONTENTION_LOG_FILENAME));
  });

  it('the explicit-project variant is rooted at <projectDir>/design, not the broker cwd', () => {
    expect(contentionLogPathFor('/tmp/some-project')).toBe(join('/tmp/some-project', 'design', CONTENTION_LOG_FILENAME));
  });
});

describe('readContentionStore', () => {
  it('a missing file reads as empty, not an error', () => {
    expect(readContentionStore(join(dir, 'nope.json'))).toEqual({});
  });

  it('a corrupt (non-JSON) file reads as empty rather than throwing', () => {
    const path = join(dir, 'bad.json');
    writeFileSync(path, 'NOT JSON', 'utf8');
    expect(readContentionStore(path)).toEqual({});
  });

  it('a shape-invalid entry is dropped, a valid sibling entry survives', () => {
    const path = join(dir, 'mixed.json');
    writeFileSync(path, JSON.stringify({
      'good-file': { '2026-01-01': { totalQueuedMs: 500, jobCount: 2 } },
      'bad-file': { '2026-01-01': { totalQueuedMs: 'not a number', jobCount: 1 } },
    }), 'utf8');
    expect(readContentionStore(path)).toEqual({
      'good-file': { '2026-01-01': { totalQueuedMs: 500, jobCount: 2 } },
    });
  });
});

describe('addQueued — accumulation', () => {
  it('two calls for the SAME file/day sum totalQueuedMs and increment jobCount', () => {
    const path = contentionLogPath();
    addQueued(path, 'vsf-pcp', 100, T0);
    addQueued(path, 'vsf-pcp', 250, T0 + 1000); // same UTC day, a second later
    const store = readContentionStore(path);
    expect(store['vsf-pcp']?.[utcDayKey(T0)]).toEqual({ totalQueuedMs: 350, jobCount: 2 });
  });

  it('a DIFFERENT UTC day is a separate bucket for the same file', () => {
    const path = contentionLogPath();
    addQueued(path, 'vsf-pcp', 100, T0);
    addQueued(path, 'vsf-pcp', 200, T0 + DAY_MS);
    const store = readContentionStore(path);
    const days = store['vsf-pcp']!;
    expect(Object.keys(days).sort()).toEqual([utcDayKey(T0), utcDayKey(T0 + DAY_MS)]);
    expect(days[utcDayKey(T0)]).toEqual({ totalQueuedMs: 100, jobCount: 1 });
    expect(days[utcDayKey(T0 + DAY_MS)]).toEqual({ totalQueuedMs: 200, jobCount: 1 });
  });

  it('a DIFFERENT file gets its OWN bucket, never merged with another file\'s', () => {
    const path = contentionLogPath();
    addQueued(path, 'file-a', 100, T0);
    addQueued(path, 'file-b', 900, T0);
    const store = readContentionStore(path);
    expect(store['file-a']?.[utcDayKey(T0)]?.totalQueuedMs).toBe(100);
    expect(store['file-b']?.[utcDayKey(T0)]?.totalQueuedMs).toBe(900);
  });

  it('creates the file (and its parent dir) on the very first call', () => {
    const path = join(dir, 'nested', 'figma-contention.json');
    addQueued(path, 'vsf-pcp', 42, T0);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      'vsf-pcp': { [utcDayKey(T0)]: { totalQueuedMs: 42, jobCount: 1 } },
    });
  });
});

describe('addQueued — retention pruning', () => {
  it('a day older than the retention window is dropped the next time that file is written', () => {
    const path = contentionLogPath();
    const oldDay = T0;
    const newDay = T0 + (CONTENTION_RETENTION_DAYS + 1) * DAY_MS; // just past the window
    addQueued(path, 'vsf-pcp', 100, oldDay);
    expect(readContentionStore(path)['vsf-pcp']?.[utcDayKey(oldDay)]).toBeDefined();

    addQueued(path, 'vsf-pcp', 50, newDay); // triggers pruning for THIS file's bucket
    const days = readContentionStore(path)['vsf-pcp']!;
    expect(days[utcDayKey(oldDay)]).toBeUndefined();
    expect(days[utcDayKey(newDay)]).toEqual({ totalQueuedMs: 50, jobCount: 1 });
  });

  it('a day exactly at the retention boundary is kept, one day past it is dropped', () => {
    const path = contentionLogPath();
    const boundaryDay = T0; // exactly CONTENTION_RETENTION_DAYS before `today` below
    const today = T0 + CONTENTION_RETENTION_DAYS * DAY_MS;
    addQueued(path, 'vsf-pcp', 10, boundaryDay);
    addQueued(path, 'vsf-pcp', 20, today);
    const days = readContentionStore(path)['vsf-pcp']!;
    expect(days[utcDayKey(boundaryDay)]).toEqual({ totalQueuedMs: 10, jobCount: 1 });
    expect(days[utcDayKey(today)]).toEqual({ totalQueuedMs: 20, jobCount: 1 });
  });

  it('pruning one file\'s bucket never touches another file\'s untouched bucket', () => {
    const path = contentionLogPath();
    const oldDay = T0;
    const newDay = T0 + (CONTENTION_RETENTION_DAYS + 1) * DAY_MS;
    addQueued(path, 'file-a', 100, oldDay);
    addQueued(path, 'file-b', 100, oldDay);
    addQueued(path, 'file-a', 50, newDay); // only file-a is written again
    const store = readContentionStore(path);
    expect(store['file-a']?.[utcDayKey(oldDay)]).toBeUndefined(); // pruned
    expect(store['file-b']?.[utcDayKey(oldDay)]).toEqual({ totalQueuedMs: 100, jobCount: 1 }); // untouched, still there
  });
});
