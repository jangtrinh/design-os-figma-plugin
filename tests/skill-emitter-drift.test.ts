// Drift guard: skills/figma-agent/SKILL.md is a COMMITTED, generated artifact
// (`npm run emit:skill`) — this test fails the moment it stops matching a fresh
// render, and separately fails the moment a command is added to COMMAND_MODULES
// without a matching command-catalog.ts entry (or vice versa) — the point where
// "added a command, forgot the doc" is actually catchable.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderSkill } from '../cli/src/skill-emitter.ts';
import { COMMANDS } from '../cli/src/command-catalog.ts';
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
});
