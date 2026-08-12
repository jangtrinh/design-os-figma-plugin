// Renders `figma-agent --help` from the ONE command catalog (command-catalog.ts)
// — no command name or flag text is declared here. Column widths may shift
// from the old inline template; the WORDS must not (see phase notes: a
// wording change in the catalog would be invisible in review, so this file
// stays pure layout).
import { COMMANDS, FOOTER_LINE, GLOBAL_FLAGS, HEADER_LINE, USAGE_LINE } from './command-catalog.ts';

const NAME_COLUMN = 21;
const FLAG_COLUMN = 29;

function padTo(value: string, width: number): string {
  return value.length >= width ? `${value} ` : value + ' '.repeat(width - value.length);
}

function renderCommands(): string {
  return COMMANDS.map(({ name, description }) =>
    `  ${padTo(name, NAME_COLUMN)}${description}`.trimEnd(),
  ).join('\n');
}

function renderGlobalFlags(): string {
  return GLOBAL_FLAGS.map(({ flag, description }, i) => {
    const prefix = i === 0 ? 'Global: ' : '        ';
    return `${prefix}${padTo(flag, FLAG_COLUMN)}${description}`;
  }).join('\n');
}

export function renderHelp(): string {
  return [
    HEADER_LINE,
    '',
    USAGE_LINE,
    '',
    'Commands:',
    renderCommands(),
    '',
    renderGlobalFlags(),
    '',
    FOOTER_LINE,
  ].join('\n');
}

export const HELP = renderHelp();
