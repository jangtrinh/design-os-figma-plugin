// The ONE structured source of every command's name/usage/description and every
// global flag. `help-text.ts` renders `--help` from this; `skill-emitter.ts`
// renders the skill's "Command reference" section from the SAME array — a
// command can never be documented in one place and not the other (drift test:
// tests/skill-emitter-drift.test.ts). Data only, no rendering, no fs.
//
// Content is a verbatim transcription of the former inline `HELP` template
// literal (figma-agent.ts) — wording unchanged, only line-wrapping collapsed
// into single `description` strings per entry.

export interface CommandCatalogEntry {
  /** The key COMMAND_MODULES (figma-agent.ts) dispatches on. */
  name: string;
  /** Usage + prose, exactly as it read in the old --help block (line-wraps collapsed). */
  description: string;
}

export interface GlobalFlagEntry {
  flag: string;
  description: string;
}

export const HEADER_LINE = 'figma-agent — CLI bridge to the Figma plugin (via a local WS broker)';
export const USAGE_LINE = 'Usage: figma-agent <command> [options]';
export const FOOTER_LINE =
  'All commands print one JSON object to stdout and exit 0, or {error:{code,message}} and exit 1.';

export const COMMANDS: CommandCatalogEntry[] = [
  {
    name: 'status',
    description:
      'Broker + plugin connection info [--peek [--json]] — --peek reads only the /tmp broker '
      + 'advertisement plus one short broker query; it NEVER spawns a broker. --json is accepted '
      + 'for compatibility but is a no-op: output is always the same single JSON object.',
  },
  { name: 'seat', description: 'Probe seat → {seat, bridge, reason} [--seat free|paid skips the probe]' },
  {
    name: 'bind',
    description:
      '--file "<name>" --dir <projectDir>   bind a file to a project for panel/idle sync '
      + '(refuses to guess otherwise) [--list] [--unbind]',
  },
  { name: 'get-selection', description: 'Serialize the current selection [--depth 1]' },
  { name: 'inspect', description: '[nodeId|--node id] [--out file.png --scale 1 --timeout ms]' },
  {
    name: 'job',
    description:
      '<jobId> [--wait] [--wait-timeout 60000] | --list [--file name] | <jobId> --cancel (queued only) | '
      + '<jobId> --force-release [--force]   poll/wait/cancel/list a job the CLI stopped waiting for '
      + '(backlog 1.1+2.6+4.3) — --force-release refuses a HEALTHY still-running job unless --force is '
      + 'also passed — --force overrides the guard and discards its result, unverified; a '
      + 'watchdog-wedged job still unwedges without --force',
  },
  {
    name: 'scan-design-system',
    description: 'Components/variables/styles registry [--out file.json --timeout ms]',
  },
  {
    name: 'scan-node',
    description: '[SPIKE] Reverse-walk one node → FigmaExportNode spec <nodeId> [--timeout ms]',
  },
  {
    name: 'mirror-verify',
    description: 'Prove one node round-trips: scan → rebuild → scan → diff <nodeId> [--parent id --keep --timeout ms]',
  },
  {
    name: 'scan-conventions',
    description:
      'Convention-DNA walk over sections → usage-dna.json '
      + '[<sectionId...> --out file.json --budget 14000 --timeout ms]',
  },
  {
    name: 'audit-ds',
    description:
      "DS-hygiene audit of the open file's component library "
      + '[--out file.json --sections "01 A,02 B" --facts raw.json --from-facts raw.json --timeout ms]',
  },
  { name: 'create-frame', description: '--name n --w 400 --h 300 [--parent id --x 0 --y 0]' },
  {
    name: 'connect',
    description: '--from id --to id [--label t --intent flow|annotation --flow n --transition id]',
  },
  { name: 'disconnect', description: '--id conn-id | --from id --to id' },
  { name: 'list-connections', description: '' },
  { name: 'reroute', description: '[--id conn-id | --flow name]' },
  { name: 'draw-flow', description: '--flow path/to/flow.json [--page name]' },
  { name: 'verify-connections', description: '[--flow path/to/flow.json]' },
  { name: 'create-instance', description: '--component <key|id> [--parent id]' },
  { name: 'set-variant', description: '--node id --props k=v,k2=v2' },
  {
    name: 'create-variable',
    description: '--collection c --name n --type COLOR|FLOAT|STRING|BOOLEAN --value v [--mode m]',
  },
  {
    name: 'bind-variable',
    description: "--node id --field fills|cornerRadius|... --variable <id|name>",
  },
  {
    name: 'set-autolayout',
    description:
      '--node id --mode H|V|GRID|NONE [--gap n --pad t,r,b,l --align-primary --align-counter --wrap '
      + '--sizing-h --sizing-v --rows n --cols n --col-sizes ...]',
  },
  {
    name: 'set-constraints',
    description: '--node id --h MIN|MAX|CENTER|STRETCH|SCALE --v MIN|MAX|CENTER|STRETCH|SCALE',
  },
  { name: 'set-text', description: '--node id --chars "..." [--font f --size n --weight n]' },
  {
    name: 'clone-traits',
    description: '--source id --target id --traits layout,fills-variables,typography,spacing,text',
  },
  { name: 'sync-corrections', description: '[--dir project] sync Figma edge memory with design/memory' },
  { name: 'export-png', description: '--node <id|selection> --out file.png [--scale 2]' },
  {
    name: 'html-to-figma',
    description: '--html <file|-> [--width 1280 --x --y --parent id --replace id]',
  },
  {
    name: 'exec-js',
    description:
      '<file|-> [--timeout ms (cap 120000)] [--undo-group] — --undo-group brackets the script in ONE '
      + 'undo step and reverts it on error; the script must not call figma.commitUndo/triggerUndo itself, '
      + 'and a timeout cannot stop a running script (the plugin has no cancellation). While it runs, '
      + 'figma.currentPage carries one extra invisible child (the undo sentinel) — a script that '
      + "enumerates or counts the page's children will see it. `console` and `ui` are injected — a "
      + 'script cannot declare its own.',
  },
  {
    name: 'capture',
    description:
      '<url> [--out dir --headless --channel chrome --width 1440 --timeout ms --carousel-window ms]',
  },
  { name: 'batch', description: '<file.json> [--stop-on-error]' },
  {
    name: 'changes',
    description:
      '[--since ts|iso --owner-only --actor owner|agent|ambiguous --file name|slug --limit 50 --page name]  '
      + 'read the owner-edit feed (wave 4.4) — pure fs, works even with the plugin closed; --owner-only '
      + 'is sugar for --actor owner',
  },
  {
    name: 'errors',
    description:
      "[--since ts|iso --file name --limit 50]  read the broker's error log (backlog 4.6) — full "
      + 'untruncated message + cmd/activity/code/fileName, for an agent to read-and-fix; --file filters '
      + "by the entry's own fileName",
  },
  {
    name: 'contention',
    description:
      '[--file name --since days]  read the durable per-file/per-day queued-time counter — total ms a '
      + 'mutation waited in the FIFO before dispatch, plus jobCount, per UTC day; --file filters by '
      + 'fileSlug, --since limits to the last N days; pure fs, works with the plugin closed',
  },
  {
    name: 'install-skill',
    description:
      '[--folder ~/.claude/skills] [--with-craft|--no-craft] [--yes]   write this emitted SKILL.md to a '
      + 'folder Claude Code reads skills from; prompts before overwriting an older installed version and '
      + 'before bundling skills/es-figma-craft — a non-interactive run needs --with-craft/--no-craft '
      + 'or it skips craft and says so',
  },
  {
    name: 'install-hook',
    description:
      '[--dry-run] [--yes] [--settings <path>]   add a SessionStart hook to Claude Code settings that '
      + 'runs "figma-agent status --peek" at the start of every session; confirms before writing, backs '
      + "up the file first, and aborts untouched if it can't parse the file as JSON",
  },
];

export const GLOBAL_FLAGS: GlobalFlagEntry[] = [
  {
    flag: '--file "<exact file name>"',
    description:
      "route to that file's plugin AND refuse to run anywhere else (exact, case-insensitive; beats "
      + 'FIGMA_AGENT_FILE; payloads >512KB route by the env pin but are still guarded)',
  },
  {
    flag: '--instance <instanceId>',
    description:
      "route to that EXACT plugin instance (from `status`'s instanceId column) — beats --file and "
      + "FIGMA_AGENT_FILE; the one way to target a specific instance when --file's name is ambiguous "
      + '(e.g. two unsaved files both named "Untitled"). Mutually exclusive with --file: passing both '
      + 'refuses with E_INVALID_ARGS naming both, it never silently picks one.',
  },
  {
    flag: '--dir <projectDir>',
    description:
      "this invocation's project root (default: cwd); stamped on every request so panel/idle sync can "
      + 'apply into the right project once bound (`figma-agent bind`) — never a guess',
  },
  {
    flag: '--read-only',
    description:
      'declare that this command only READS. Skips the per-file mutation queue (backlog 1.1+2.6+4.3). '
      + 'TRUSTED, NOT ENFORCED — the plugin sandbox cannot verify it, so a mis-declared mutation can '
      + "interleave with another agent's work.",
  },
];
