// `install-skill` unit tests — always pass an explicit --folder inside a scratch
// tmpdir; NEVER exercises the real ~/.claude/skills folder. vitest's own process
// has no controlling TTY, so the default (no explicit flag) path below exercises
// the non-interactive branches; the interactive Y/n prompt path is covered
// indirectly via --yes (its "skip the prompt" branch) since driving a real
// readline prompt from a non-TTY test process is not a meaningful seam here.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommandArgs } from '../cli/src/arg-parse.ts';
import { run } from '../cli/src/commands/install-skill.ts';
import { CLI_VERSION } from '../cli/src/version.ts';
import { renderSkill } from '../cli/src/skill-emitter.ts';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CLI_DIST = join(ROOT, 'cli', 'dist', 'figma-agent.js');
const CRAFT_SKILL_DIR = 'es-figma-craft';

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
  scratchDir = mkdtempSync(join(tmpdir(), 'fa-install-skill-'));
});
afterEach(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

describe('install-skill — writes the emitted SKILL.md, never a stale copy', () => {
  it('fresh folder: creates figma-agent/SKILL.md matching renderSkill()', async () => {
    const folder = join(scratchDir, 'skills');
    const result = await run(fakeArgs({ folder, 'no-craft': true }));
    const skillPath = join(folder, 'figma-agent', 'SKILL.md');
    expect(existsSync(skillPath)).toBe(true);
    expect(readFileSync(skillPath, 'utf8')).toBe(renderSkill());
    expect(result.installed).toContain(skillPath);
    expect(result.version).toBe(CLI_VERSION);
  });

  it('same version already installed → unchanged, no write', async () => {
    const folder = join(scratchDir, 'skills');
    await run(fakeArgs({ folder, 'no-craft': true }));
    const skillPath = join(folder, 'figma-agent', 'SKILL.md');
    const before = readFileSync(skillPath, 'utf8');
    const result = await run(fakeArgs({ folder, 'no-craft': true }));
    expect(readFileSync(skillPath, 'utf8')).toBe(before);
    expect(result.skipped.some((s) => s.path === skillPath && s.reason.includes('unchanged'))).toBe(true);
  });

  it('older version present, --yes → overwrites without prompting', async () => {
    const folder = join(scratchDir, 'skills');
    mkdirSync(join(folder, 'figma-agent'), { recursive: true });
    writeFileSync(join(folder, 'figma-agent', 'SKILL.md'), '---\nname: figma-agent\nversion: 0.0.1\n---\nstale');
    const result = await run(fakeArgs({ folder, 'no-craft': true, yes: true }));
    const skillPath = join(folder, 'figma-agent', 'SKILL.md');
    expect(readFileSync(skillPath, 'utf8')).toBe(renderSkill());
    expect(result.installed).toContain(skillPath);
  });

  it('older version present, non-interactive, no --yes → refuses to overwrite silently', async () => {
    const folder = join(scratchDir, 'skills');
    mkdirSync(join(folder, 'figma-agent'), { recursive: true });
    const stale = '---\nname: figma-agent\nversion: 0.0.1\n---\nstale';
    writeFileSync(join(folder, 'figma-agent', 'SKILL.md'), stale);
    const result = await run(fakeArgs({ folder, 'no-craft': true }));
    expect(readFileSync(join(folder, 'figma-agent', 'SKILL.md'), 'utf8')).toBe(stale);
    expect(result.installed).toEqual([]);
    expect(result.skipped.some((s) => s.reason.includes('declined'))).toBe(true);
  });

  it('--with-craft and --no-craft together refuse with E_INVALID_ARGS', async () => {
    await expect(
      run(fakeArgs({ folder: join(scratchDir, 'skills'), 'with-craft': true, 'no-craft': true })),
    ).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
  });

  it('non-interactive with neither --with-craft nor --no-craft skips craft and says so', async () => {
    const folder = join(scratchDir, 'skills');
    const result = await run(fakeArgs({ folder }));
    const craftEntry = result.skipped.find((s) => s.path === join(folder, 'es-figma-craft'));
    expect(craftEntry?.reason).toContain('non-interactive');
  });

  it('--no-craft skips it explicitly, no prompt', async () => {
    const folder = join(scratchDir, 'skills');
    const result = await run(fakeArgs({ folder, 'no-craft': true }));
    const craftEntry = result.skipped.find((s) => s.path === join(folder, 'es-figma-craft'));
    expect(craftEntry?.reason).toBe('skipped: --no-craft');
    expect(existsSync(join(folder, 'es-figma-craft'))).toBe(false);
  });

  it("--with-craft copies the repo's skills/es-figma-craft directory (source-tree seam)", async () => {
    // Exercises the path arithmetic when this module is imported straight from
    // cli/src/commands/ (what THIS test process does) — see the describe block
    // below for the same behavior exercised against the built cli/dist bundle,
    // which is what a real install actually runs.
    const folder = join(scratchDir, 'skills');
    const result = await run(fakeArgs({ folder, 'with-craft': true }));
    const craftDest = join(folder, 'es-figma-craft');
    expect(existsSync(join(craftDest, 'SKILL.md'))).toBe(true);
    expect(result.installed).toContain(craftDest);
  });

  it('--with-craft on an already-installed craft folder: unchanged if identical, refuses to silently overwrite if edited', async () => {
    const folder = join(scratchDir, 'skills');
    await run(fakeArgs({ folder, 'with-craft': true }));
    const craftDest = join(folder, 'es-figma-craft');
    const before = readFileSync(join(craftDest, 'SKILL.md'), 'utf8');

    // Re-running with an identical install is a no-op, not a re-copy.
    const same = await run(fakeArgs({ folder, 'with-craft': true }));
    expect(readFileSync(join(craftDest, 'SKILL.md'), 'utf8')).toBe(before);
    expect(same.skipped.some((s) => s.path === craftDest && s.reason.includes('unchanged'))).toBe(true);

    // A user-edited craft folder must not be silently clobbered without --yes.
    writeFileSync(join(craftDest, 'SKILL.md'), 'a user made local edits here');
    const edited = await run(fakeArgs({ folder, 'with-craft': true }));
    expect(readFileSync(join(craftDest, 'SKILL.md'), 'utf8')).toBe('a user made local edits here');
    expect(edited.installed).not.toContain(craftDest);
    expect(edited.skipped.some((s) => s.path === craftDest && s.reason.includes('declined'))).toBe(true);
  });
});

describe('install-skill --with-craft — subprocess, against the BUILT cli/dist bundle', () => {
  beforeAll(() => {
    execFileSync(process.execPath, ['scripts/build.mjs', 'cli'], { cwd: ROOT });
  });

  it('copies skills/es-figma-craft from the shipped binary, not just from source', () => {
    const folder = join(scratchDir, 'skills');
    const out = execFileSync(process.execPath, [CLI_DIST, 'install-skill', '--folder', folder, '--with-craft', '--yes'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    const result = JSON.parse(out) as { installed: string[]; skipped: { path: string; reason: string }[] };
    const craftDest = join(folder, 'es-figma-craft');
    expect(existsSync(join(craftDest, 'SKILL.md'))).toBe(true);
    expect(result.installed).toContain(craftDest);
    expect(result.skipped).toEqual([]);
  });

  it('an explicit --with-craft that cannot be satisfied exits non-zero with a named reason, never a silent success', () => {
    // Simulate "unsatisfiable" against the REAL built bundle + real repoRoot()
    // resolution by briefly renaming the repo's own skills/es-figma-craft out of
    // the way — this exercises the actual anchor-walk this fix relies on,
    // without needing a relocated copy of node_modules for a bundle that
    // externals `ws`. Window is a single synchronous subprocess call.
    const realCraft = join(ROOT, 'skills', CRAFT_SKILL_DIR);
    const movedAside = `${realCraft}.__test-moved-aside__`;
    renameSync(realCraft, movedAside);
    try {
      const folder = join(scratchDir, 'skills-2');
      let threw: { status: number | null; stdout: string } | null = null;
      try {
        execFileSync(process.execPath, [CLI_DIST, 'install-skill', '--folder', folder, '--with-craft', '--yes'], {
          cwd: ROOT,
          encoding: 'utf8',
        });
      } catch (err) {
        const e = err as { status: number | null; stdout: string };
        threw = { status: e.status, stdout: e.stdout };
      }
      expect(threw).not.toBeNull();
      expect(threw?.status).not.toBe(0);
      const parsed = JSON.parse(threw?.stdout ?? '{}') as { error?: { code?: string; message?: string } };
      expect(parsed.error?.code).toBe('E_INVALID_ARGS');
      expect(parsed.error?.message).toContain('with-craft');
    } finally {
      renameSync(movedAside, realCraft);
    }
  });
});
