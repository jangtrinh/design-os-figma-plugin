import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { safeCleanup } from '../../../shared/safe-cleanup.ts';

export interface ReconcileLeaseRecord {
  version: 1;
  pid: number;
  startToken: string | null;
  phase: 'dry' | 'apply';
  status: 'running' | 'unknown';
  projectDir: string;
  fileSlug?: string;
  startedAt: string;
  reason?: string;
}

export type ProcessState =
  | { state: 'alive'; token: string }
  | { state: 'dead' }
  | { state: 'uncertain'; reason: string };

export type LeaseAdmissionResult =
  | { ok: true; leasePath: string; existingLease?: ReconcileLeaseRecord }
  | {
      ok: false;
      code: 'RECONCILE_IN_FLIGHT_SURVIVED' | 'RECONCILE_LEASE_UNCERTAIN' | 'RECONCILE_OUTCOME_UNKNOWN' | 'RECONCILE_LEASE_CLEANUP_FAILED';
      reason: string;
      lease?: ReconcileLeaseRecord;
      leasePath?: string;
    };

/** Derive private reconcile lease directory beside broker advertisement file. */
export function reconcileLeaseDirFor(advertisePath: string): string {
  return `${advertisePath}.reconcile-leases`;
}

/** Compute deterministic canonical lease file path for a target project directory. */
export function leaseFilePath(leaseDir: string, projectDir: string): string {
  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(projectDir);
  } catch {
    canonicalPath = projectDir;
  }
  const hash = createHash('sha256').update(canonicalPath).digest('hex');
  return join(leaseDir, `${hash}.json`);
}

/** Check process start token for anti-PID-reuse verification. */
export function readProcessStartToken(pid: number): ProcessState {
  if (pid <= 0 || !Number.isSafeInteger(pid)) {
    return { state: 'dead' };
  }

  try {
    process.kill(pid, 0);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return { state: 'dead' };
    if (code === 'EPERM') return { state: 'uncertain', reason: 'EPERM' };
    return { state: 'uncertain', reason: (err as Error).message };
  }

  if (process.platform === 'linux') {
    let statContent: string;
    let fd: number;
    try {
      fd = openSync(`/proc/${pid}/stat`, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ESRCH') return { state: 'dead' };
      return { state: 'uncertain', reason: `cannot open /proc/${pid}/stat: ${(err as Error).message}` };
    }

    try {
      const buf = Buffer.alloc(1024);
      const bytesRead = readSync(fd, buf, 0, 1024, 0);
      statContent = buf.toString('utf8', 0, bytesRead);
    } catch (err) {
      return { state: 'uncertain', reason: `cannot read /proc/${pid}/stat: ${(err as Error).message}` };
    } finally {
      try { closeSync(fd); } catch { /* ignore close failure */ }
    }

    const closeParen = statContent.lastIndexOf(')');
    if (closeParen === -1) {
      return { state: 'uncertain', reason: 'cannot parse /proc comm field' };
    }
    const rest = statContent.slice(closeParen + 1).trim().split(/\s+/);
    const procState = rest[0];
    if (procState === 'Z') {
      return { state: 'dead' };
    }
    const starttime = rest[19];
    if (starttime !== undefined && starttime !== '') {
      return { state: 'alive', token: starttime };
    }
    return { state: 'uncertain', reason: 'cannot parse starttime field in /proc/stat' };
  }

  // POSIX / macOS fallback
  try {
    const res = spawnSync('ps', ['-o', 'state=,lstart=', '-p', String(pid)], {
      timeout: 1500,
      encoding: 'utf8',
    });
    if (res.error) {
      return { state: 'uncertain', reason: res.error.message };
    }
    const output = (res.stdout ?? '').trim();
    if (output.length > 0) {
      const parts = output.split(/\s+/);
      const state = parts[0];
      if (state && state.startsWith('Z')) {
        return { state: 'dead' };
      }
      const token = parts.slice(1).join(' ');
      if (token.length > 0) {
        return { state: 'alive', token };
      }
    }
    if (res.status !== 0) {
      return { state: 'dead' };
    }
    return { state: 'uncertain', reason: 'ps returned empty output with status 0' };
  } catch (err) {
    return { state: 'uncertain', reason: (err as Error).message };
  }
}

/** Read a lease file with symlink refusal (O_NOFOLLOW / lstat). */
export function readLeaseFile(path: string): ReconcileLeaseRecord | null {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      return null;
    }
  } catch {
    return null;
  }

  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }

  try {
    const buf = Buffer.alloc(4096);
    const bytesRead = readSync(fd, buf, 0, 4096, 0);
    const raw = buf.toString('utf8', 0, bytesRead);
    const parsed = JSON.parse(raw.trim()) as ReconcileLeaseRecord;
    if (parsed && parsed.version === 1 && typeof parsed.pid === 'number' && typeof parsed.projectDir === 'string') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
}

/** Write lease file safely and securely without following symlinks. */
export function writeLeaseFile(path: string, record: ReconcileLeaseRecord): void {
  const dir = dirname(path);
  ensureLeaseDir(dir);

  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to write lease to symlink: ${path}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }

  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, JSON.stringify(record, null, 2), 'utf8');
  } catch (err) {
    safeCleanup(err, () => {
      try { closeSync(fd); } finally { try { unlinkSync(path); } catch { /* ignore */ } }
    });
  }
  closeSync(fd);
}

/** Remove lease file securely without following symlinks. */
export function removeLeaseFile(path: string): void {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to delete symlinked lease: ${path}`);
    }
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }
}

/** Ensure lease directory exists with private permissions 0o700. */
export function ensureLeaseDir(dir: string): void {
  try {
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink()) {
      throw new Error(`Lease directory cannot be a symbolic link: ${dir}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      return;
    }
    throw err;
  }
}

/**
 * Inspect any existing lease for projectDir, verify child liveness/identity,
 * and decide admission or refusal.
 */
export function inspectLeaseAdmission(
  leaseDir: string,
  projectDir: string,
  log: (msg: string) => void,
): LeaseAdmissionResult {
  const path = leaseFilePath(leaseDir, projectDir);
  const existing = readLeaseFile(path);

  if (!existing) {
    return { ok: true, leasePath: path };
  }

  const pState = readProcessStartToken(existing.pid);
  log(`inspecting lease ${path}: pid=${existing.pid} phase=${existing.phase} status=${existing.status} state=${pState.state}`);

  // Case A: Surviving child with confirmed matching startToken
  if (pState.state === 'alive' && existing.startToken !== null && pState.token === existing.startToken) {
    log(`retained active reconcile lease: child ${existing.pid} still alive with token ${pState.token}`);
    return {
      ok: false,
      code: 'RECONCILE_IN_FLIGHT_SURVIVED',
      reason: `reconcile child ${existing.pid} survived and is still running in phase '${existing.phase}'`,
      lease: existing,
      leasePath: path,
    };
  }

  // Case B: Uncertain process state or alive without startToken
  if (pState.state === 'uncertain' || (pState.state === 'alive' && existing.startToken === null)) {
    const reasonDetail = pState.state === 'uncertain' ? pState.reason : 'missing recorded startToken';
    log(`retained uncertain reconcile lease: pid ${existing.pid} state uncertain (${reasonDetail})`);
    return {
      ok: false,
      code: 'RECONCILE_LEASE_UNCERTAIN',
      reason: `reconcile lease state uncertain for pid ${existing.pid}: ${reasonDetail}`,
      lease: existing,
      leasePath: path,
    };
  }

  // Case C: Process is confirmed stopped (dead OR PID reused with startToken mismatch)
  if (pState.state === 'dead' || (pState.state === 'alive' && pState.token !== existing.startToken)) {
    if (pState.state === 'alive') {
      log(`detected PID reuse for pid ${existing.pid}: current token ${pState.token} != recorded ${existing.startToken}`);
    } else {
      log(`confirmed reconcile child ${existing.pid} stopped (dead)`);
    }

    if (existing.status === 'unknown') {
      log(`retained unknown-latched lease for project ${projectDir} (previous run status was unknown)`);
      return {
        ok: false,
        code: 'RECONCILE_OUTCOME_UNKNOWN',
        reason: `previous apply outcome was unknown; requires dry-run verification before retry`,
        lease: existing,
        leasePath: path,
      };
    }

    return {
      ok: true,
      leasePath: path,
      existingLease: existing,
    };
  }

  log(`retained unhandled reconcile lease state for pid ${existing.pid}`);
  return {
    ok: false,
    code: 'RECONCILE_LEASE_UNCERTAIN',
    reason: `unhandled lease state for pid ${existing.pid}`,
    lease: existing,
    leasePath: path,
  };
}
