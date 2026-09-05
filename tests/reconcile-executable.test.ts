import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectReconcileExecutable } from '../cli/src/transport/reconcile-executable.ts';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'kernel-selection-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
function executable(directory: string, executable = true): string {
  const dir = join(root, directory);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'ui');
  writeFileSync(file, 'fixture');
  chmodSync(file, executable ? 0o700 : 0o600);
  return file;
}

describe.skipIf(process.platform === 'win32')('POSIX executable selection', () => {
  it('skips nonexecutables, directories and dangling links without losing PATH order', () => {
    executable('nonexecutable', false);
    mkdirSync(join(root, 'directory', 'ui'), { recursive: true });
    mkdirSync(join(root, 'dangling'));
    symlinkSync(join(root, 'missing'), join(root, 'dangling', 'ui'));
    const selected = executable('valid');
    executable('later');
    const PATH = ['nonexecutable', 'directory', 'dangling', 'valid', 'later'].join(':');
    expect(selectReconcileExecutable(root, { PATH })).toEqual({ uiCommand: 'ui', uiExecutable: selected });
  });
  it('resolves an empty PATH entry against the child cwd', () => {
    const selected = executable('');
    expect(selectReconcileExecutable(root, { PATH: '' })).toEqual({ uiCommand: 'ui', uiExecutable: selected });
  });
  it('preserves a selected symlink as the absolute launch path', () => {
    const target = executable('actual');
    mkdirSync(join(root, 'linked'));
    const selected = join(root, 'linked', 'ui');
    symlinkSync(target, selected);
    expect(selectReconcileExecutable(root, { PATH: 'linked' })).toEqual({ uiCommand: 'ui', uiExecutable: selected });
  });
  it('resolves an override command name through PATH without splitting arguments', () => {
    const selected = executable('bin');
    expect(selectReconcileExecutable(root, { FIGMA_AGENT_UI_BIN: 'ui', PATH: 'bin' })).toEqual({ uiCommand: 'ui', uiExecutable: selected });
    expect(selectReconcileExecutable(root, { FIGMA_AGENT_UI_BIN: 'ui --flag', PATH: 'bin' })).toEqual({ uiCommand: 'ui --flag', uiExecutable: null });
  });
});
