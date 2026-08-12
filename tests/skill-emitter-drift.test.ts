// Drift guard: skills/figma-agent/SKILL.md is a COMMITTED, generated artifact
// (`npm run emit:skill`) — this test fails the moment it stops matching a fresh
// render, and separately fails the moment a command is added to COMMAND_MODULES
// without a matching command-catalog.ts entry (or vice versa) — the point where
// "added a command, forgot the doc" is actually catchable.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderSkill } from '../cli/src/skill-emitter.ts';
import { COMMANDS, GLOBAL_FLAGS } from '../cli/src/command-catalog.ts';
import { renderHelp } from '../cli/src/help-text.ts';
import { COMMAND_MODULES } from '../cli/src/figma-agent.ts';

const SKILL_PATH = fileURLToPath(new URL('../skills/figma-agent/SKILL.md', import.meta.url));

describe('skill-emitter-drift', () => {
  it('the committed SKILL.md matches a fresh renderSkill() output', () => {
    const committed = readFileSync(SKILL_PATH, 'utf8');
    const fresh = renderSkill();
    if (committed !== fresh) {
      const committedLines = committed.split('\n');
      const freshLines = fresh.split('\n');
      const at = committedLines.findIndex((line, i) => line !== freshLines[i]);
      throw new Error(
        `skills/figma-agent/SKILL.md is stale at line ${at + 1} — run \`npm run emit:skill\` to regenerate it.\n`
        + `  committed: ${JSON.stringify(committedLines[at] ?? '<eof>')}\n`
        + `  emitted:   ${JSON.stringify(freshLines[at] ?? '<eof>')}`,
      );
    }
    expect(committed).toBe(fresh);
  });

  it('every COMMAND_MODULES key has a command-catalog.ts entry, and vice versa', () => {
    const moduleNames = Object.keys(COMMAND_MODULES).sort();
    const catalogNames = COMMANDS.map((c) => c.name).sort();
    expect(catalogNames).toEqual(moduleNames);
  });

  // Coverage gap noted in review: the two checks above catch a MISSING command,
  // not a flag that quietly went stale in the catalog's free-text description
  // while the runtime path that reads it changed name. --help itself was also
  // asserted nowhere. Cheapest honest version: --help must actually render
  // every command + its description (help-text.ts is genuinely read), and every
  // args.bool/str flag THIS SLICE'S commands read at runtime must appear in
  // their own catalog description — not a general flag/description parser.
  it('renderHelp() actually contains every catalog command name and description', () => {
    const help = renderHelp();
    for (const c of COMMANDS) {
      expect(help, `--help is missing the "${c.name}" command line`).toContain(c.name);
      if (c.description) expect(help, `--help text for "${c.name}" is stale`).toContain(c.description);
    }
  });

  it("this slice's commands: every args.bool/str flag they read is named in their own catalog description or GLOBAL_FLAGS", () => {
    const commandFiles: Record<string, string> = {
      status: '../cli/src/commands/status.ts',
      'install-skill': '../cli/src/commands/install-skill.ts',
      'install-hook': '../cli/src/commands/install-hook.ts',
    };
    const globalFlagNames = new Set(GLOBAL_FLAGS.map((f) => f.flag.match(/--([a-z-]+)/)?.[1]));
    for (const [name, relPath] of Object.entries(commandFiles)) {
      const src = readFileSync(fileURLToPath(new URL(relPath, import.meta.url)), 'utf8');
      const flags = new Set([...src.matchAll(/args\.(?:bool|str)\('([a-z][a-z-]*)'\)/g)].map((m) => m[1]));
      const entry = COMMANDS.find((c) => c.name === name);
      expect(entry, `catalog is missing an entry for "${name}"`).toBeDefined();
      for (const flag of flags) {
        if (globalFlagNames.has(flag)) continue; // documented once, in GLOBAL_FLAGS, not per-command
        expect(entry?.description, `catalog entry for "${name}" doesn't mention --${flag}`).toContain(`--${flag}`);
      }
    }
  });
});
