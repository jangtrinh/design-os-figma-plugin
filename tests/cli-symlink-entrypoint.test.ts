import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI_DIST = fileURLToPath(new URL('../cli/dist/figma-agent.js', import.meta.url));

describe('CLI symlink entrypoint', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'figma-agent-entrypoint-'));
  const symlinkPath = join(tempDir, 'figma-agent');
  const preservedTempDir = mkdtempSync(join(ROOT, '.figma-agent-entrypoint-'));
  const preservedSymlinkPath = join(preservedTempDir, 'figma-agent');

  beforeAll(() => {
    const build = spawnSync(process.execPath, ['scripts/build.mjs', 'cli'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(build.status, build.stderr).toBe(0);
    symlinkSync(CLI_DIST, symlinkPath, 'file');
    symlinkSync(CLI_DIST, preservedSymlinkPath, 'file');
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(preservedTempDir, { recursive: true, force: true });
  });

  it('dispatches help identically through the real path and a filesystem symlink', () => {
    const direct = spawnSync(process.execPath, [CLI_DIST, '--help'], { encoding: 'utf8' });
    const linked = spawnSync(process.execPath, [symlinkPath, '--help'], { encoding: 'utf8' });

    expect(direct.status, direct.stderr).toBe(0);
    expect(linked.status, linked.stderr).toBe(direct.status);
    expect(linked.stdout).toBe(direct.stdout);
    expect(linked.stdout).not.toBe('');
  });

  it('dispatches through a symlink when Node preserves the main module path', () => {
    const direct = spawnSync(process.execPath, [CLI_DIST, '--help'], { encoding: 'utf8' });
    const linked = spawnSync(process.execPath, ['--preserve-symlinks-main', preservedSymlinkPath, '--help'], {
      encoding: 'utf8',
    });

    expect(linked.status, linked.stderr).toBe(direct.status);
    expect(linked.stdout).toBe(direct.stdout);
    expect(linked.stdout).not.toBe('');
  });

  it('does not dispatch or throw when imported with a missing process entry path', () => {
    const importScript = [
      "import { pathToFileURL } from 'node:url';",
      `process.argv[1] = ${JSON.stringify(join(tempDir, 'missing-entrypoint.js'))};`,
      `await import(pathToFileURL(${JSON.stringify(CLI_DIST)}).href);`,
      "process.stdout.write('imported');",
    ].join('\n');
    const imported = spawnSync(process.execPath, ['--input-type=module', '--eval', importScript], {
      encoding: 'utf8',
    });

    expect(imported.status, imported.stderr).toBe(0);
    expect(imported.stdout).toBe('imported');
  });
});
