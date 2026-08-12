// `figma-agent install-skill` — writes THIS CLI's own emitted SKILL.md into a
// Claude Code skills folder. Never copies the committed skills/figma-agent/SKILL.md
// (that risks shipping a stale artifact) — always renders fresh from the SAME
// emitter `npm run emit:skill` uses, so the installed copy always matches the
// binary that installed it.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { dirname, join, resolve } from 'node:path';
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

/** This bundled CLI's own repo root — es-figma-craft ships alongside cli/dist/. */
function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
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
  let writeSkill = true;
  if (existsSync(skillPath)) {
    const existingVersion = frontmatterVersion(readFileSync(skillPath, 'utf8'));
    if (existingVersion === CLI_VERSION) {
      writeSkill = false;
      skipped.push({ path: skillPath, reason: `unchanged (already v${CLI_VERSION})` });
    } else if (!yes) {
      const label = existingVersion ?? 'unknown';
      const ok = await confirm(`overwrite v${label} with v${CLI_VERSION}?`);
      writeSkill = ok;
      if (!ok) skipped.push({ path: skillPath, reason: `declined overwrite of v${label}` });
    }
  }
  if (writeSkill) {
    mkdirSync(join(folder, 'figma-agent'), { recursive: true });
    writeFileSync(skillPath, renderSkill());
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
    if (existsSync(craftSrc)) {
      cpSync(craftSrc, craftDest, { recursive: true });
      installed.push(craftDest);
    } else {
      skipped.push({ path: craftDest, reason: `source skill not found at ${craftSrc} — this install may not bundle it` });
    }
  } else {
    skipped.push({ path: craftDest, reason: skipReason });
  }

  return { folder, installed, skipped, version: CLI_VERSION, verify: 'figma-agent status --peek' };
}
