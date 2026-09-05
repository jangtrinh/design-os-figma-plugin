// Figma live-sync apply orchestration (spec 004 P4 + spec 005 P4) — the broker's
// SYNC_REQUEST handler.
//
// The panel's "Sync now" click reaches the broker as SYNC_REQUEST; the broker runs the
// DETERMINISTIC kernel to commit — `ui figma reconcile --apply` — rather than touching the
// registry itself. Keeping apply in `ui` is the whole point: the broker stays a relay; all
// registry-write logic lives in the tested, pure kernel.
//
// Spec 005 P4 makes it a three-step chain, because a 1:1 mirror needs live data the kernel
// is forbidden to fetch (Art I.2):
//   1. `ui figma reconcile --dry-run --json` → which components changed, with their nodeIds
//   2. `figma-agent scan-node <id>` per component → their node specs → a capture file
//   3. `ui figma reconcile --apply --mirror-file <file> --json` → sidecars + registry
// Step 2 is the ONLY live step and lives in figma-mirror-capture-run.ts. If it yields
// nothing (plugin down, scan failed), step 3 still runs and reports what did not mirror.
//
// Best-effort + debounced: a spawn failure (no `ui` on PATH) is reported back, never
// thrown; a second click while one apply is in flight is ignored (broker-daemon).
import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  countsFromApplyReport,
  emptyCounts,
  landed,
  syncSummary,
  type AppliedCounts,
} from '../../../shared/figma-sync-summary.ts';
import {
  captureMirror, mergeTargetsPendingFirst, pendingTargetsFromEnvelope, targetsFromDelta,
} from './figma-mirror-capture-run.ts';
import {
  RECONCILE_CHILD_BOUNDS,
  runBoundedChild,
  type ChildBounds,
  type ChildOutcome,
} from './bounded-child-process.ts';

interface SyncApplyEvidence {
  phase: 'dry' | 'apply';
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdoutBytes: number;
  stdoutTruncated: boolean;
  stderrBytes: number;
  stderrTruncated: boolean;
  stderrExcerpt?: string;
  envelopeParsed: boolean;
  capturePath?: string;
  captureCleanupError?: string;
}

/** Outcome the broker sends back to the plugin as SYNC_RESULT.data. */
export interface SyncApplyResult {
  ok: boolean;
  /** One honest line for the panel — what changed in the registry, or why nothing did. */
  summary: string;
  /** False ⇒ the apply ran but no record changed; the panel must not claim "Synced". */
  landed?: boolean;
  /** The kernel's apply report when it succeeded. */
  applied?: unknown;
  code?: string;
  /** Present only when a child started but direct-process exit was never confirmed. */
  childExited?: false;
  evidence?: SyncApplyEvidence;
}

/** Resolve the `ui` kernel binary — env override (tests) → PATH lookup by name. */
function uiBin(): string {
  return process.env['FIGMA_AGENT_UI_BIN'] || process.env['DESIGN_OS_UI_BIN'] || 'ui';
}

/** Run `ui figma reconcile …` and hand back the parsed envelope. Never throws. */
function runReconcile(
  projectDir: string,
  extra: string[],
  bounds: Readonly<ChildBounds>,
  done: (env: Record<string, unknown> | null, outcome: ChildOutcome) => void,
): void {
  runBoundedChild(
    uiBin(), ['figma', 'reconcile', '--dir', projectDir, '--json', ...extra],
    { cwd: projectDir, bounds }, (outcome) => {
      let env: Record<string, unknown> | null = null;
      try {
        const parsed = JSON.parse(outcome.stdout.trim());
        if (parsed && typeof parsed === 'object') env = parsed as Record<string, unknown>;
      } catch { /* non-JSON stdout — the exit-code path below reports it */ }
      done(env, outcome);
    },
  );
}

function evidence(
  phase: 'dry' | 'apply', outcome: ChildOutcome, env: Record<string, unknown> | null,
  capturePath?: string, captureCleanupError?: string,
): SyncApplyEvidence {
  return {
    phase, exitCode: outcome.exitCode, signal: outcome.signal, timedOut: outcome.timedOut,
    stdoutBytes: outcome.stdoutBytes, stdoutTruncated: outcome.stdoutTruncated,
    stderrBytes: outcome.stderrBytes, stderrTruncated: outcome.stderrTruncated,
    ...(outcome.stderr ? { stderrExcerpt: outcome.stderr } : {}),
    envelopeParsed: env !== null, ...(capturePath ? { capturePath } : {}),
    ...(captureCleanupError ? { captureCleanupError } : {}),
  };
}

function failure(
  phase: 'dry' | 'apply', outcome: ChildOutcome, env: Record<string, unknown> | null,
  capturePath?: string,
): SyncApplyResult | null {
  const meta = evidence(phase, outcome, env, capturePath);
  const suffix = capturePath ? ` Capture kept for inspection: ${capturePath}.` : '';
  if (outcome.spawned && !outcome.exited) {
    return { ok: false, code: 'RECONCILE_CHILD_UNKILLABLE', childExited: false, evidence: meta,
      summary: `ui reconcile child exit not confirmed after SIGKILL.${suffix}` };
  }
  if (!outcome.spawned) {
    const detail = outcome.launchError ?? 'unknown launch failure';
    const summary = outcome.launchErrorKind === 'throw'
      ? `could not launch ui: ${detail}`
      : `ui not runnable: ${detail} (is the kernel linked?)`;
    return { ok: false, summary, code: 'RECONCILE_FAILED', evidence: meta };
  }
  if (outcome.timedOut) {
    if (phase === 'dry') return { ok: false, code: 'RECONCILE_DRY_TIMEOUT', evidence: meta, summary: 'reconcile preview timed out; apply was not started' };
    return { ok: false, code: 'RECONCILE_OUTCOME_UNKNOWN', evidence: meta,
      summary: `apply outcome unknown after timeout; verify with ui figma reconcile --dry-run before retrying.${suffix}` };
  }
  if (outcome.stdoutTruncated) {
    if (phase === 'dry') return { ok: false, code: 'RECONCILE_DRY_OUTPUT_OVERFLOW', evidence: meta, summary: 'reconcile preview output exceeded the bounded stdout limit; apply was not started' };
    return { ok: false, code: 'RECONCILE_OUTCOME_UNKNOWN', evidence: meta,
      summary: `apply outcome unknown because stdout exceeded the bounded limit; verify with ui figma reconcile --dry-run before retrying.${suffix}` };
  }
  if (env && env['ok'] === false && env['error'] && typeof env['error'] === 'object') {
    const e = env['error'] as { code?: unknown; message?: unknown };
    return { ok: false, summary: `${String(e.message ?? 'reconcile failed')}${suffix}`, code: String(e.code ?? 'RECONCILE_FAILED'), evidence: meta };
  }
  if (outcome.signal !== null || outcome.exitCode !== 0) {
    const ended = outcome.signal !== null ? `ui killed by ${outcome.signal}` : `ui exited ${outcome.exitCode}`;
    if (phase === 'dry') return { ok: false, summary: outcome.stderr.trim() || ended, code: 'RECONCILE_FAILED', evidence: meta };
    return { ok: false, code: 'RECONCILE_OUTCOME_UNKNOWN', evidence: meta,
      summary: `apply outcome unknown: ${ended}; verify with ui figma reconcile --dry-run before retrying.${suffix}` };
  }
  if (envelopeData(env) === null) {
    if (phase === 'dry') return { ok: false, summary: outcome.stderr.trim() || 'ui exited 0', code: 'RECONCILE_FAILED', evidence: meta };
    return { ok: false, code: 'RECONCILE_OUTCOME_UNKNOWN', evidence: meta,
      summary: `apply outcome unknown: ui exited 0 without a valid success envelope; verify with ui figma reconcile --dry-run before retrying.${suffix}` };
  }
  return null;
}

function envelopeData(env: Record<string, unknown> | null): Record<string, unknown> | null {
  if (env && env['ok'] === true && env['data'] && typeof env['data'] === 'object') {
    return env['data'] as Record<string, unknown>;
  }
  return null;
}

/**
 * Run the full sync: preview → scoped mirror capture → apply. `done` always receives a
 * result; every failure path degrades rather than throwing.
 *
 * `fileSlug`/`fileName` (registry-integrity phase 03, §2) — the bound file's own identity
 * (`project-bind.ts`'s `fileIdentity`, the SAME chain the broker already uses to resolve
 * `bound`). `fileSlug` narrows both kernel calls to that file's own targets in a shared
 * change-log (`--file-slug`); `fileName` pins the live scan to that same plugin instance
 * (`--file`, via `captureMirror`). Undefined for a caller with no bound-file identity yet
 * — preserves today's whole-log, unfiltered behaviour exactly.
 */
export function spawnReconcileApply(
  projectDir: string,
  fileSlug: string | undefined,
  fileName: string | undefined,
  done: (r: SyncApplyResult) => void,
  bounds: Readonly<ChildBounds> = RECONCILE_CHILD_BOUNDS,
): void {
  let settled = false;
  const finish = (result: SyncApplyResult): void => {
    if (settled) return;
    settled = true;
    done(result);
  };
  const fileSlugArgs = fileSlug !== undefined ? ['--file-slug', fileSlug] : [];
  runReconcile(projectDir, ['--dry-run', ...fileSlugArgs], bounds, (env, outcome) => {
    const dryFailure = failure('dry', outcome, env);
    if (dryFailure) { finish(dryFailure); return; }
    const data = envelopeData(env)!;
    // Registry-integrity phase 02 (5.3), §4: the kernel's retry queue (`pending`) is
    // captured FIRST, or the same MAX_SCANS names win every run and the queue never
    // drains. Read from the SAME dry-run envelope `targetsFromDelta` already reads.
    const pendingFirst = pendingTargetsFromEnvelope(data);
    const targets = mergeTargetsPendingFirst(pendingFirst, targetsFromDelta(data));
    void Promise.resolve().then(() => captureMirror(targets, fileName)).then((cap) => {
      const extra = ['--apply', ...fileSlugArgs, ...(cap.file !== undefined ? ['--mirror-file', cap.file] : [])];
      runReconcile(projectDir, extra, bounds, (aEnv, aOutcome) => {
        const retainedPath = cap.file !== undefined && aOutcome.spawned ? cap.file : undefined;
        const applyFailure = failure('apply', aOutcome, aEnv, retainedPath);
        if (applyFailure) {
          if (cap.file !== undefined && !aOutcome.spawned) {
            const cleanupError = removeCapture(cap.file);
            if (cleanupError) {
              finish({
                ...applyFailure,
                summary: `${applyFailure.summary} Capture cleanup failed; kept for inspection: ${cap.file}.`,
                evidence: evidence('apply', aOutcome, aEnv, cap.file, cleanupError),
              });
              return;
            }
          }
          finish(applyFailure);
          return;
        }
        const aData = envelopeData(aEnv)!;
        const result = applyResult(aData['apply'], cap.dropped);
        const cleanupError = cap.file !== undefined ? removeCapture(cap.file) : undefined;
        finish({
          ...result,
          ...(cleanupError ? { summary: `${result.summary} — capture cleanup failed; kept for inspection: ${cap.file}` } : {}),
          evidence: evidence('apply', aOutcome, aEnv, cleanupError ? cap.file : undefined, cleanupError),
        });
      });
    }).catch((error: unknown) => finish({
      ok: false, code: 'RECONCILE_CAPTURE_FAILED',
      summary: `could not prepare mirror capture: ${(error as Error).message}`,
    }));
  });
}

function removeCapture(file: string): string | undefined {
  try {
    rmSync(dirname(file), { recursive: true, force: true });
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

/** Shape the panel-facing result from the kernel's apply report. */
export function applyResult(apply: unknown, dropped = 0): SyncApplyResult {
  const counts: AppliedCounts = apply === undefined ? emptyCounts() : countsFromApplyReport(apply);
  const summary = dropped > 0 ? `${syncSummary(counts)} — ${dropped} not scanned (batch cap)` : syncSummary(counts);
  return { ok: true, summary, landed: landed(counts) > 0, applied: apply };
}
