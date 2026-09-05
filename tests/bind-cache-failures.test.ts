import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const faults = vi.hoisted(() => ({ stage: '', descriptors: [] as number[] }));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  const failure = Object.assign(new Error('controlled filesystem refusal'), { code: 'EIO' });
  return { ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      const fd = fs.openSync(...args);
      if (args[1] === 'wx') faults.descriptors.push(fd);
      return fd;
    },
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      if (faults.stage === 'write') {
        if (typeof args[0] === 'number') fs.writeSync(args[0], 'partial');
        else fs.writeFileSync(args[0], 'partial');
        throw failure;
      }
      return fs.writeFileSync(...args);
    },
    closeSync: (fd: number) => {
      fs.closeSync(fd);
      if (faults.stage === 'close') throw failure;
    },
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      if (faults.stage === 'rename') throw failure;
      return fs.renameSync(...args);
    },
  };
});
import { writeBindCache } from '../cli/src/transport/project-bind.ts';

let dir: string;
let destination: string;
const previous = process.env['FIGMA_AGENT_BINDS_FILE'];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fa-bind-cache-fault-'));
  destination = join(dir, 'binds.json');
  process.env['FIGMA_AGENT_BINDS_FILE'] = destination;
  writeFileSync(destination, 'PRIOR');
});
afterEach(() => {
  faults.stage = '';
  faults.descriptors.length = 0;
  if (previous === undefined) delete process.env['FIGMA_AGENT_BINDS_FILE'];
  else process.env['FIGMA_AGENT_BINDS_FILE'] = previous;
  rmSync(dir, { recursive: true, force: true });
});

it.each(['write', 'close', 'rename'])('preserves the previous cache and closes owned descriptors after %s refusal', (stage) => {
  faults.stage = stage;
  const result = writeBindCache(['owned']);
  expect(readFileSync(destination, 'utf8')).toBe('PRIOR');
  expect(result).toEqual({ ok: false, error: { code: 'EIO' } });
  expect(readdirSync(dir)).toEqual(['binds.json']);
  expect(faults.descriptors.length).toBeGreaterThan(0);
  for (const fd of faults.descriptors) expect(() => fstatSync(fd)).toThrow();
});
