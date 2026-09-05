import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildBounds, ChildOutcome } from '../cli/src/transport/bounded-child-process.ts';

type RunnerModule = typeof import('../cli/src/transport/bounded-child-process.ts');
type FakeChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

const spawnMock = vi.fn();
const fixtureDirs: string[] = [];
const fixturePids = new Set<number>();
const fastBounds: ChildBounds = {
  stdoutBytes: 64,
  stderrBytes: 16,
  deadlineMs: 80,
  termGraceMs: 50,
  closeGraceMs: 40,
  reapGraceMs: 60,
};
const realChildBounds: ChildBounds = {
  ...fastBounds,
  deadlineMs: 2_500,
  termGraceMs: 250,
  closeGraceMs: 300,
  reapGraceMs: 250,
};

function fakeChild(killResult = true): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => killResult);
  return child;
}

async function loadWithSpawnMock(): Promise<RunnerModule> {
  vi.resetModules();
  vi.doMock('node:child_process', () => ({ spawn: spawnMock }));
  return import('../cli/src/transport/bounded-child-process.ts');
}

async function loadWithRealSpawn(): Promise<RunnerModule> {
  vi.resetModules();
  vi.doUnmock('node:child_process');
  return import('../cli/src/transport/bounded-child-process.ts');
}

function run(
  mod: RunnerModule,
  command: string,
  args: string[] = [],
  bounds: ChildBounds = fastBounds,
): Promise<{ outcome: ChildOutcome; calls: number }> {
  return new Promise((resolve) => {
    let calls = 0;
    let first: ChildOutcome | undefined;
    mod.runBoundedChild(command, args, { bounds }, (outcome) => {
      calls += 1;
      first ??= outcome;
      setImmediate(() => resolve({ outcome: first!, calls }));
    });
  });
}

function writeChild(source: string): { script: string; pidFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'bounded-child-'));
  fixtureDirs.push(dir);
  const script = join(dir, 'child');
  const pidFile = join(dir, 'pid');
  writeFileSync(script, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));\n${source}\n`);
  chmodSync(script, 0o755);
  return { script, pidFile };
}

function rememberPid(pidFile: string): number {
  const pid = Number(readFileSync(pidFile, 'utf8'));
  fixturePids.add(pid);
  return pid;
}

afterEach(() => {
  vi.doUnmock('node:child_process');
  vi.resetModules();
  spawnMock.mockReset();
  for (const pid of fixturePids) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already reaped */ }
  }
  fixturePids.clear();
  for (const dir of fixtureDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('runBoundedChild', () => {
  it('counts drained bytes, caps streams independently, and decodes split UTF-8 once', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const resultPromise = run(await loadWithSpawnMock(), 'fake');
    child.emit('spawn');
    const utf8 = Buffer.from('Đèn');
    child.stdout.emit('data', utf8.subarray(0, 1));
    child.stdout.emit('data', Buffer.concat([utf8.subarray(1), Buffer.alloc(70, 97)]));
    child.stderr.emit('data', Buffer.from('HEAD----middle----TAIL'));
    child.emit('close', 0, null);

    const { outcome } = await resultPromise;
    expect(outcome).toMatchObject({ spawned: true, exited: true, exitCode: 0, stdoutBytes: 75, stdoutTruncated: true, stderrBytes: 22, stderrTruncated: true });
    expect(outcome.stdout.startsWith('Đèn')).toBe(true);
    expect(outcome.stderr).toBe('HEAD--------TAIL');
    expect(Buffer.byteLength(outcome.stderr)).toBeLessThanOrEqual(fastBounds.stderrBytes);
    expect(outcome).toMatchObject({ stderrRetainedBytes: fastBounds.stderrBytes });
  });

  it('preserves split UTF-8 stderr exactly when observed bytes fit the cap', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const diagnostic = Buffer.from('Đèn sáng');
    const resultPromise = run(await loadWithSpawnMock(), 'fake', [], {
      ...fastBounds,
      stderrBytes: diagnostic.length,
    });
    child.emit('spawn');
    child.stderr.emit('data', diagnostic.subarray(0, 1));
    child.stderr.emit('data', diagnostic.subarray(1));
    child.emit('close', 0, null);

    expect((await resultPromise).outcome).toMatchObject({
      stderr: 'Đèn sáng',
      stderrBytes: diagnostic.length,
      stderrRetainedBytes: diagnostic.length,
      stderrTruncated: false,
    });
  });

  it('distinguishes a synchronous throw and pre-spawn error, settling each once', async () => {
    spawnMock.mockImplementationOnce(() => { throw new Error('sync failure'); });
    const thrown = await run(await loadWithSpawnMock(), 'fake');
    expect(thrown).toMatchObject({ calls: 1, outcome: { spawned: false, exited: false, launchError: 'sync failure' } });

    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const resultPromise = run(await loadWithSpawnMock(), 'fake');
    child.emit('error', new Error('ENOENT'));
    child.emit('close', -2, null);
    child.emit('error', new Error('late error'));
    const failed = await resultPromise;
    expect(failed).toMatchObject({ calls: 1, outcome: { spawned: false, exited: false, launchError: 'ENOENT' } });
  });

  it('treats close as exit evidence when a test double omits exit and removes listeners', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const resultPromise = run(await loadWithSpawnMock(), 'fake');
    child.emit('spawn');
    child.emit('close', 3, null);
    const { outcome } = await resultPromise;
    expect(outcome).toMatchObject({ spawned: true, exited: true, exitCode: 3 });
    await new Promise((resolve) => setTimeout(resolve, fastBounds.deadlineMs + 10));
    expect(child.kill).not.toHaveBeenCalled();
    expect(() => child.emit('error', new Error('late after cleanup'))).not.toThrow();
    expect(child.eventNames()).toEqual(['error']);
    expect(child.stdout.eventNames()).toEqual([]);
    expect(child.stderr.eventNames()).toEqual([]);
  });

  it('settles after exit when an inherited pipe prevents close', async () => {
    const grandchildPidFile = join(mkdtempSync(join(tmpdir(), 'bounded-grandchild-')), 'pid');
    fixtureDirs.push(join(grandchildPidFile, '..'));
    const { script } = writeChild(`
const {spawn}=require('node:child_process');
const grandchild=spawn(process.execPath,['-e',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(grandchildPidFile)},String(process.pid));setInterval(()=>{},1000)`)}],{stdio:['ignore',process.stdout,process.stderr]});
grandchild.unref();
grandchild.once('spawn',()=>process.exit(0));
console.log('complete');
`);
    const startedAt = Date.now();
    const { outcome } = await run(await loadWithRealSpawn(), script, [], realChildBounds);
    fixturePids.add(Number(readFileSync(grandchildPidFile, 'utf8')));
    expect(outcome).toMatchObject({ spawned: true, exited: true, exitCode: 0, stdout: 'complete\n' });
    expect(Date.now() - startedAt).toBeLessThan(4_500);
  });

  it('times out and terminates a real child with TERM', async () => {
    const term = writeChild('setInterval(()=>{},1000);');
    const termOutcome = (await run(await loadWithRealSpawn(), term.script, [], realChildBounds)).outcome;
    expect(termOutcome.launchError, JSON.stringify(termOutcome)).toBeUndefined();
    expect(termOutcome, JSON.stringify(termOutcome)).toMatchObject({ spawned: true, timedOut: true, exited: true });
    expect(existsSync(term.pidFile), JSON.stringify(termOutcome)).toBe(true);
    const termPid = rememberPid(term.pidFile);
    expect(termOutcome).toMatchObject({ timedOut: true, exited: true, signal: 'SIGTERM' });
    expect(() => process.kill(termPid, 0)).toThrow();
  });

  it('escalates a real TERM-refusing child to KILL', async () => {
    const readyDir = mkdtempSync(join(tmpdir(), 'bounded-child-ready-'));
    fixtureDirs.push(readyDir);
    const readyFile = join(readyDir, 'term-handler-ready');
    const kill = writeChild(`process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(readyFile)},'ready');setInterval(()=>{},1000);`);
    const killOutcome = (await run(await loadWithRealSpawn(), kill.script, [], realChildBounds)).outcome;
    const killPid = rememberPid(kill.pidFile);
    expect(existsSync(readyFile), JSON.stringify(killOutcome)).toBe(true);
    expect(killOutcome).toMatchObject({ timedOut: true, exited: true, signal: 'SIGKILL' });
    expect(() => process.kill(killPid, 0)).toThrow();
  });

  it('bounds an unkillable fake child even when kill reports false', async () => {
    const child = fakeChild(false);
    spawnMock.mockReturnValue(child);
    const resultPromise = run(await loadWithSpawnMock(), 'fake');
    child.emit('spawn');

    const { outcome, calls } = await resultPromise;
    expect(calls).toBe(1);
    expect(outcome).toMatchObject({ spawned: true, exited: false, timedOut: true });
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
    child.emit('close', 0, null);
    expect(() => child.emit('error', new Error('late unconfirmed-child error'))).not.toThrow();
    expect(child.eventNames()).toEqual(['error']);
  });
});
