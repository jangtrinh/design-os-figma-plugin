import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type SyncModule = typeof import('../cli/src/transport/figma-sync-apply.ts');
type SyncResult = import('../cli/src/transport/figma-sync-apply.ts').SyncApplyResult;
type ChildBounds = import('../cli/src/transport/bounded-child-process.ts').ChildBounds;

const spawnMock = vi.fn();
const captureMock = vi.fn();
const rmMock = vi.fn();
let scratchDir: string;
let priorUiBin: string | undefined;
let observedClose: Promise<void> | undefined;

function fakeChild(): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> } {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => true);
  return child;
}

async function loadWithCaptureMock(): Promise<SyncModule> {
  vi.resetModules();
  vi.doMock('node:child_process', () => ({ spawn: spawnMock }));
  vi.doMock('../cli/src/transport/figma-mirror-capture-run.ts', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../cli/src/transport/figma-mirror-capture-run.ts')>()),
    captureMirror: captureMock,
  }));
  return import('../cli/src/transport/figma-sync-apply.ts');
}

async function loadWithCaptureAndRmMock(): Promise<SyncModule> {
  vi.resetModules();
  vi.doMock('node:child_process', () => ({ spawn: spawnMock }));
  vi.doMock('node:fs', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:fs')>()),
    rmSync: rmMock,
  }));
  vi.doMock('../cli/src/transport/figma-mirror-capture-run.ts', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../cli/src/transport/figma-mirror-capture-run.ts')>()),
    captureMirror: captureMock,
  }));
  return import('../cli/src/transport/figma-sync-apply.ts');
}

async function loadWithSpawnMock(): Promise<SyncModule> {
  vi.resetModules();
  vi.doMock('node:child_process', () => ({ spawn: spawnMock }));
  return import('../cli/src/transport/figma-sync-apply.ts');
}

async function loadWithRealSpawn(): Promise<SyncModule> {
  vi.resetModules();
  vi.doUnmock('node:child_process');
  return import('../cli/src/transport/figma-sync-apply.ts');
}

async function loadWithObservedRealSpawn(): Promise<SyncModule> {
  vi.resetModules();
  vi.doMock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    const realSpawn = actual.spawn;
    return {
      ...actual,
      spawn: ((...args: Parameters<typeof realSpawn>) => {
        const child = realSpawn(...args);
        observedClose = new Promise((resolve) => child.once('close', () => resolve()));
        return child;
      }) as typeof realSpawn,
    };
  });
  return import('../cli/src/transport/figma-sync-apply.ts');
}

async function runSync(mod: SyncModule, bounds?: ChildBounds): Promise<Awaited<ReturnType<typeof resultOnce>>> {
  return resultOnce((done) => mod.spawnReconcileApply(scratchDir, undefined, undefined, done, bounds));
}

function resultOnce(start: (done: (result: SyncResult) => void) => void): Promise<{ result: SyncResult; calls: number }> {
  return new Promise((resolve) => {
    let calls = 0;
    let first: SyncResult | undefined;
    start((result) => {
      calls += 1;
      first ??= result;
      queueMicrotask(() => setImmediate(() => resolve({ result: first!, get calls() { return calls; } })));
    });
  });
}

function emitSuccess(child: ReturnType<typeof fakeChild>, envelope: unknown, exitCode = 0): void {
  queueMicrotask(() => {
    child.emit('spawn');
    child.stdout.emit('data', Buffer.from(JSON.stringify(envelope)));
    child.emit('exit', exitCode, null);
    child.emit('close', exitCode, null);
  });
}

function stagedCapture(): string {
  const dir = join(scratchDir, 'private-capture');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'capture.json');
  writeFileSync(file, '{}');
  return file;
}

function writeKernel(
  mode: 'success' | 'malformed' | 'nonzero' | 'valid-nonzero-preview' | 'valid-nonzero-apply',
  stageLog?: string,
): string {
  const script = join(scratchDir, 'controlled-reconcile');
  const validOutput = `const dry=process.argv.includes('--dry-run'); require('node:fs').appendFileSync(${JSON.stringify(stageLog)}, dry ? 'dry\\n' : 'apply\\n'); console.log(JSON.stringify(dry ? {ok:true,data:{delta:{added:[],updated:[]},pending:[]}} : {ok:true,data:{apply:{added:[],updated:[],deprecated:[],mirrored:[],pending:[],skipped:[],mirrorSkipped:[]}}}));`;
  const output = mode === 'success'
    ? validOutput
    : mode === 'malformed'
      ? "console.log('not json');"
      : mode === 'nonzero'
        ? 'process.exit(7);'
        : mode === 'valid-nonzero-preview'
          ? `${validOutput} if (dry) process.exitCode=7;`
          : `${validOutput} if (!dry) process.exitCode=7;`;
  writeFileSync(script, `#!${process.execPath}\n${output}\n`, 'utf8');
  chmodSync(script, 0o755);
  return script;
}

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'figma-sync-apply-'));
  priorUiBin = process.env['FIGMA_AGENT_UI_BIN'];
  spawnMock.mockReset();
  captureMock.mockReset();
  rmMock.mockReset();
  observedClose = undefined;
});

afterEach(() => {
  vi.doUnmock('node:child_process');
  vi.doUnmock('node:fs');
  vi.doUnmock('../cli/src/transport/figma-mirror-capture-run.ts');
  vi.resetModules();
  if (priorUiBin === undefined) delete process.env['FIGMA_AGENT_UI_BIN'];
  else process.env['FIGMA_AGENT_UI_BIN'] = priorUiBin;
  rmSync(scratchDir, { recursive: true, force: true });
});

describe('spawnReconcileApply', () => {
  it('settles a synchronous spawn throw once', async () => {
    spawnMock.mockImplementation(() => { throw new Error('sync launch failure'); });
    const result = await runSync(await loadWithSpawnMock());
    expect(result.calls).toBe(1);
    expect(result.result.summary).toContain('could not launch ui: sync launch failure');
  });

  it('keeps the first actionable error when error is followed by close', async () => {
    spawnMock.mockImplementation(() => {
      const child = fakeChild();
      queueMicrotask(() => {
        child.emit('error', new Error('missing controlled kernel'));
        child.emit('close', -2);
      });
      return child;
    });
    const result = await runSync(await loadWithSpawnMock());
    expect(result.calls).toBe(1);
    expect(result.result.summary).toContain('ui not runnable: missing controlled kernel');
  });

  it('settles a real missing executable after its process events', async () => {
    process.env['FIGMA_AGENT_UI_BIN'] = join(scratchDir, 'missing-controlled-kernel');
    const result = await runSync(await loadWithObservedRealSpawn());
    await observedClose;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(result.calls).toBe(1);
    expect(result.result.summary).toContain('ui not runnable: spawn');
  });

  it('settles an apply launch error once after a successful preview', async () => {
    spawnMock
      .mockImplementationOnce(() => {
        const child = fakeChild();
        queueMicrotask(() => {
          child.stdout.emit('data', JSON.stringify({ ok: true, data: { delta: { added: [], updated: [] }, pending: [] } }));
          child.emit('close', 0);
        });
        return child;
      })
      .mockImplementationOnce(() => {
        const child = fakeChild();
        queueMicrotask(() => {
          child.emit('error', new Error('apply launch failure'));
          child.emit('close', -2);
        });
        return child;
      });
    const result = await runSync(await loadWithSpawnMock());
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(result.calls).toBe(1);
    expect(result.result.summary).toContain('ui not runnable: apply launch failure');
  });

  it('ignores a late error after close has settled the child', async () => {
    spawnMock.mockImplementation(() => {
      const child = fakeChild();
      queueMicrotask(() => {
        child.emit('close', 0);
        child.emit('error', new Error('late error'));
      });
      return child;
    });
    const result = await runSync(await loadWithSpawnMock());
    expect(result.calls).toBe(1);
    expect(result.result.summary).toBe('ui exited 0');
  });

  it('runs controlled dry-run and apply stages once without a live target', async () => {
    const log = join(scratchDir, 'stages.log');
    process.env['FIGMA_AGENT_UI_BIN'] = writeKernel('success', log);
    const result = await runSync(await loadWithRealSpawn());
    expect(result.calls).toBe(1);
    expect(result.result).toMatchObject({ ok: true, summary: 'nothing to sync' });
    expect(readFileSync(log, 'utf8')).toBe('dry\napply\n');
  });

  it('reports malformed JSON and nonzero exits without a second completion', async () => {
    process.env['FIGMA_AGENT_UI_BIN'] = writeKernel('malformed');
    const malformed = await runSync(await loadWithRealSpawn());
    expect(malformed).toMatchObject({ calls: 1, result: { ok: false, summary: 'ui exited 0' } });

    process.env['FIGMA_AGENT_UI_BIN'] = writeKernel('nonzero');
    const nonzero = await runSync(await loadWithRealSpawn());
    expect(nonzero).toMatchObject({ calls: 1, result: { ok: false, summary: 'ui exited 7' } });
  });

  it('never advances from a valid preview envelope whose controlled child exits nonzero', async () => {
    const log = join(scratchDir, 'nonzero-preview-stages.log');
    process.env['FIGMA_AGENT_UI_BIN'] = writeKernel('valid-nonzero-preview', log);

    const result = await runSync(await loadWithRealSpawn());

    expect(result.calls).toBe(1);
    expect(result.result).toMatchObject({ ok: false, code: 'RECONCILE_FAILED' });
    expect(result.result.summary).toContain('ui exited 7');
    expect(readFileSync(log, 'utf8')).toBe('dry\n');
  });

  it('reports a valid apply envelope with nonzero exit as unknown without counts', async () => {
    const log = join(scratchDir, 'nonzero-apply-stages.log');
    process.env['FIGMA_AGENT_UI_BIN'] = writeKernel('valid-nonzero-apply', log);

    const result = await runSync(await loadWithRealSpawn());

    expect(result.calls).toBe(1);
    expect(result.result).toMatchObject({ ok: false, code: 'RECONCILE_OUTCOME_UNKNOWN' });
    expect(result.result).not.toHaveProperty('applied');
    expect(result.result).not.toHaveProperty('landed');
    expect(readFileSync(log, 'utf8')).toBe('dry\napply\n');
  });

  it('preserves a component name whose UTF-8 bytes arrive across chunks', async () => {
    let capturedName: string | undefined;
    captureMock.mockImplementation(async (targets: Array<{ name: string }>) => {
      capturedName = targets[0]?.name;
      return { captured: 1, failed: 0, dropped: 0, droppedTargets: [] };
    });
    const dry = fakeChild();
    const apply = fakeChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        dry.emit('spawn');
        const payload = Buffer.from(JSON.stringify({ ok: true, data: { delta: { added: [{ nodeId: '1:1', name: 'Đèn' }], updated: [] }, pending: [] } }));
        const split = payload.indexOf(Buffer.from('Đ')) + 1;
        dry.stdout.emit('data', payload.subarray(0, split));
        dry.stdout.emit('data', payload.subarray(split));
        dry.emit('exit', 0, null);
        dry.emit('close', 0, null);
      });
      return dry;
    }).mockImplementationOnce(() => {
      emitSuccess(apply, { ok: true, data: { apply: {} } });
      return apply;
    });

    const result = await runSync(await loadWithCaptureMock());

    expect(result.result.ok).toBe(true);
    expect(capturedName).toBe('Đèn');
  });

  it('removes capture only on success or known no-start, retaining known failures', async () => {
    for (const mode of ['success', 'throw-no-start', 'error-no-start', 'nonzero', 'kernel-failure'] as const) {
      spawnMock.mockReset();
      captureMock.mockReset();
      const capture = stagedCapture();
      captureMock.mockResolvedValue({ file: capture, captured: 1, failed: 0, dropped: 0, droppedTargets: [] });
      spawnMock.mockImplementationOnce(() => {
        const child = fakeChild();
        emitSuccess(child, { ok: true, data: { delta: { added: [], updated: [] }, pending: [] } });
        return child;
      }).mockImplementationOnce(() => {
        if (mode === 'throw-no-start') throw new Error('apply did not start');
        const child = fakeChild();
        if (mode === 'error-no-start') {
          queueMicrotask(() => child.emit('error', new Error('apply unavailable')));
        } else if (mode === 'kernel-failure') {
          emitSuccess(child, { ok: false, error: { code: 'READ_ERROR', message: 'capture unreadable' } });
        } else {
          emitSuccess(child, { ok: true, data: { apply: {} } }, mode === 'nonzero' ? 7 : 0);
        }
        return child;
      });

      const result = await runSync(await loadWithCaptureMock());
      const retained = mode === 'nonzero' || mode === 'kernel-failure';
      expect(existsSync(capture)).toBe(retained);
      if (retained) {
        expect(result.result).toMatchObject({
          ok: false,
          code: mode === 'nonzero' ? 'RECONCILE_OUTCOME_UNKNOWN' : 'READ_ERROR',
          evidence: { capturePath: capture },
        });
      }
    }
  });

  it('classifies unconfirmed exit before timeout, overflow, envelope, and retains capture', async () => {
    const capture = stagedCapture();
    captureMock.mockResolvedValue({ file: capture, captured: 1, failed: 0, dropped: 0, droppedTargets: [] });
    const dry = fakeChild();
    const apply = fakeChild();
    spawnMock.mockImplementationOnce(() => {
      emitSuccess(dry, { ok: true, data: { delta: { added: [], updated: [] }, pending: [] } });
      return dry;
    }).mockImplementationOnce(() => {
      queueMicrotask(() => {
        apply.emit('spawn');
        apply.stdout.emit('data', Buffer.from(JSON.stringify({ ok: true, data: { apply: {} }, padding: 'x'.repeat(256) })));
        apply.emit('error', new Error('post-spawn transport error'));
      });
      return apply;
    });
    const bounds = { stdoutBytes: 128, stderrBytes: 8, deadlineMs: 20, termGraceMs: 10, closeGraceMs: 10, reapGraceMs: 20 };

    const result = await runSync(await loadWithCaptureMock(), bounds);

    expect(result.result).toMatchObject({
      ok: false, code: 'RECONCILE_CHILD_UNKILLABLE', childExited: false,
      evidence: { timedOut: true, stdoutTruncated: true, capturePath: capture },
    });
    expect(result.result).not.toHaveProperty('applied');
    expect(result.result).not.toHaveProperty('landed');
    expect(existsSync(capture)).toBe(true);
    expect(apply.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
  });

  it('distinguishes confirmed dry timeout from unknown apply timeout', async () => {
    const bounds = { stdoutBytes: 128, stderrBytes: 8, deadlineMs: 20, termGraceMs: 10, closeGraceMs: 10, reapGraceMs: 20 };
    const timedChild = (): ReturnType<typeof fakeChild> => {
      const child = fakeChild();
      child.kill.mockImplementation((signal: NodeJS.Signals) => {
        if (signal === 'SIGTERM') queueMicrotask(() => {
          child.emit('exit', null, 'SIGTERM');
          child.emit('close', null, 'SIGTERM');
        });
        return true;
      });
      queueMicrotask(() => child.emit('spawn'));
      return child;
    };

    spawnMock.mockImplementationOnce(timedChild);
    const dryTimeout = await runSync(await loadWithSpawnMock(), bounds);
    expect(dryTimeout.result).toMatchObject({ ok: false, code: 'RECONCILE_DRY_TIMEOUT', evidence: { timedOut: true, signal: 'SIGTERM' } });
    expect(spawnMock).toHaveBeenCalledTimes(1);

    spawnMock.mockReset();
    captureMock.mockReset();
    const capture = stagedCapture();
    captureMock.mockResolvedValue({ file: capture, captured: 1, failed: 0, dropped: 0, droppedTargets: [] });
    spawnMock.mockImplementationOnce(() => {
      const child = fakeChild();
      emitSuccess(child, { ok: true, data: { delta: { added: [], updated: [] }, pending: [] } });
      return child;
    }).mockImplementationOnce(timedChild);
    const applyTimeout = await runSync(await loadWithCaptureMock(), bounds);
    expect(applyTimeout.result).toMatchObject({
      ok: false, code: 'RECONCILE_OUTCOME_UNKNOWN',
      evidence: { timedOut: true, signal: 'SIGTERM', capturePath: capture },
    });
    expect(applyTimeout.result).not.toHaveProperty('applied');
    expect(applyTimeout.result).not.toHaveProperty('landed');
    expect(existsSync(capture)).toBe(true);
  });

  it('contains synchronous and asynchronous capture failures with one completion', async () => {
    for (const captureFailure of [
      () => { throw new Error('capture threw'); },
      () => Promise.reject(new Error('capture rejected')),
    ]) {
      spawnMock.mockReset();
      captureMock.mockReset();
      captureMock.mockImplementation(captureFailure);
      spawnMock.mockImplementationOnce(() => {
        const child = fakeChild();
        emitSuccess(child, { ok: true, data: { delta: { added: [], updated: [] }, pending: [] } });
        return child;
      });

      const result = await runSync(await loadWithCaptureMock());
      expect(result).toMatchObject({ calls: 1, result: { ok: false, code: 'RECONCILE_CAPTURE_FAILED' } });
      expect(spawnMock).toHaveBeenCalledTimes(1);
    }
  });

  it('keeps successful apply truth while reporting a capture cleanup failure and path', async () => {
    const capture = stagedCapture();
    captureMock.mockResolvedValue({ file: capture, captured: 1, failed: 0, dropped: 0, droppedTargets: [] });
    rmMock.mockImplementation(() => { throw new Error('cleanup denied'); });
    spawnMock.mockImplementationOnce(() => {
      const child = fakeChild();
      emitSuccess(child, { ok: true, data: { delta: { added: [], updated: [] }, pending: [] } });
      return child;
    }).mockImplementationOnce(() => {
      const child = fakeChild();
      emitSuccess(child, { ok: true, data: { apply: {} } });
      return child;
    });

    const result = await runSync(await loadWithCaptureAndRmMock());

    expect(result.result).toMatchObject({
      ok: true,
      evidence: { capturePath: capture, captureCleanupError: 'cleanup denied' },
    });
    expect(result.result.summary).toContain('capture cleanup failed');
    expect(result.result).toHaveProperty('applied');
    expect(result.result).toHaveProperty('landed');
    expect(existsSync(capture)).toBe(true);
  });

  it('accepts a valid nine-mebibyte reply under production defaults', async () => {
    const script = join(scratchDir, 'large-reconcile');
    const source = `#!${process.execPath}\nconst dry=process.argv.includes('--dry-run');const data=dry?{delta:{added:[],updated:[]},pending:[],padding:'x'.repeat(9*1024*1024)}:{apply:{},padding:'x'.repeat(9*1024*1024)};process.stdout.write(JSON.stringify({ok:true,data}));\n`;
    writeFileSync(script, source);
    chmodSync(script, 0o755);
    process.env['FIGMA_AGENT_UI_BIN'] = script;

    const result = await runSync(await loadWithRealSpawn());

    expect(result.result).toMatchObject({ ok: true, evidence: { stdoutTruncated: false } });
    expect(result.result.evidence!.stdoutBytes).toBeGreaterThan(9 * 1024 * 1024);
  });
});
