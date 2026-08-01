// `figma-agent contention` — the agent's read path over the durable per-file contention
// counter (`design/figma-contention.json`, contention-log.ts). This is the evidence the
// locked decision to revisit finer-than-per-file locking depends on ("only when queuedMs
// measures > 5 min/day for real" — job-table.ts's own decision-6 note): the job table
// alone cannot answer that question, because its finished records are capped and TTL'd
// (job-table.ts) long before a day's total could accumulate. This command's output IS
// the measurement that trigger needs.
//
//   figma-agent contention [--file <name>] [--since <days>]
//
// Pure fs read, no broker round-trip — works even with the plugin closed, same contract
// as `changes`/`errors`. Unlike `changes` (one feed file per project file), the store is
// one shared JSON object keyed by every file's own slug, so `--file` FILTERS entries
// (case-insensitive substring against the raw fileSlug key) rather than picking a file on
// disk — the same shape as `errors`' own `--file`.
import type { CommandArgs } from '../figma-agent.ts';
import { CliError } from '../transport/protocol-helpers.ts';
import { contentionLogPath, readContentionStore, type ContentionStore } from '../transport/contention-log.ts';

export interface ContentionRow {
  fileSlug: string;
  day: string;
  totalQueuedMs: number;
  jobCount: number;
}

export interface ContentionFilter {
  file?: string;
  /** Only days within the last N UTC calendar days, inclusive of today. */
  sinceDays?: number;
}

/** `--since <days>` must be a non-negative finite number — `args.num` already rejects a
 *  non-numeric string, but (same gap `changes.ts`'s `validateLimit` closed for `--limit`)
 *  lets `Infinity`/negative values through as clean numbers that would otherwise silently
 *  mean "everything" or "nothing" for a value that never legitimately meant that. */
export function validateSinceDays(n: number | undefined): number | undefined {
  if (n === undefined) return undefined;
  if (!Number.isFinite(n) || n < 0) {
    throw new CliError('E_INVALID_ARGS', `--since must be a non-negative number of days, got "${n}"`);
  }
  return n;
}

function sinceCutoffKey(sinceDays: number, now: number): string {
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - sinceDays);
  return cutoff.toISOString().slice(0, 10);
}

/** Flattens the keyed store into rows (one per file/day), optionally filtered by
 *  `--file` / `--since <days>`, newest day first within each file. */
export function flattenContention(store: ContentionStore, filter: ContentionFilter, now: number): ContentionRow[] {
  const needle = filter.file?.trim().toLowerCase();
  const cutoffKey = filter.sinceDays !== undefined ? sinceCutoffKey(filter.sinceDays, now) : undefined;
  const rows: ContentionRow[] = [];
  for (const [fileSlug, days] of Object.entries(store)) {
    if (needle !== undefined && !fileSlug.toLowerCase().includes(needle)) continue;
    for (const [day, totals] of Object.entries(days)) {
      if (cutoffKey !== undefined && day < cutoffKey) continue;
      rows.push({ fileSlug, day, totalQueuedMs: totals.totalQueuedMs, jobCount: totals.jobCount });
    }
  }
  rows.sort((a, b) => (a.fileSlug === b.fileSlug ? b.day.localeCompare(a.day) : a.fileSlug.localeCompare(b.fileSlug)));
  return rows;
}

export async function run(args: CommandArgs): Promise<unknown> {
  const file = args.str('file');
  const sinceDays = validateSinceDays(args.num('since'));

  const path = contentionLogPath();
  const store = readContentionStore(path);
  const rows = flattenContention(store, { file, sinceDays }, Date.now());
  const totalQueuedMs = rows.reduce((sum, r) => sum + r.totalQueuedMs, 0);
  const totalJobCount = rows.reduce((sum, r) => sum + r.jobCount, 0);

  return {
    // Resolved path printed for the same reason `changes`'/`errors`' own path is — a
    // cwd/broker spawn-cwd mismatch is visible, never silent.
    logPath: path,
    since: sinceDays ?? null,
    count: rows.length,
    totalQueuedMs,
    totalJobCount,
    rows,
  };
}
