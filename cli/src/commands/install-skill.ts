// `figma-agent install-skill` — writes THIS CLI's own emitted SKILL.md into a
// Claude Code skills folder. Never copies the committed skills/figma-agent/SKILL.md
// (that risks shipping a stale artifact) — always renders fresh from the SAME
// emitter `npm run emit:skill` uses, so the installed copy always matches the
// binary that installed it.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import type { CommandArgs } from '../figma-agent.ts';
import { CliError } from '../transport/protocol-helpers.ts';
import { renderSkill } from '../skill-emitter.ts';
import { CLI_VERSION } from '../version.ts';

const CRAFT_SKILL_DIR = 'es-figma-craft';

interface InstallSkillResult {
  folder: string;
  installed: string[];
  skipped: { path: string; reason: string }[];
  version: string;
  verify: string;
}

/** Match only the FIRST `version:` line inside the leading `---` frontmatter block —
 *  a stray `version:` mentioned later in the skill's prose must never be read as it. */
function frontmatterVersion(content: string): string | null {
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;
  const line = fm[1].split('\n').find((l) => l.startsWith('version:'));
  return line ? line.slice('version:'.length).trim() : null;
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false; // a non-interactive default must never mean "yes"
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [Y/n] `)).trim().toLowerCase();
    return answer === '' || answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

/**
 * This install's own repo root — es-figma-craft ships alongside it, wherever
 * "it" is. Counting a fixed number of `..` from `import.meta.url` is wrong on
 * one of the two shapes this module ever runs as: three levels up is correct
 * from source (`cli/src/commands/install-skill.ts`) but one level too many from
 * the bundled entrypoint (`cli/dist/figma-agent.js`), landing ABOVE the repo.
 * `package.json` is the one anchor present at the root in both shapes (source
 * checkout and built/installed package alike) — walk up until it's found,
 * instead of hardcoding how deep this file sits.
 */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break; // reached the filesystem root without finding one
    dir = parent;
  }
  // A plain Error, not CliError — printErrorJson maps any non-CliError to E_INTERNAL,
  // and this really is an internal-consistency failure (a broken install), not a
  // caller mistake with a code an agent should branch on.
  throw new Error(`could not locate this install's own package.json while walking up from ${import.meta.url}`);
}

/**
 * Copy `craftSrc` (skills/es-figma-craft) into `craftDest`, with the same
 * never-overwrite-silently protection `run()` gives SKILL.md — an entire
 * bundled skill folder has no single version field to compare, so this
 * compares its anchor file's (SKILL.md) content instead: identical → no-op,
 * different → confirm (or `--yes`) before clobbering a user's local edits.
 */
async function installCraftFolder(
  craftSrc: string,
  craftDest: string,
  yes: boolean,
): Promise<{ installed: boolean; reason: string }> {
  if (existsSync(craftDest)) {
    const srcSkill = join(craftSrc, 'SKILL.md');
    const destSkill = join(craftDest, 'SKILL.md');
    const identical = existsSync(destSkill) && existsSync(srcSkill)
      && readFileSync(srcSkill, 'utf8') === readFileSync(destSkill, 'utf8');
    if (identical) return { installed: false, reason: 'unchanged (already installed)' };
    if (!yes) {
      const ok = await confirm(`overwrite the existing ${CRAFT_SKILL_DIR} folder at ${craftDest}?`);
      if (!ok) return { installed: false, reason: 'declined overwrite of existing install' };
    }
  }
  cpSync(craftSrc, craftDest, { recursive: true });
  return { installed: true, reason: '' };
}

export async function run(args: CommandArgs): Promise<InstallSkillResult> {
  if (args.bool('with-craft') && args.bool('no-craft')) {
    throw new CliError('E_INVALID_ARGS', '--with-craft and --no-craft are mutually exclusive');
  }
  const folder = args.str('folder') ?? join(homedir(), '.claude', 'skills');
  const yes = args.bool('yes');
  const installed: string[] = [];
  const skipped: { path: string; reason: string }[] = [];

  const skillPath = join(folder, 'figma-agent', 'SKILL.md');
  const freshSkill = renderSkill();
  let writeSkill = true;
  if (existsSync(skillPath)) {
    const existingContent = readFileSync(skillPath, 'utf8');
    if (existingContent === freshSkill) {
      // Exact-content match wins over any version check — a same-version file
      // whose bytes differ (e.g. installed before an emitter description update
      // shipped under an unchanged version number) must still be offered a
      // reinstall, not silently declared unchanged.
      writeSkill = false;
      skipped.push({ path: skillPath, reason: `unchanged (already v${CLI_VERSION})` });
    } else if (!yes) {
      const label = frontmatterVersion(existingContent) ?? 'unknown';
      // Same version label but different bytes (e.g. a description update under an
      // unchanged version number) — "overwrite vX with vX" would misreport this as a
      // version bump when nothing about the version changed.
      const sameVersion = label === CLI_VERSION;
      const prompt = sameVersion
        ? `local copy of v${label} differs from the emitted skill — overwrite?`
        : `overwrite v${label} with v${CLI_VERSION}?`;
      const declineReason = sameVersion
        ? `declined overwrite: local copy differs from emitted skill (both v${label})`
        : `declined overwrite of v${label}`;
      const ok = await confirm(prompt);
      writeSkill = ok;
      if (!ok) skipped.push({ path: skillPath, reason: declineReason });
    }
  }
  if (writeSkill) {
    mkdirSync(join(folder, 'figma-agent'), { recursive: true });
    writeFileSync(skillPath, freshSkill);
    installed.push(skillPath);
  }

  // es-figma-craft bundling — a non-interactive run needs an explicit decision;
  // silently defaulting a non-TTY run to "yes" would install an unrequested skill.
  const withCraft = args.bool('with-craft');
  const noCraft = args.bool('no-craft');
  const craftDest = join(folder, CRAFT_SKILL_DIR);
  let bundleCraft: boolean;
  let skipReason = '';
  if (withCraft) bundleCraft = true;
  else if (noCraft) { bundleCraft = false; skipReason = 'skipped: --no-craft'; }
  else if (process.stdin.isTTY) {
    bundleCraft = await confirm('also install skills/es-figma-craft (Figma canvas engineering discipline)?');
    if (!bundleCraft) skipReason = 'declined';
  } else {
    bundleCraft = false;
    skipReason = 'skipped: non-interactive run — pass --with-craft or --no-craft to decide explicitly';
  }

  if (bundleCraft) {
    const craftSrc = join(repoRoot(), 'skills', CRAFT_SKILL_DIR);
    if (!existsSync(craftSrc)) {
      // The caller explicitly asked for this (a flag, or a "yes" to the prompt) —
      // an unsatisfiable explicit request must not report success. A non-zero exit
      // is the one signal a script driving this CLI can't miss; the `skipped: []`
      // paths above stay soft because there the caller never asked in the first place.
      throw new CliError(
        'E_INVALID_ARGS',
        `--with-craft was requested but its source skill was not found at ${craftSrc} — this install does not bundle it`,
      );
    }
    const craftResult = await installCraftFolder(craftSrc, craftDest, yes);
    if (craftResult.installed) installed.push(craftDest);
    else skipped.push({ path: craftDest, reason: craftResult.reason });
  } else {
    skipped.push({ path: craftDest, reason: skipReason });
  }

  return { folder, installed, skipped, version: CLI_VERSION, verify: 'figma-agent status --peek' };
}
