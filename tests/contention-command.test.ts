// `figma-agent contention` — pure filtering/flattening + one full `run()` pass over a
// real fixture store (tmpdir, FIGMA_AGENT_CHANGES_DIR override — same convention as
// errors-command.test.ts).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../cli/src/arg-parse.ts';
import { flattenContention, run, validateSinceDays, type ContentionRow } from '../cli/src/commands/contention.ts';
import { CONTENTION_LOG_FILENAME, type ContentionStore } from '../cli/src/transport/contention-log.ts';
import { CliError } from '../cli/src/transport/protocol-helpers.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

const FIXTURE: ContentionStore = {
  'vsf-pcp': {
    '2026-01-15': { totalQueuedMs: 1000, jobCount: 4 },
    '2026-01-10': { totalQueuedMs: 300, jobCount: 1 },
  },
  'platform-design-system': {
    '2026-01-14': { totalQueuedMs: 50, jobCount: 1 },
  },
};

describe('flattenContention', () => {
  it('flattens every file/day into rows, newest day first within each file', () => {
    const rows = flattenContention(FIXTURE, {}, NOW);
    expect(rows).toEqual<ContentionRow[]>([
      { fileSlug: 'platform-design-system', day: '2026-01-14', totalQueuedMs: 50, jobCount: 1 },
      { fileSlug: 'vsf-pcp', day: '2026-01-15', totalQueuedMs: 1000, jobCount: 4 },
      { fileSlug: 'vsf-pcp', day: '2026-01-10', totalQueuedMs: 300, jobCount: 1 },
    ]);
  });

  it('--file filters by a case-insensitive substring against the raw fileSlug', () => {
    const rows = flattenContention(FIXTURE, { file: 'VSF' }, NOW);
    expect(rows.map((r) => r.fileSlug)).toEqual(['vsf-pcp', 'vsf-pcp']);
  });

  it('--since <days> keeps only days within the last N UTC calendar days, inclusive of today', () => {
    const rows = flattenContention(FIXTURE, { sinceDays: 1 }, NOW); // today + yesterday only
    expect(rows.map((r) => r.day)).toEqual(['2026-01-14', '2026-01-15']);
  });

  it('--file and --since compose', () => {
    const rows = flattenContention(FIXTURE, { file: 'vsf', sinceDays: 1 }, NOW);
    expect(rows).toEqual<ContentionRow[]>([
      { fileSlug: 'vsf-pcp', day: '2026-01-15', totalQueuedMs: 1000, jobCount: 4 },
    ]);
  });

  it('an unmatched --file yields an empty result, never throws', () => {
    expect(flattenContention(FIXTURE, { file: 'nope' }, NOW)).toEqual([]);
  });
});

describe('validateSinceDays', () => {
  it('undefined passes through', () => {
    expect(validateSinceDays(undefined)).toBeUndefined();
  });

  it('rejects a negative value', () => {
    expect(() => validateSinceDays(-1)).toThrow(CliError);
  });

  it('rejects a non-finite value (Infinity)', () => {
    expect(() => validateSinceDays(Number.POSITIVE_INFINITY)).toThrow(CliError);
  });

  it('accepts zero and positive finite values', () => {
    expect(validateSinceDays(0)).toBe(0);
    expect(validateSinceDays(7)).toBe(7);
  });
});

describe('run — full envelope over a real fixture store', () => {
  let dir: string;
  const prevEnv = process.env['FIGMA_AGENT_CHANGES_DIR'];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fa-contention-run-'));
    process.env['FIGMA_AGENT_CHANGES_DIR'] = dir;
    writeFileSync(join(dir, CONTENTION_LOG_FILENAME), JSON.stringify(FIXTURE), 'utf8');
  });
  afterEach(() => {
    if (prevEnv === undefined) delete process.env['FIGMA_AGENT_CHANGES_DIR'];
    else process.env['FIGMA_AGENT_CHANGES_DIR'] = prevEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads the store, reports totals + every row', async () => {
    const out = await run(parseArgs([])) as {
      logPath: string; since: number | null; count: number; totalQueuedMs: number; totalJobCount: number; rows: ContentionRow[];
    };
    expect(out.logPath).toContain(CONTENTION_LOG_FILENAME);
    expect(out.since).toBeNull();
    expect(out.count).toBe(3);
    expect(out.totalQueuedMs).toBe(1000 + 300 + 50);
    expect(out.totalJobCount).toBe(4 + 1 + 1);
    expect(out.rows).toHaveLength(3);
  });

  it('--file filters by fileSlug', async () => {
    const out = await run(parseArgs(['--file', 'platform'])) as { rows: ContentionRow[]; count: number };
    expect(out.count).toBe(1);
    expect(out.rows[0]!.fileSlug).toBe('platform-design-system');
  });

  it('--since <days> limits to the last N days (relative to real Date.now — a wide window keeps a 2026 fixture)', async () => {
    const out = await run(parseArgs(['--since', '36500'])) as { rows: ContentionRow[]; count: number };
    expect(out.count).toBe(3);
  });

  it('--since 0 excludes every day before real today', async () => {
    const out = await run(parseArgs(['--since', '0'])) as { rows: ContentionRow[]; count: number };
    expect(out.count).toBe(0); // the fixture's fixed 2026-01 dates are all before the real "today"
  });

  it('rejects a negative --since', async () => {
    await expect(run(parseArgs(['--since', '-1']))).rejects.toThrow(CliError);
  });

  it('a missing store file reads as empty, never throws', async () => {
    rmSync(join(dir, CONTENTION_LOG_FILENAME));
    const out = await run(parseArgs([])) as { count: number; rows: ContentionRow[] };
    expect(out.count).toBe(0);
    expect(out.rows).toEqual([]);
  });
});
