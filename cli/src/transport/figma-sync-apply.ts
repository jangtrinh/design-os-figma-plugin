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
import { selectReconcileExecutable, type ReconcileExecutable } from './reconcile-executable.ts';
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
  type BoundedChildHandle,
  type ChildBounds,
  type ChildOutcome,
} from './bounded-child-process.ts';
import {
  inspectLeaseAdmission,
  readLeaseFile,
  readProcessStartToken,
  removeLeaseFile,
  writeLeaseFile,
  type ReconcileLeaseRecord,
} from './reconcile-lease.ts';

type ReconcileOutcome = ChildOutcome & ReconcileExecutable;

interface SyncApplyEvidence extends ReconcileExecutable {
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

export interface SpawnReconcileApplyOptions {
  leaseDir?: string;
  log?: (msg: string) => void;
  bounds?: Readonly<ChildBounds>;
}

export interface ReconcileApplyHandle {
  cancelForShutdown(reason?: string): void;
}

/** Run `ui figma reconcile …` and hand back the parsed envelope and bounded child handle. Never throws. */
function runReconcile(
  projectDir: string,
  extra: string[],
  bounds: Readonly<ChildBounds>,
  executable: ReconcileExecutable,
  done: (env: Record<string, unknown> | null, outcome: ReconcileOutcome) => void,
): BoundedChildHandle {
  return runBoundedChild(
    executable.uiExecutable ?? executable.uiCommand, ['figma', 'reconcile', '--dir', projectDir, '--json', ...extra],
    { cwd: projectDir, bounds }, (outcome) => {
      let env: Record<string, unknown> | null = null;
      try {
        const parsed = JSON.parse(outcome.stdout.trim());
        if (parsed && typeof parsed === 'object') env = parsed as Record<string, unknown>;
      } catch { /* non-JSON stdout — the exit-code path below reports it */ }
      done(env, { ...outcome, ...executable });
    },
  );
}

function evidence(
  phase: 'dry' | 'apply', outcome: ReconcileOutcome, env: Record<string, unknown> | null,
  capturePath?: string, captureCleanupError?: string,
): SyncApplyEvidence {
  return {
    uiCommand: outcome.uiCommand, uiExecutable: outcome.uiExecutable,
    phase, exitCode: outcome.exitCode, signal: outcome.signal, timedOut: outcome.timedOut,
    stdoutBytes: outcome.stdoutBytes, stdoutTruncated: outcome.stdoutTruncated,
    stderrBytes: outcome.stderrBytes, stderrTruncated: outcome.stderrTruncated,
    ...(outcome.stderr ? { stderrExcerpt: outcome.stderr } : {}),
    envelopeParsed: env !== null, ...(capturePath ? { capturePath } : {}),
    ...(captureCleanupError ? { captureCleanupError } : {}),
  };
}

function failure(
  phase: 'dry' | 'apply', outcome: ReconcileOutcome, env: Record<string, unknown> | null,
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
 * `fileSlug`/`fileName` — the bound file's own identity.
 * Undefined preserves whole-log, unfiltered behaviour.
 */
export function spawnReconcileApply(
  projectDir: string,
  fileSlug: string | undefined,
  fileName: string | undefined,
  done: (r: SyncApplyResult) => void,
  boundsOrOpts?: Readonly<ChildBounds> | SpawnReconcileApplyOptions,
  optsParam?: SpawnReconcileApplyOptions,
): ReconcileApplyHandle {
  const options: SpawnReconcileApplyOptions =
    optsParam !== undefined
      ? optsParam
      : (boundsOrOpts !== undefined && 'stdoutBytes' in boundsOrOpts)
        ? { bounds: boundsOrOpts as Readonly<ChildBounds> }
        : ((boundsOrOpts as SpawnReconcileApplyOptions | undefined) ?? {});

  const bounds = options.bounds ?? RECONCILE_CHILD_BOUNDS;
  const leaseDir = options.leaseDir;
  const log = options.log ?? (() => {});

  let settled = false;
  let aborted = false;
  let activePhase: 'dry' | 'apply' | 'none' = 'none';
  let activeChild: BoundedChildHandle | null = null;
  let activeLeasePath: string | null = null;
  let currentCapFile: string | undefined;

  const finish = (result: SyncApplyResult): void => {
    if (settled) return;
    settled = true;
    done(result);
  };

  // Inspect lease before admission if leaseDir is configured
  let existingStaleLease: ReconcileLeaseRecord | undefined;
  if (leaseDir) {
    const admission = inspectLeaseAdmission(leaseDir, projectDir, log);
    if (!admission.ok) {
      finish({
        ok: false,
        code: admission.code,
        summary: `reconcile admission refused: ${admission.reason}`,
      });
      return { cancelForShutdown: () => {} };
    }
    activeLeasePath = admission.leasePath;
    existingStaleLease = admission.existingLease;
  }

  const executable = selectReconcileExecutable(projectDir);
  const fileSlugArgs = fileSlug !== undefined ? ['--file-slug', fileSlug] : [];

  activePhase = 'dry';
  activeChild = runReconcile(projectDir, ['--dry-run', ...fileSlugArgs], bounds, executable, (env, outcome) => {
    activeChild = null;

    if (activeLeasePath && outcome.spawned && outcome.exited) {
      // Dry run ended
      const cur = readLeaseFile(activeLeasePath);
      if (cur && cur.phase === 'dry') {
        try {
          removeLeaseFile(activeLeasePath);
          log(`deleted clean dry-run lease: ${activeLeasePath}`);
        } catch (delErr) {
          log(`failed to delete dry-run lease ${activeLeasePath}: ${(delErr as Error).message}`);
        }
      }
    }

    if (aborted) {
      finish({
        ok: false,
        code: 'RECONCILE_SHUTDOWN_ABORTED',
        summary: 'reconcile canceled for broker shutdown',
        evidence: evidence('dry', outcome, env),
      });
      return;
    }

    const dryFailure = failure('dry', outcome, env);
    if (dryFailure) {
      if (activeLeasePath && existingStaleLease && existingStaleLease.phase === 'apply') {
        // Evidence-based recovery failed: latch as unknown
        try {
          writeLeaseFile(activeLeasePath, {
            ...existingStaleLease,
            status: 'unknown',
            reason: `recovery dry-run failed: ${dryFailure.summary}`,
          });
          log(`latched existing apply lease as unknown on disk: ${activeLeasePath}`);
        } catch { /* ignore */ }
      }
      finish(dryFailure);
      return;
    }

    // Dry-run succeeded! If there was a stale apply lease, recovery succeeded!
    if (activeLeasePath && existingStaleLease && existingStaleLease.phase === 'apply') {
      log(`recovery dry-run verified registry ok for stale apply lease: ${activeLeasePath}`);
      try {
        removeLeaseFile(activeLeasePath);
        log(`deleted recovered stale apply lease: ${activeLeasePath}`);
      } catch (err) {
        log(`failed to delete recovered stale apply lease ${activeLeasePath}: ${(err as Error).message}`);
        finish({
          ok: false,
          code: 'RECONCILE_LEASE_CLEANUP_FAILED',
          summary: `reconcile lease cleanup failed during recovery: ${(err as Error).message}`,
          evidence: evidence('dry', outcome, env),
        });
        return;
      }
    }

    const data = envelopeData(env)!;
    const pendingFirst = pendingTargetsFromEnvelope(data);
    const targets = mergeTargetsPendingFirst(pendingFirst, targetsFromDelta(data));

    void Promise.resolve().then(() => {
      if (aborted) throw new Error('aborted for shutdown');
      return captureMirror(targets, fileName);
    }).then((cap) => {
      if (aborted) {
        if (cap.file !== undefined) removeCapture(cap.file);
        finish({
          ok: false,
          code: 'RECONCILE_SHUTDOWN_ABORTED',
          summary: 'reconcile canceled for broker shutdown',
          evidence: evidence('dry', outcome, env),
        });
        return;
      }

      currentCapFile = cap.file;
      const extra = ['--apply', ...fileSlugArgs, ...(cap.file !== undefined ? ['--mirror-file', cap.file] : [])];

      activePhase = 'apply';
      activeChild = runReconcile(projectDir, extra, bounds, executable, (aEnv, aOutcome) => {
        activeChild = null;
        const retainedPath = cap.file !== undefined && aOutcome.spawned ? cap.file : undefined;
        const applyFailure = failure('apply', aOutcome, aEnv, retainedPath);

        if (applyFailure) {
          if (activeLeasePath) {
            if (applyFailure.code === 'RECONCILE_OUTCOME_UNKNOWN' || applyFailure.code === 'RECONCILE_CHILD_UNKILLABLE') {
              try {
                const currentLease = readLeaseFile(activeLeasePath);
                if (currentLease) {
                  writeLeaseFile(activeLeasePath, {
                    ...currentLease,
                    status: 'unknown',
                    reason: applyFailure.summary,
                  });
                  log(`retained unknown apply lease on disk: ${activeLeasePath}`);
                }
              } catch { /* ignore */ }
            } else if (aOutcome.exited) {
              try {
                removeLeaseFile(activeLeasePath);
                log(`deleted failed apply lease: ${activeLeasePath}`);
              } catch (delErr) {
                log(`failed to delete failed apply lease ${activeLeasePath}: ${(delErr as Error).message}`);
              }
            }
          }

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

        // Apply clean exit!
        let leaseCleanupErr: string | undefined;
        if (activeLeasePath) {
          try {
            removeLeaseFile(activeLeasePath);
            log(`deleted clean apply lease: ${activeLeasePath}`);
          } catch (delErr) {
            leaseCleanupErr = (delErr as Error).message;
            log(`failed to delete clean apply lease ${activeLeasePath}: ${leaseCleanupErr}`);
          }
        }

        const aData = envelopeData(aEnv)!;
        const result = applyResult(aData['apply'], cap.dropped);
        const cleanupError = cap.file !== undefined ? removeCapture(cap.file) : undefined;
        let summary = result.summary;
        if (cleanupError) {
          summary = `${summary} — capture cleanup failed; kept for inspection: ${cap.file}`;
        }
        if (leaseCleanupErr) {
          summary = `${summary} — lease cleanup failed`;
        }

        finish({
          ...result,
          summary,
          ...(leaseCleanupErr ? { code: 'RECONCILE_LEASE_CLEANUP_FAILED' } : {}),
          evidence: evidence('apply', aOutcome, aEnv, cleanupError ? cap.file : undefined, cleanupError ?? leaseCleanupErr),
        });
      });

      // Write lease for apply child
      if (activeLeasePath && activeChild.pid) {
        const startToken = readProcessStartToken(activeChild.pid);
        const record: ReconcileLeaseRecord = {
          version: 1,
          pid: activeChild.pid,
          startToken: startToken.state === 'alive' ? startToken.token : null,
          phase: 'apply',
          status: 'running',
          projectDir,
          ...(fileSlug !== undefined ? { fileSlug } : {}),
          startedAt: new Date().toISOString(),
        };
        try {
          writeLeaseFile(activeLeasePath, record);
          log(`acquired apply reconcile lease: pid=${record.pid} token=${record.startToken} path=${activeLeasePath}`);
        } catch (writeErr) {
          log(`failed to write apply lease: ${(writeErr as Error).message}`);
        }
      }
    }).catch((error: unknown) => {
      if (aborted) {
        finish({
          ok: false,
          code: 'RECONCILE_SHUTDOWN_ABORTED',
          summary: 'reconcile canceled for broker shutdown',
          evidence: evidence('dry', outcome, env),
        });
        return;
      }
      finish({
        ok: false,
        code: 'RECONCILE_CAPTURE_FAILED',
        evidence: evidence('dry', outcome, env),
        summary: `could not prepare mirror capture: ${(error as Error).message}`,
      });
    });
  });

  // Write lease for dry child
  if (activeLeasePath && activeChild.pid) {
    const startToken = readProcessStartToken(activeChild.pid);
    const record: ReconcileLeaseRecord = {
      version: 1,
      pid: activeChild.pid,
      startToken: startToken.state === 'alive' ? startToken.token : null,
      phase: 'dry',
      status: 'running',
      projectDir,
      ...(fileSlug !== undefined ? { fileSlug } : {}),
      startedAt: new Date().toISOString(),
    };
    try {
      writeLeaseFile(activeLeasePath, record);
      log(`acquired dry-run reconcile lease: pid=${record.pid} token=${record.startToken} path=${activeLeasePath}`);
    } catch (writeErr) {
      log(`failed to write dry-run lease: ${(writeErr as Error).message}`);
    }
  }

  return {
    cancelForShutdown(reason = 'broker shutdown'): void {
      if (aborted || settled) return;
      aborted = true;
      log(`cancelForShutdown invoked (${reason}): activePhase=${activePhase}`);
      if (currentCapFile !== undefined) {
        removeCapture(currentCapFile);
      }
      if (activeChild) {
        try {
          activeChild.terminate('SIGTERM');
        } catch { /* ignore */ }
      }
      if (activePhase === 'apply' && activeLeasePath) {
        log(`retained apply lease during shutdown for surviving child inspection: ${activeLeasePath}`);
      }
    },
  };
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
