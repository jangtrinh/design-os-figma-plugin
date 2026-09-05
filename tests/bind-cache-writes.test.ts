import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBindCache, writeBindCache } from '../cli/src/transport/project-bind.ts';

let dir: string;
let destination: string;
const previous = process.env['FIGMA_AGENT_BINDS_FILE'];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fa-bind-cache-write-'));
  destination = join(dir, 'binds.json');
  process.env['FIGMA_AGENT_BINDS_FILE'] = destination;
});
afterEach(() => {
  if (previous === undefined) delete process.env['FIGMA_AGENT_BINDS_FILE'];
  else process.env['FIGMA_AGENT_BINDS_FILE'] = previous;
  rmSync(dir, { recursive: true, force: true });
});

describe('private atomic binding restart cache', () => {
  it('writes and replaces complete deduplicated snapshots with owner-only mode', () => {
    const mask = process.umask(0);
    try { writeBindCache(['owned-a', 'owned-a']); } finally { process.umask(mask); }
    expect(statSync(destination).mode & 0o777).toBe(0o600);
    expect(readBindCache()).toEqual({ v: 1, projectDirs: ['owned-a'] });
    chmodSync(destination, 0o644);
    expect(writeBindCache(['owned-b'])).toEqual({ ok: true });
    expect(statSync(destination).mode & 0o777).toBe(0o600);
    expect(readBindCache()).toEqual({ v: 1, projectDirs: ['owned-b'] });
    expect(readdirSync(dir)).toEqual(['binds.json']);
  });

  it.each(['file', 'directory', 'symlink', 'dangling symlink'])('preserves a temporary %s collision and the prior snapshot', (kind) => {
    writeFileSync(destination, '{"v":1,"projectDirs":["prior"]}');
    const sentinel = join(dir, 'sentinel');
    const temporary = `${destination}.${process.pid}.tmp`;
    writeFileSync(sentinel, 'KEEP');
    if (kind === 'file') writeFileSync(temporary, 'COLLISION');
    else if (kind === 'directory') mkdirSync(temporary);
    else symlinkSync(kind === 'symlink' ? sentinel : join(dir, 'absent'), temporary);
    expect(writeBindCache(['replacement'])).toMatchObject({ ok: false, error: { code: 'EEXIST' } });
    expect(readBindCache()).toEqual({ v: 1, projectDirs: ['prior'] });
    expect(readFileSync(sentinel, 'utf8')).toBe('KEEP');
    expect(lstatSync(temporary).isSymbolicLink()).toBe(kind.includes('symlink'));
    if (kind === 'file') expect(readFileSync(temporary, 'utf8')).toBe('COLLISION');
    expect(existsSync(join(dir, 'absent'))).toBe(false);
  });

  it('replaces the destination symlink without writing its referent', () => {
    const sentinel = join(dir, 'sentinel');
    writeFileSync(sentinel, 'KEEP');
    symlinkSync(sentinel, destination);
    writeBindCache(['owned']);
    expect(readFileSync(sentinel, 'utf8')).toBe('KEEP');
    expect(lstatSync(destination).isFile()).toBe(true);
    expect(readBindCache().projectDirs).toEqual(['owned']);
  });

  it('reports a missing parent without inventing success or creating directories', () => {
    process.env['FIGMA_AGENT_BINDS_FILE'] = join(dir, 'absent', 'binds.json');
    expect(writeBindCache(['owned'])).toMatchObject({ ok: false, error: { code: 'ENOENT' } });
    expect(readdirSync(dir)).toEqual([]);
  });
});
