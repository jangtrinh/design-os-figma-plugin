import { spawn } from 'node:child_process';
import { BoundedOutputBuffer } from './bounded-child-output-buffer.ts';

export interface ChildBounds {
  stdoutBytes: number;
  stderrBytes: number;
  deadlineMs: number;
  termGraceMs: number;
  closeGraceMs: number;
  reapGraceMs: number;
}

export interface ChildOutcome {
  spawned: boolean;
  exited: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stdoutBytes: number;
  stdoutTruncated: boolean;
  stderr: string;
  stderrBytes: number;
  stderrRetainedBytes: number;
  stderrTruncated: boolean;
  launchError?: string;
  launchErrorKind?: 'throw' | 'error';
}

export const RECONCILE_CHILD_BOUNDS: Readonly<ChildBounds> = Object.freeze({
  stdoutBytes: 128 * 1024 * 1024,
  stderrBytes: 1024 * 1024,
  deadlineMs: 120_000,
  termGraceMs: 2_000,
  closeGraceMs: 1_000,
  reapGraceMs: 5_000,
});

interface RunOptions {
  cwd?: string;
  bounds?: Readonly<ChildBounds>;
}

function ignoreLateChildError(): void { /* exit evidence already settled the result */ }

/** Spawn one child with independently bounded output and exit-evidenced settlement. */
export function runBoundedChild(
  command: string,
  args: readonly string[],
  options: RunOptions,
  done: (outcome: ChildOutcome) => void,
): void {
  const bounds = options.bounds ?? RECONCILE_CHILD_BOUNDS;
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(command, [...args], {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    done(emptyOutcome((error as Error).message, 'throw'));
    return;
  }

  let settled = false;
  let spawned = false;
  let exited = false;
  let exitCode: number | null = null;
  let signal: NodeJS.Signals | null = null;
  let timedOut = false;
  let launchError: string | undefined;
  let launchErrorKind: 'throw' | 'error' | undefined;
  const stdoutBuffer = new BoundedOutputBuffer(bounds.stdoutBytes, 'prefix');
  const stderrBuffer = new BoundedOutputBuffer(bounds.stderrBytes, 'head-tail');
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let termTimer: ReturnType<typeof setTimeout> | null = null;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  let reapTimer: ReturnType<typeof setTimeout> | null = null;

  const clearTimers = (): void => {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (termTimer) clearTimeout(termTimer);
    if (closeTimer) clearTimeout(closeTimer);
    if (reapTimer) clearTimeout(reapTimer);
    deadlineTimer = termTimer = closeTimer = reapTimer = null;
  };
  const onStdout = (chunk: unknown): void => stdoutBuffer.push(chunk);
  const onStderr = (chunk: unknown): void => stderrBuffer.push(chunk);
  const onSpawn = (): void => { spawned = true; };
  const onError = (error: Error): void => {
    launchError ??= error.message;
    launchErrorKind ??= 'error';
    if (!spawned) settle();
  };
  const onExit = (code: number | null, childSignal: NodeJS.Signals | null): void => {
    exited = true;
    exitCode = code ?? null;
    signal = childSignal ?? null;
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (termTimer) clearTimeout(termTimer);
    if (reapTimer) clearTimeout(reapTimer);
    deadlineTimer = termTimer = reapTimer = null;
    closeTimer = setTimeout(settle, bounds.closeGraceMs);
  };
  const onClose = (code: number | null, childSignal: NodeJS.Signals | null): void => {
    if (!launchError && !spawned) spawned = true;
    exited = true;
    exitCode ??= code ?? null;
    signal ??= childSignal ?? null;
    settle();
  };
  function settle(): void {
    if (settled) return;
    settled = true;
    clearTimers();
    child.off('spawn', onSpawn);
    child.off('exit', onExit);
    child.off('close', onClose);
    child.stdout?.off('data', onStdout);
    child.stderr?.off('data', onStderr);
    child.off('error', onError);
    child.on('error', ignoreLateChildError);
    const stdout = stdoutBuffer.snapshot();
    const stderr = stderrBuffer.snapshot();
    done({
      spawned, exited, exitCode, signal, timedOut,
      stdout: stdout.text, stdoutBytes: stdout.totalBytes, stdoutTruncated: stdout.truncated,
      stderr: stderr.text, stderrBytes: stderr.totalBytes,
      stderrRetainedBytes: stderr.retainedBytes, stderrTruncated: stderr.truncated,
      ...(launchError ? { launchError, launchErrorKind } : {}),
    });
  }

  child.stdout?.on('data', onStdout);
  child.stderr?.on('data', onStderr);
  child.on('spawn', onSpawn);
  child.on('error', onError);
  child.on('exit', onExit);
  child.on('close', onClose);
  deadlineTimer = setTimeout(() => {
    if (exited || settled) return;
    timedOut = true;
    try { child.kill('SIGTERM'); } catch { /* absence of signal delivery is not exit evidence */ }
    termTimer = setTimeout(() => {
      if (exited || settled) return;
      try { child.kill('SIGKILL'); } catch { /* reap grace still bounds the reply */ }
      reapTimer = setTimeout(settle, bounds.reapGraceMs);
    }, bounds.termGraceMs);
  }, bounds.deadlineMs);
}

function emptyOutcome(launchError: string, launchErrorKind: 'throw'): ChildOutcome {
  return {
    spawned: false, exited: false, exitCode: null, signal: null, timedOut: false,
    stdout: '', stdoutBytes: 0, stdoutTruncated: false,
    stderr: '', stderrBytes: 0, stderrRetainedBytes: 0, stderrTruncated: false,
    launchError, launchErrorKind,
  };
}
