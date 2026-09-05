import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type SyncModule = typeof import('../cli/src/transport/figma-sync-apply.ts');

const spawnMock = vi.fn();
let scratchDir: string;
let priorUiBin: string | undefined;
let observedClose: Promise<void> | undefined;

function fakeChild(): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter } {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
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

async function runSync(mod: SyncModule): Promise<Awaited<ReturnType<typeof resultOnce>>> {
  return resultOnce((done) => mod.spawnReconcileApply(scratchDir, undefined, undefined, done));
}

function resultOnce(start: (done: (result: { ok: boolean; summary: string }) => void) => void): Promise<{ result: { ok: boolean; summary: string }; calls: number }> {
  return new Promise((resolve) => {
    let calls = 0;
    let first: { ok: boolean; summary: string } | undefined;
    start((result) => {
      calls += 1;
      first ??= result;
      queueMicrotask(() => setImmediate(() => resolve({ result: first!, get calls() { return calls; } })));
    });
  });
}

function writeKernel(mode: 'success' | 'malformed' | 'nonzero', stageLog?: string): string {
  const script = join(scratchDir, 'controlled-reconcile');
  const output = mode === 'success'
    ? `const dry=process.argv.includes('--dry-run'); require('node:fs').appendFileSync(${JSON.stringify(stageLog)}, dry ? 'dry\\n' : 'apply\\n'); console.log(JSON.stringify(dry ? {ok:true,data:{delta:{added:[],updated:[]},pending:[]}} : {ok:true,data:{apply:{added:[],updated:[],deprecated:[],mirrored:[],pending:[],skipped:[],mirrorSkipped:[]}}}));`
    : mode === 'malformed'
      ? "console.log('not json');"
      : "process.exit(7);";
  writeFileSync(script, `#!${process.execPath}\n${output}\n`, 'utf8');
  chmodSync(script, 0o755);
  return script;
}

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'figma-sync-apply-'));
  priorUiBin = process.env['FIGMA_AGENT_UI_BIN'];
  spawnMock.mockReset();
  observedClose = undefined;
});

afterEach(() => {
  vi.doUnmock('node:child_process');
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
});
