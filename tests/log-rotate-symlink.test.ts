import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rotateIfNeeded } from '../cli/src/transport/log-rotate.ts';
import {
  appendDisconnectRecord,
  rotateDisconnectLog,
  type DisconnectRecord,
} from '../cli/src/transport/disconnect-log.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fa-rotate-harden-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('rotateIfNeeded — symlink hardening', () => {
  it('refuses to rotate when target path is a symlink', () => {
    const realFile = join(dir, 'real.log');
    const symlinkFile = join(dir, 'symlink.log');
    writeFileSync(realFile, 'x'.repeat(200));
    symlinkSync(realFile, symlinkFile);

    expect(() => rotateIfNeeded(symlinkFile, { maxBytes: 100, keep: 3 })).toThrow(/symlink/i);
    expect(lstatSync(symlinkFile).isSymbolicLink()).toBe(true);
  });

  it('refuses to rotate when an archive path is a symlink', () => {
    const targetFile = join(dir, 'app.log');
    const archive1 = `${targetFile}.1`;
    const victim = join(dir, 'victim.txt');
    writeFileSync(targetFile, 'x'.repeat(200));
    writeFileSync(victim, 'safe content');
    symlinkSync(victim, archive1);

    expect(() => rotateIfNeeded(targetFile, { maxBytes: 100, keep: 3 })).toThrow(/symlink/i);
    expect(readFileSync(victim, 'utf8')).toBe('safe content');
  });

  it('refuses to rotate when the rotation marker path is a symlink', () => {
    const targetFile = join(dir, 'app.log');
    const markerPath = `${targetFile}.rotated.json`;
    const victim = join(dir, 'victim.txt');
    writeFileSync(targetFile, 'x'.repeat(200));
    writeFileSync(victim, 'safe content');
    symlinkSync(victim, markerPath);

    expect(() => rotateIfNeeded(targetFile, { maxBytes: 100, keep: 3 })).toThrow(/symlink/i);
    expect(readFileSync(victim, 'utf8')).toBe('safe content');
  });
});

describe('rotateDisconnectLog — end-to-end rotation of figma-disconnects.jsonl', () => {
  it('rotates figma-disconnects.jsonl and preserves archive generation', () => {
    const recordFile = join(dir, 'figma-disconnects.jsonl');
    const record: DisconnectRecord = {
      at: new Date().toISOString(),
      instanceId: 'inst_rotate_test',
      fileName: 'Test File',
      fileKey: 'test_key',
      closeCode: 1000,
      closeReason: 'done',
      closedBy: 'peer',
      superseded: false,
      msSinceLastSeen: 0,
      msSinceLastAppFrame: 0,
      socketOpenForMs: 100,
      inFlightJobs: [],
      queueDepthByFile: {},
    };

    appendDisconnectRecord(recordFile, record);
    expect(existsSync(recordFile)).toBe(true);
    const initialContent = readFileSync(recordFile, 'utf8');

    // Trigger rotation with small maxBytes policy
    rotateIfNeeded(recordFile, { maxBytes: 10, keep: 3 });

    expect(existsSync(`${recordFile}.1`)).toBe(true);
    expect(readFileSync(`${recordFile}.1`, 'utf8')).toBe(initialContent);
    expect(readFileSync(recordFile, 'utf8')).toBe('');

    // Calling rotateDisconnectLog works cleanly
    rotateDisconnectLog(recordFile);
  });
});
