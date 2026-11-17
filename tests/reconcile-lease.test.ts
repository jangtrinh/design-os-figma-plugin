import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  ensureLeaseDir,
  inspectLeaseAdmission,
  leaseFilePath,
  readLeaseFile,
  readProcessStartToken,
  reconcileLeaseDirFor,
  writeLeaseFile,
  type ReconcileLeaseRecord,
} from '../cli/src/transport/reconcile-lease.ts';
import {
  spawnReconcileApply,
  type SyncApplyResult,
} from '../cli/src/transport/figma-sync-apply.ts';

const fixtureDirs: string[] = [];
const fixturePids = new Set<number>();

function createScratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  fixtureDirs.push(dir);
  return dir;
}

function spawnDummyChild(delayMs = 10_000): { pid: number; kill: () => void } {
  const child = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${delayMs})`], {
    stdio: 'ignore',
  });
  if (child.pid) {
    fixturePids.add(child.pid);
  }
  return {
    pid: child.pid!,
    kill: () => {
      try {
        child.kill('SIGKILL');
      } catch { /* ignore */ }
    },
  };
}

function writeMockKernel(projectDir: string, opts: { dryOk?: boolean; applyOk?: boolean; dryDelayMs?: number; applyDelayMs?: number } = {}) {
  const binDir = join(projectDir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const scriptPath = join(binDir, 'ui');
  const dryOk = opts.dryOk ?? true;
  const applyOk = opts.applyOk ?? true;
  const dryDelay = opts.dryDelayMs ?? 0;
  const applyDelay = opts.applyDelayMs ?? 0;

  const content = `#!${process.execPath}
const args = process.argv;
const isDry = args.includes('--dry-run');
const isApply = args.includes('--apply');
const delay = isDry ? ${dryDelay} : ${applyDelay};

setTimeout(() => {
  if (isDry) {
    if (${dryOk}) {
      console.log(JSON.stringify({ ok: true, data: { delta: { added: [], updated: [] }, pending: [] } }));
      process.exit(0);
    } else {
      console.log(JSON.stringify({ ok: false, error: { code: 'REGISTRY_CORRUPT', message: 'corrupt registry' } }));
      process.exit(1);
    }
  }
  if (isApply) {
    if (${applyOk}) {
      console.log(JSON.stringify({ ok: true, data: { apply: { added: [], updated: [], deprecated: [], mirrored: [], pending: [], skipped: [], mirrorSkipped: [] } } }));
      process.exit(0);
    } else {
      console.log(JSON.stringify({ ok: false, error: { code: 'APPLY_FAILED', message: 'cannot apply' } }));
      process.exit(1);
    }
  }
  process.exit(0);
}, delay);
`;
  writeFileSync(scriptPath, content, { mode: 0o755 });
  process.env['FIGMA_AGENT_UI_BIN'] = scriptPath;
  return scriptPath;
}

afterEach(() => {
  for (const pid of fixturePids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch { /* ignore */ }
  }
  fixturePids.clear();
  for (const dir of fixtureDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env['FIGMA_AGENT_UI_BIN'];
});

describe('reconcile-lease and process start token verification', () => {
  it('reads process start token for a live child and verifies dead process', async () => {
    const dummy = spawnDummyChild();
    const token = readProcessStartToken(dummy.pid);
    expect(token.state).toBe('alive');
    if (token.state === 'alive') {
      expect(typeof token.token).toBe('string');
      expect(token.token.length).toBeGreaterThan(0);
    }

    dummy.kill();
    // Wait for the OS to finish terminating the process so readProcessStartToken observes dead
    let deadToken = readProcessStartToken(dummy.pid);
    let attempts = 0;
    while (deadToken.state !== 'dead' && attempts < 50) {
      attempts++;
      await new Promise((r) => setTimeout(r, 10));
      deadToken = readProcessStartToken(dummy.pid);
    }
    expect(deadToken.state).toBe('dead');
  });

  it('detects PID reuse when PID is alive but startToken mismatches', () => {
    const dummy = spawnDummyChild();
    const leaseDir = createScratchDir('lease-test-');
    const projectDir = createScratchDir('project-test-');
    const leasePath = leaseFilePath(leaseDir, projectDir);

    const record: ReconcileLeaseRecord = {
      version: 1,
      pid: dummy.pid,
      startToken: 'mismatched-nonexistent-token-99999',
      phase: 'dry',
      status: 'running',
      projectDir,
      startedAt: new Date().toISOString(),
    };
    writeLeaseFile(leasePath, record);

    const logs: string[] = [];
    const admission = inspectLeaseAdmission(leaseDir, projectDir, (m) => logs.push(m));
    expect(admission.ok).toBe(true);
    expect(logs.some((l) => l.includes('detected PID reuse'))).toBe(true);
  });

  it('fails closed when existing lease process state is uncertain', () => {
    const dummy = spawnDummyChild();
    const leaseDir = createScratchDir('lease-test-');
    const projectDir = createScratchDir('project-test-');
    const leasePath = leaseFilePath(leaseDir, projectDir);

    // Missing recorded startToken on alive PID -> uncertain
    const record: ReconcileLeaseRecord = {
      version: 1,
      pid: dummy.pid,
      startToken: null,
      phase: 'apply',
      status: 'running',
      projectDir,
      startedAt: new Date().toISOString(),
    };
    writeLeaseFile(leasePath, record);

    const logs: string[] = [];
    const admission = inspectLeaseAdmission(leaseDir, projectDir, (m) => logs.push(m));
    expect(admission.ok).toBe(false);
    if (!admission.ok) {
      expect(admission.code).toBe('RECONCILE_LEASE_UNCERTAIN');
    }
    expect(logs.some((l) => l.includes('retained uncertain reconcile lease'))).toBe(true);
  });
});

describe('reconcile lease admission and recovery in spawnReconcileApply', () => {
  let scratchDir: string;
  let leaseDir: string;

  beforeEach(() => {
    scratchDir = createScratchDir('project-reconcile-');
    leaseDir = reconcileLeaseDirFor(join(scratchDir, 'advertisement.json'));
    ensureLeaseDir(leaseDir);
  });

  it('refuses overlap when an in-flight child survived parent restart', async () => {
    const dummy = spawnDummyChild();
    const liveToken = readProcessStartToken(dummy.pid);
    expect(liveToken.state).toBe('alive');
    const token = (liveToken as { token: string }).token;

    const leasePath = leaseFilePath(leaseDir, scratchDir);
    const existing: ReconcileLeaseRecord = {
      version: 1,
      pid: dummy.pid,
      startToken: token,
      phase: 'apply',
      status: 'running',
      projectDir: scratchDir,
      startedAt: new Date().toISOString(),
    };
    writeLeaseFile(leasePath, existing);

    const logs: string[] = [];
    const result = await new Promise<SyncApplyResult>((resolve) => {
      spawnReconcileApply(
        scratchDir,
        undefined,
        undefined,
        resolve,
        {
          leaseDir,
          log: (m) => logs.push(m),
        },
      );
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('RECONCILE_IN_FLIGHT_SURVIVED');
    expect(result.summary).toContain('reconcile admission refused');
    expect(existsSync(leasePath)).toBe(true);
    expect(logs.some((l) => l.includes('retained active reconcile lease'))).toBe(true);

    // Now kill surviving child -> verify evidence-based recovery proceeds on next apply
    dummy.kill();
    let deadToken = readProcessStartToken(dummy.pid);
    while (deadToken.state !== 'dead') {
      deadToken = readProcessStartToken(dummy.pid);
    }

    writeMockKernel(scratchDir, { dryOk: true, applyOk: true });
    const recoveryResult = await new Promise<SyncApplyResult>((resolve) => {
      spawnReconcileApply(
        scratchDir,
        undefined,
        undefined,
        resolve,
        {
          leaseDir,
          log: (m) => logs.push(m),
        },
      );
    });

    expect(recoveryResult.ok).toBe(true);
    expect(logs.some((l) => l.includes('recovery dry-run verified registry ok'))).toBe(true);
  });

  it('retains durable unknown latch when stale apply lease fails evidence-based recovery', async () => {
    // Simulate dead child after crash during apply
    const leasePath = leaseFilePath(leaseDir, scratchDir);
    const stale: ReconcileLeaseRecord = {
      version: 1,
      pid: 999999, // confirmed dead pid
      startToken: 'old-token',
      phase: 'apply',
      status: 'running',
      projectDir: scratchDir,
      startedAt: new Date().toISOString(),
    };
    writeLeaseFile(leasePath, stale);

    // Mock kernel where dry-run returns corrupt registry (evidence probe fails!)
    writeMockKernel(scratchDir, { dryOk: false });

    const logs: string[] = [];
    const result = await new Promise<SyncApplyResult>((resolve) => {
      spawnReconcileApply(
        scratchDir,
        undefined,
        undefined,
        resolve,
        {
          leaseDir,
          log: (m) => logs.push(m),
        },
      );
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('REGISTRY_CORRUPT');

    // Verify lease was latched as unknown on disk
    const latched = readLeaseFile(leasePath);
    expect(latched).not.toBeNull();
    expect(latched?.status).toBe('unknown');
    expect(logs.some((l) => l.includes('latched existing apply lease as unknown on disk'))).toBe(true);

    // Subsequent admission attempt must now refuse with RECONCILE_OUTCOME_UNKNOWN
    const secondResult = await new Promise<SyncApplyResult>((resolve) => {
      spawnReconcileApply(
        scratchDir,
        undefined,
        undefined,
        resolve,
        {
          leaseDir,
          log: (m) => logs.push(m),
        },
      );
    });

    expect(secondResult.ok).toBe(false);
    expect(secondResult.code).toBe('RECONCILE_OUTCOME_UNKNOWN');
  });

  it('cancelForShutdown stops dry child and cancels before apply starts', async () => {
    writeMockKernel(scratchDir, { dryDelayMs: 500 });
    const logs: string[] = [];

    let handle: { cancelForShutdown(reason?: string): void } | undefined;
    const resultPromise = new Promise<SyncApplyResult>((resolve) => {
      handle = spawnReconcileApply(
        scratchDir,
        undefined,
        undefined,
        resolve,
        {
          leaseDir,
          log: (m) => logs.push(m),
        },
      );
    });

    // Wait slightly then cancel while in dry phase
    await new Promise((r) => setTimeout(r, 50));
    handle?.cancelForShutdown('testing broker shutdown');

    const result = await resultPromise;
    expect(result.ok).toBe(false);
    expect(result.code).toBe('RECONCILE_SHUTDOWN_ABORTED');
    expect(logs.some((l) => l.includes('cancelForShutdown invoked'))).toBe(true);
  });

  it('reports RECONCILE_LEASE_CLEANUP_FAILED when lease directory refuses deletion', async () => {
    const leasePath = leaseFilePath(leaseDir, scratchDir);
    const stale: ReconcileLeaseRecord = {
      version: 1,
      pid: 999999,
      startToken: 'old-token',
      phase: 'apply',
      status: 'running',
      projectDir: scratchDir,
      startedAt: new Date().toISOString(),
    };
    writeLeaseFile(leasePath, stale);

    // Make lease directory read-only so unlink fails during cleanup
    writeMockKernel(scratchDir, { dryOk: true });
    chmodSync(leaseDir, 0o500);

    const logs: string[] = [];
    try {
      const result = await new Promise<SyncApplyResult>((resolve) => {
        spawnReconcileApply(
          scratchDir,
          undefined,
          undefined,
          resolve,
          {
            leaseDir,
            log: (m) => logs.push(m),
          },
        );
      });

      expect(result.ok).toBe(false);
      expect(result.code).toBe('RECONCILE_LEASE_CLEANUP_FAILED');
      expect(result.summary).toContain('reconcile lease cleanup failed');
    } finally {
      chmodSync(leaseDir, 0o700);
    }
  });
});
