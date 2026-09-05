import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeAdvertisement } from '../cli/src/transport/broker-discovery.ts';
import { writeLastPluginsAtomic } from '../cli/src/transport/last-plugins-log.ts';
import { MutationAdmissionGate } from '../cli/src/transport/mutation-admission-gate.ts';

const fixtures: string[] = [];
const fixedNow = 1788585900000;
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fa-private-write-'));
  fixtures.push(dir);
  return dir;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const writers = [
  { name: 'advertisement', temporary: (target: string) => `${target}.${process.pid}.tmp`,
    write: (target: string) => writeAdvertisement(12345, fixedNow, target) },
  { name: 'last plugin snapshot', temporary: (target: string) => `${target}.${process.pid}.tmp`,
    write: (target: string) => writeLastPluginsAtomic(target, [{ instanceId: 'fixture', fileName: 'Fixture', lastSeenAt: fixedNow }]) },
  { name: 'mutation gate', temporary: (target: string) => `${target}.${process.pid}.${fixedNow}.tmp`,
    write: (target: string) => {
      const result = new MutationAdmissionGate(target).transition('fixture-raw-key', 'paused');
      if (!result.ok) throw new Error(result.error.code);
    } },
];

for (const writer of writers) {
  describe(writer.name, () => {
    it('preserves a prior complete snapshot and an existing temporary collision', () => {
      const dir = fixture();
      const target = join(dir, 'state.json');
      vi.spyOn(Date, 'now').mockReturnValue(fixedNow);
      writer.write(target);
      const before = readFileSync(target, 'utf8');
      const temporary = writer.temporary(target);
      writeFileSync(temporary, 'COLLISION');
      expect(() => writer.write(target)).toThrow();
      expect(readFileSync(target, 'utf8')).toBe(before);
      expect(readFileSync(temporary, 'utf8')).toBe('COLLISION');
    });

    for (const kind of ['file', 'symlink', 'dangling symlink', 'directory'] as const) {
      it(`refuses a pre-existing temporary ${kind} without touching it or another file`, () => {
        const dir = fixture();
        const target = join(dir, 'state.json');
        const victim = join(dir, 'owned-sentinel.txt');
        const temporary = writer.temporary(target);
        writeFileSync(victim, 'KEEP');
        if (kind === 'file') writeFileSync(temporary, 'COLLISION');
        else if (kind === 'directory') mkdirSync(temporary);
        else symlinkSync(kind === 'symlink' ? victim : join(dir, 'absent.txt'), temporary);
        vi.spyOn(Date, 'now').mockReturnValue(fixedNow);
        expect(() => writer.write(target)).toThrow();
        expect(readFileSync(victim, 'utf8')).toBe('KEEP');
        expect(existsSync(target)).toBe(false);
        expect(existsSync(join(dir, 'absent.txt'))).toBe(false);
        const entry = lstatSync(temporary);
        expect(entry.isSymbolicLink()).toBe(kind.includes('symlink'));
        if (kind === 'file') expect(readFileSync(temporary, 'utf8')).toBe('COLLISION');
      });
    }

    it('creates and replaces a complete owner-only regular file without temporary residue', () => {
      const dir = fixture();
      const target = join(dir, 'state.json');
      vi.spyOn(Date, 'now').mockReturnValue(fixedNow);
      const priorMask = process.umask(0);
      try { writer.write(target); } finally { process.umask(priorMask); }
      expect(() => JSON.parse(readFileSync(target, 'utf8'))).not.toThrow();
      expect(statSync(target).mode & 0o777).toBe(0o600);
      chmodSync(target, 0o644);
      writer.write(target);
      expect(statSync(target).mode & 0o777).toBe(0o600);
      expect(lstatSync(target).isFile()).toBe(true);
      expect(readdirSync(dir)).toEqual(['state.json']);
    });
  });
}
