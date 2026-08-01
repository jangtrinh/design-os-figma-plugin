// Durable per-file, per-UTC-day contention counter — fs layer for the broker.
//
// `job-table.ts` stamps `queuedMs` (time a mutation waited in a file's FIFO before
// dispatch) on a job record in `markRunning`/`cancelQueued`, but that record only lives
// as long as the job table keeps it: FINISHED records are capped at `JOB_FINISHED_CAP`
// and evicted after `JOB_TTL_MS` (job-table.ts). A per-file daily total built only from
// that table can therefore never accumulate long enough to answer the locked decision
// to revisit finer-than-per-file locking ("only when queuedMs measures > 5 min/day for
// real" — job-table.ts's own decision-6 note). This store is that daily total's durable
// home: it is never evicted on the job table's TTL/cap schedule, only pruned by its own
// retention window below.
//
// A deliberate near-copy of error-log.ts's path handling (broker-cwd-independent base +
// explicit-project routing), but a different SHAPE: a single JSON object (a running
// total per file/day), not an append-only JSONL event log — an event log of every job
// that ever finished would grow forever for no benefit this counter needs. Keyed by the
// SAME file-slug identity every other durable feed uses (file-identity.ts), via the
// `fileSlug` job records already carry.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { changeLogDir } from './change-log.ts';

export const CONTENTION_LOG_FILENAME = 'figma-contention.json';

/** Days of history kept per file, pruned on every write to that file's bucket —
 *  deterministic by UTC calendar date, never a silent drop: a day this far in the past
 *  no longer bears on "does queuedMs exceed 5 min/day", so it is dropped on the next
 *  write to that file, not archived or counted (Law 1 is satisfied by this comment
 *  stating the rule, the same way the other durable feeds' rotation policy is a stated
 *  size, not a counted event). */
export const CONTENTION_RETENTION_DAYS = 30;

/** `<changeLogDir()>/figma-contention.json` — shares changeLogDir()'s
 *  `FIGMA_AGENT_CHANGES_DIR` override, same base as the change/edit/error logs. This is
 *  the broker-cwd default, used when no project binding resolves for a job's fileSlug
 *  (mirrors error-log.ts's `errorLogPath`). */
export function contentionLogPath(): string {
  return join(changeLogDir(), CONTENTION_LOG_FILENAME);
}

/** The SAME filename, rooted at an explicit project dir instead of the broker's cwd
 *  (mirrors error-log.ts's `errorLogPathFor` / edit-feed-log.ts's
 *  `editFeedPathForIdentity`). */
export function contentionLogPathFor(projectDir: string): string {
  return join(projectDir, 'design', CONTENTION_LOG_FILENAME);
}

/** One UTC calendar day's tally for one file. */
export interface ContentionDayTotals {
  totalQueuedMs: number;
  jobCount: number;
}

/** `{ [fileSlug]: { [YYYY-MM-DD]: ContentionDayTotals } }` — the whole store, small by
 *  construction (one entry per file per day, bounded by `CONTENTION_RETENTION_DAYS`). */
export type ContentionStore = Record<string, Record<string, ContentionDayTotals>>;

/** UTC calendar-day key, `YYYY-MM-DD`. `now` is always passed in by the caller (the
 *  daemon has it) — this module never calls `Date.now()` itself, so every accumulation
 *  and retention decision below is exercised deterministically by tests. */
export function utcDayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isValidDayTotals(v: unknown): v is ContentionDayTotals {
  if (!isPlainObject(v)) return false;
  return typeof v.totalQueuedMs === 'number' && Number.isFinite(v.totalQueuedMs) &&
    typeof v.jobCount === 'number' && Number.isFinite(v.jobCount);
}

/**
 * Shape-guards a raw parsed JSON blob into a valid `ContentionStore`, dropping anything
 * that does not match rather than throwing — same reasoning as error-log.ts's
 * `isValidErrorLogFrame` gate: a corrupt or partially-written file must never crash the
 * broker's write path or the reader command, it just degrades to "nothing recorded yet"
 * for the malformed slice.
 */
function sanitizeStore(raw: unknown): ContentionStore {
  const store: ContentionStore = {};
  if (!isPlainObject(raw)) return store;
  for (const [fileSlug, days] of Object.entries(raw)) {
    if (!isPlainObject(days)) continue;
    const cleanDays: Record<string, ContentionDayTotals> = {};
    for (const [day, totals] of Object.entries(days)) {
      if (isValidDayTotals(totals)) cleanDays[day] = totals;
    }
    if (Object.keys(cleanDays).length > 0) store[fileSlug] = cleanDays;
  }
  return store;
}

/** Reads the store at `path`. A missing file reads as empty — no job has ever finished
 *  yet, not an error (same contract as error-log.ts/errors.ts's `readErrorLog`). A
 *  corrupt file also reads as empty rather than throwing (see `sanitizeStore`); the next
 *  write starts a fresh store instead of ever blocking the relay on a bad read. */
export function readContentionStore(path: string): ContentionStore {
  if (!existsSync(path)) return {};
  try {
    return sanitizeStore(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return {};
  }
}

/** Drops any day older than `CONTENTION_RETENTION_DAYS` before `today` (a `YYYY-MM-DD`
 *  key), for one file's own day-bucket. */
function pruneFileDays(days: Record<string, ContentionDayTotals>, today: string): Record<string, ContentionDayTotals> {
  const cutoff = new Date(today);
  cutoff.setUTCDate(cutoff.getUTCDate() - CONTENTION_RETENTION_DAYS);
  const cutoffKey = cutoff.toISOString().slice(0, 10);
  const pruned: Record<string, ContentionDayTotals> = {};
  for (const [day, totals] of Object.entries(days)) {
    if (day >= cutoffKey) pruned[day] = totals;
  }
  return pruned;
}

/** Parent dir of a file path (mirrors change-log.ts's / error-log.ts's private helper —
 *  kept separate per the "near-copy, deliberately separate" contract those already
 *  state, rather than sharing a util that would couple the log layers). */
function resolveDir(filePath: string): string {
  const idx = filePath.lastIndexOf('/');
  return idx <= 0 ? filePath : filePath.slice(0, idx);
}

/**
 * Write-through: add one finished job's `queuedMs` to its file's today bucket (UTC),
 * creating the `design/` dir and the store file as needed, then prune that file's own
 * day-bucket down to the retention window. Read-modify-write of the whole (small,
 * pruned) JSON file — this is a low-frequency accumulator (one call per finished job,
 * never a hot path), so a full rewrite per call is the KISS choice over a partial-update
 * scheme. Safe against interleaving with itself: every call site in the daemon is
 * synchronous end-to-end (no `await` between the read and the write), and Node's single
 * threaded event loop cannot interleave two synchronous call stacks.
 */
export function addQueued(path: string, fileSlug: string, queuedMs: number, now: number): void {
  const store = readContentionStore(path);
  const today = utcDayKey(now);
  const fileDays = store[fileSlug] ?? {};
  const existing = fileDays[today] ?? { totalQueuedMs: 0, jobCount: 0 };
  fileDays[today] = { totalQueuedMs: existing.totalQueuedMs + queuedMs, jobCount: existing.jobCount + 1 };
  store[fileSlug] = pruneFileDays(fileDays, today);
  mkdirSync(resolveDir(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store), 'utf8');
}
