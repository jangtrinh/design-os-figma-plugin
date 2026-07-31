// Error log writer (backlog 4.6) — fs layer for the broker. Append-only JSONL, one line
// per `ReplyErr` the broker relays, at `design/figma-errors.jsonl` — a SIBLING of
// `figma.changes.jsonl`, not inside the wave 4.4 edit feed's `changes/` subdirectory
// (same BASE dir resolution as both — `changeLogDir()` — but its own file, its own
// shape, never mixed into either of those two logs).
//
// Issue #7 (backlog 5.9) fix: `errorLogPath()` alone used to be the ONLY write target —
// resolved once at broker startup and shared by every file/project the broker ever
// relayed for, no per-event binding resolution at all (unlike DOC_CHANGE/EDIT_FEED,
// which resolve `resolveProjectDir` fresh per message). `errorLogPathFor`/
// `unboundErrorStagingPath` below give the error log the SAME per-event, binding-aware
// routing — full parity, including staging + migrate-on-bind — because "diagnostic-only,
// lower stakes" was exactly the reasoning that let this become a bug in the first place,
// and the `figma-agent errors` reader depends on the log actually being in the right
// project (same blind-spot class 5.7 fixed for the edit feed).
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { changeLogDir, unboundStagingRoot } from './change-log.ts';
import { rotateIfNeeded } from './log-rotate.ts';
import type { CommandName, ErrorCode, ReplyErr } from '../../../shared/protocol.ts';

export const ERROR_LOG_FILENAME = 'figma-errors.jsonl';
export const ERROR_STAGING_DIRNAME = 'errors';
export const ERROR_UNBOUND_STAGING_DIRNAME = 'unbound';

/** `<changeLogDir()>/figma-errors.jsonl` — shares changeLogDir()'s
 *  `FIGMA_AGENT_CHANGES_DIR` override, same as the change log and the edit feed base.
 *  Still the CLI reader's (`figma-agent errors`) own default — unchanged by the fix
 *  below, which only concerns the BROKER's write-side routing. */
export function errorLogPath(): string {
  return join(changeLogDir(), ERROR_LOG_FILENAME);
}

/** The SAME filename, rooted at an explicit project dir instead of the broker's cwd
 *  (mirrors change-log.ts's `changeLogPathFor` / edit-feed-log.ts's
 *  `editFeedPathForIdentity`). */
export function errorLogPathFor(projectDir: string): string {
  return join(projectDir, 'design', ERROR_LOG_FILENAME);
}

/** `<unboundStagingRoot()>/errors/unbound/<slug>.jsonl` — mirrors change-log.ts's
 *  `unboundStagingPath` / edit-feed-log.ts's `unboundEditStagingPath` exactly, in this
 *  feed's OWN `errors/` sub-path so none of the three logs' staged history can ever
 *  cross-contaminate. Keyed by the SAME name-slug the other two unbound-staging paths
 *  use, for the same reason: a file connecting mid-way through its unbound life must not
 *  split its staged errors across two different keys. */
export function unboundErrorStagingPath(slug: string): string {
  return join(unboundStagingRoot(), ERROR_STAGING_DIRNAME, ERROR_UNBOUND_STAGING_DIRNAME, `${slug}.jsonl`);
}

/** One line of the error log. Append-only; no schema-version field — this is a
 *  diagnostic tail, not a contract any reconcile/reader parses strictly (the planned
 *  `figma-agent errors` reader, backlog 4.4 P2, is out of scope for this task). */
export interface ErrorLogFrame {
  ts: number;              // epoch ms, stamped by the broker at append
  cmd: CommandName | null; // null when the relaying build didn't echo it (older client)
  activity: string | null; // the CLI's intent label, when it sent one
  code: ErrorCode;
  message: string;         // FULL, untruncated — this is the one place the real reason lives
  rolledBack?: boolean;    // present only when the error payload itself carried it (EXEC_JS --undo-group)
  fileName: string | null;
  requestId: string;
}

/**
 * Stamp one relayed `ReplyErr` into a fully-formed `ErrorLogFrame` (pure). `fileName`
 * prefers the reply's own `fileContext` (the plugin's authoritative "which file actually
 * answered") and falls back to `fallbackFileName` (the routed plugin's scene fileName,
 * resolved broker-side via the registry) only when the reply carried no fileContext at
 * all — e.g. a broker-generated error (E_NO_PLUGIN) that never reached a plugin.
 */
export function buildErrorLogFrame(
  reply: ReplyErr,
  fallbackFileName: string | null,
  ts: number,
): ErrorLogFrame {
  const frame: ErrorLogFrame = {
    ts,
    cmd: reply.cmd ?? null,
    activity: typeof reply.activity === 'string' && reply.activity !== '' ? reply.activity : null,
    code: reply.error.code,
    message: typeof reply.error.message === 'string' ? reply.error.message : String(reply.error.message ?? ''),
    fileName: reply.fileContext?.fileName ?? fallbackFileName ?? null,
    requestId: reply.id,
  };
  if (reply.error.rolledBack === true) frame.rolledBack = true;
  return frame;
}

/**
 * Stage-4 fix round (M1) — the READER's own shape guard (`readErrorLog`, errors.ts):
 * a JSON-VALID but semantically-wrong line (missing `code`, a garbage `ts`) used to land
 * in `frames` unchecked — this catches it, so the reader can skip-and-count it the same
 * way a JSON.parse failure already is, never fatal, never silently admitted.
 */
export function isValidErrorLogFrame(v: unknown): v is ErrorLogFrame {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  if (typeof r.ts !== 'number' || !Number.isFinite(r.ts)) return false;
  if (r.cmd !== null && typeof r.cmd !== 'string') return false;
  if (r.activity !== null && typeof r.activity !== 'string') return false;
  if (typeof r.code !== 'string') return false;
  if (typeof r.message !== 'string') return false;
  if (r.rolledBack !== undefined && typeof r.rolledBack !== 'boolean') return false;
  if (r.fileName !== null && typeof r.fileName !== 'string') return false;
  if (typeof r.requestId !== 'string') return false;
  return true;
}

/** Append one ErrorLogFrame line, creating the design/ dir if needed.
 *
 *  Issue #7 minor fix: `rotateIfNeeded` runs after the append, same as
 *  `appendChangeFrame`/`appendEditFrame` already do — log-rotate.ts's own module header
 *  always named this as one of the three feeds its policy covers, but the call here was
 *  never actually wired, leaving this the one unbounded-growth feed of the three. */
export function appendErrorFrame(path: string, frame: ErrorLogFrame): void {
  mkdirSync(resolveDir(path), { recursive: true });
  appendFileSync(path, JSON.stringify(frame) + '\n', 'utf8');
  rotateIfNeeded(path);
}

/** Parent dir of a file path (mirrors change-log.ts's / edit-feed-log.ts's private
 *  helper — kept separate per the same "near-copy, deliberately separate" contract). */
function resolveDir(filePath: string): string {
  const idx = filePath.lastIndexOf('/');
  return idx <= 0 ? filePath : filePath.slice(0, idx);
}
