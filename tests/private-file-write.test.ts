import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, fstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const faults = vi.hoisted(() => ({
  write: null as Error | null,
  close: null as Error | null,
  rename: null as Error | null,
  descriptors: [] as number[],
}));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      const fd = fs.openSync(...args);
      if (args[1] === 'wx') faults.descriptors.push(fd);
      return fd;
    },
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      if (faults.write && typeof args[0] === 'number') {
        fs.writeSync(args[0], 'partial');
        throw faults.write;
      }
      return fs.writeFileSync(...args);
    },
    closeSync: (fd: number) => {
      fs.closeSync(fd);
      if (faults.close) throw faults.close;
    },
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      if (faults.rename) throw faults.rename;
      return fs.renameSync(...args);
    },
  };
});
import { writePrivateFileExclusive } from '../cli/src/transport/private-file-write.ts';
import { writeAdvertisement } from '../cli/src/transport/broker-discovery.ts';
import { writeLastPluginsAtomic } from '../cli/src/transport/last-plugins-log.ts';
import { MutationAdmissionGate } from '../cli/src/transport/mutation-admission-gate.ts';

const fixtures: string[] = [];
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fa-private-write-fault-'));
  fixtures.push(dir);
  return dir;
}
afterEach(() => {
  faults.write = faults.close = faults.rename = null;
  faults.descriptors.length = 0;
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function expectClosed(): void {
  expect(faults.descriptors.length).toBeGreaterThan(0);
  for (const fd of faults.descriptors) expect(() => fstatSync(fd)).toThrow();
}

describe('exclusive file ownership on I/O failure', () => {
  it('removes a partial owned write and closes its descriptor while preserving the write error', () => {
    const target = join(fixture(), 'temporary');
    const failure = new Error('controlled disk full');
    faults.write = failure;
    expect(() => writePrivateFileExclusive(target, 'complete')).toThrow(failure);
    expect(existsSync(target)).toBe(false);
    expectClosed();
  });

  it('removes an owned temporary file when close reports an error', () => {
    const target = join(fixture(), 'temporary');
    const failure = new Error('controlled close failure');
    faults.close = failure;
    expect(() => writePrivateFileExclusive(target, 'complete')).toThrow(failure);
    expect(existsSync(target)).toBe(false);
    expectClosed();
  });

  it('preserves the write failure when cleanup also reports a close failure', () => {
    const target = join(fixture(), 'temporary');
    const failure = new Error('controlled write failure');
    faults.write = failure;
    faults.close = new Error('controlled cleanup close failure');
    expect(() => writePrivateFileExclusive(target, 'complete')).toThrow(failure);
    expect((failure as Error & { cleanupError?: unknown }).cleanupError).toBe(faults.close);
    expect(existsSync(target)).toBe(false);
    expectClosed();
  });
});

for (const kind of ['advertisement', 'last plugins', 'mutation gate'] as const) {
  it(`${kind} keeps its prior complete snapshot if rename fails`, () => {
    const dir = fixture();
    const target = join(dir, 'state.json');
    const write = () => {
      if (kind === 'advertisement') writeAdvertisement(12345, 1, target);
      else if (kind === 'last plugins') writeLastPluginsAtomic(target, []);
      else {
        const result = new MutationAdmissionGate(target).transition('fixture-key', 'paused');
        if (!result.ok) throw new Error(result.error.message);
      }
    };
    write();
    const before = readFileSync(target, 'utf8');
    const failure = new Error('controlled rename failure');
    faults.rename = failure;
    expect(write).toThrow('controlled rename failure');
    expect(readFileSync(target, 'utf8')).toBe(before);
    expect(readdirSync(dir)).toEqual(['state.json']);
    expectClosed();
  });
}
