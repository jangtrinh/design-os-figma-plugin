// Renders the full skills/figma-agent/SKILL.md text: frontmatter + the prose in
// skill-template.ts + a "Command reference" section built from command-catalog.ts
// — the SAME catalog help-text.ts reads, so the skill's command list can never
// drift from the CLI's own --help without the drift test (skill-emitter-drift.test.ts)
// catching it. Pure string building: no fs read/write here (the CLI's
// `__emit-skill` subcommand and `install-skill` are the only fs-touching callers).
import { COMMANDS } from './command-catalog.ts';
import {
  SKILL_CONNECT_PROTOCOL,
  SKILL_DESCRIPTION,
  SKILL_ERROR_HINTS,
  SKILL_INTRO,
  SKILL_WORKFLOW,
} from './skill-template.ts';
import { CLI_VERSION } from './version.ts';

function renderFrontmatter(): string {
  return [
    '---',
    'name: figma-agent',
    `description: "${SKILL_DESCRIPTION}"`,
    `version: ${CLI_VERSION}`,
    `requiresCli: ">=${CLI_VERSION}"`,
    'cliBinary: figma-agent',
    '---',
  ].join('\n');
}

function renderCommandReference(): string {
  const rows = COMMANDS.map(({ name, description }) =>
    description ? `- \`${name}\` — ${description}` : `- \`${name}\``,
  ).join('\n');
  return `## Command reference\n\n${rows}`;
}

export function renderSkill(): string {
  return [
    renderFrontmatter(),
    '',
    SKILL_INTRO,
    '',
    SKILL_CONNECT_PROTOCOL,
    '',
    SKILL_WORKFLOW,
    '',
    SKILL_ERROR_HINTS,
    '',
    renderCommandReference(),
    '',
  ].join('\n');
}
