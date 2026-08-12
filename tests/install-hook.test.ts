// `install-hook` unit tests — always pass an explicit --settings pointing inside
// a scratch tmpdir. NEVER writes to the real ~/.claude/settings.json — this is a
// one-way-door file (a user's real config), so this suite is fixture-only by
// construction, never conditionally, and there is no code path here that can
// reach the real path.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandArgs } from '../cli/src/arg-parse.ts';
import { run } from '../cli/src/commands/install-hook.ts';

function fakeArgs(flags: Record<string, string | boolean> = {}): CommandArgs {
  return {
    positionals: [],
    str: (name) => (typeof flags[name] === 'string' ? (flags[name] as string) : undefined),
    req: (name) => {
      const v = flags[name];
      if (typeof v !== 'string') throw new Error(`missing --${name}`);
      return v;
    },
    num: (name) => (typeof flags[name] === 'string' ? Number(flags[name]) : undefined),
    bool: (name) => flags[name] === true || flags[name] === 'true',
  };
}

let scratchDir: string;

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'fa-install-hook-'));
});
afterEach(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

describe('install-hook — fixture-only, never the real settings.json', () => {
  it('file does not exist yet, --yes → creates it with the SessionStart hook', async () => {
    const settings = join(scratchDir, 'settings.json');
    const result = await run(fakeArgs({ settings, yes: true }));
    expect(result.status).toBe('installed');
    expect(existsSync(settings)).toBe(true);
    const written = JSON.parse(readFileSync(settings, 'utf8')) as { hooks: { SessionStart: { hooks: { command: string }[] }[] } };
    expect(written.hooks.SessionStart[0].hooks[0].command).toContain('figma-agent status --peek');
    expect(result.backupPath).toBeNull(); // nothing existed to back up
  });

  it('existing valid settings.json, --yes → backs up before writing, preserves other keys', async () => {
    const settings = join(scratchDir, 'settings.json');
    writeFileSync(settings, JSON.stringify({ someOtherKey: true }, null, 2));
    const result = await run(fakeArgs({ settings, yes: true }));
    expect(result.status).toBe('installed');
    expect(result.backupPath).toMatch(/\.bak-\d+$/);
    expect(existsSync(result.backupPath as string)).toBe(true);
    const written = JSON.parse(readFileSync(settings, 'utf8')) as Record<string, unknown>;
    expect(written.someOtherKey).toBe(true);
  });

  it('already contains the identical hook command → unchanged, no write, no backup', async () => {
    const settings = join(scratchDir, 'settings.json');
    const already = {
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: 'command -v figma-agent >/dev/null 2>&1 && figma-agent status --peek --json || true' }] },
        ],
      },
    };
    writeFileSync(settings, JSON.stringify(already, null, 2));
    const before = readFileSync(settings, 'utf8');
    const result = await run(fakeArgs({ settings, yes: true }));
    expect(result.status).toBe('unchanged');
    expect(readFileSync(settings, 'utf8')).toBe(before);
    expect(result.backupPath).toBeNull();
  });

  it('--dry-run prints the resulting JSON but writes nothing', async () => {
    const settings = join(scratchDir, 'settings.json');
    const result = await run(fakeArgs({ settings, 'dry-run': true }));
    expect(result.status).toBe('dry-run');
    expect(existsSync(settings)).toBe(false);
    expect(result.preview).toContain('figma-agent status --peek');
  });

  it('invalid JSON → aborts untouched, no backup, no write', async () => {
    const settings = join(scratchDir, 'settings.json');
    writeFileSync(settings, '{ not valid json');
    await expect(run(fakeArgs({ settings, yes: true }))).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
    expect(readFileSync(settings, 'utf8')).toBe('{ not valid json');
    expect(readdirSync(scratchDir)).toEqual(['settings.json']); // no .bak file created
  });

  it('non-interactive, no --yes, no --dry-run → refuses without writing', async () => {
    const settings = join(scratchDir, 'settings.json');
    await expect(run(fakeArgs({ settings }))).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
    expect(existsSync(settings)).toBe(false);
  });

  it("preserves the original file's indentation width", async () => {
    const settings = join(scratchDir, 'settings.json');
    writeFileSync(settings, JSON.stringify({ a: 1 }, null, 4));
    await run(fakeArgs({ settings, yes: true }));
    expect(readFileSync(settings, 'utf8')).toMatch(/\n    "a": 1/);
  });
});
