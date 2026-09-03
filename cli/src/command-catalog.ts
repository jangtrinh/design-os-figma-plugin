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
      'Broker + plugin connection info [--peek [--json]] [--wait [--timeout N]] — --peek reads '
      + 'only the /tmp broker advertisement plus one short broker query; it NEVER spawns a broker. '
      + '--json is accepted for compatibility but is a no-op: output is always the same single JSON '
      + 'object. --wait blocks (MAY spawn a broker) until a matching plugin registers, printing a '
      + 'figma:// deep link (when one can be built) to stderr immediately; --timeout N is in '
      + 'SECONDS, default 60 — on timeout this exits non-zero with E_NO_PLUGIN instead of the '
      + 'normal payload.',
  },
  {
    name: 'mutation-gate',
    description:
      '<pause|resume|status> --file-key <raw-key>   control the local broker\'s durable per-file '
      + 'mutation admission gate. The key is passed verbatim and must be a nonempty raw Figma fileKey; '
      + 'this command never derives identity from a filename.',
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
      + 'watchdog-wedged job still unwedges without --force. An outcome-unknown job requires '
      + 'canvas inspection, then a bare --force-release; never retry it automatically.',
  },
  {
    name: 'scan-design-system',
    description: 'Components/variables/styles registry [--out file.json --timeout ms]',
  },
  {
    name: 'resolve-component',
    description:
      '--name "<exact name>" [--page <page name>] [--timeout ms]   exactly ONE component or '
      + 'component set {id,key,name,type,page} for a name — read-only (rides scan-design-system, '
      + 'a safe read that bypasses the mutation FIFO). Name match is exact after trim, '
      + 'case-insensitive, never a substring. Duplicates: --page filters first; without it a tie '
      + 'is broken only when exactly one hit sits on a design-system-looking page '
      + '(/design.?system|\\bds\\b|component|library/i) and the reply says preferred: '
      + '"design-system-page". Anything still ambiguous exits 1 with E_AMBIGUOUS listing every '
      + 'candidate; no match exits 1 with E_NOT_FOUND. `matched` reports how many live nodes '
      + 'carried the name.',
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
  {
    name: 'export-png',
    description:
      '--node <id|selection> --out file.png [--scale 2] [--assert <script.js> [--assert-timeout ms] '
      + '[--no-lint] [--strict]]   --assert runs the script FIRST as a plugin-enforced read-only '
      + 'exec-js (same preflight lint as exec-js; a script that writes is refused by the plugin '
      + 'with E_READONLY_VIOLATION — the write is sealed into its own undo step, never applied '
      + 'silently) and exports only when it passes: a truthy return or {ok:true}. A falsy return '
      + 'or {ok:false,...} exits 1 with E_ASSERT_FAILED quoting the result; a throw keeps its own '
      + 'code. No PNG is written on any failure, so a file on disk always means the structural '
      + 'check held (craft gate 9: structure + PNG in one command). The reply carries '
      + 'assert:{script,result}.',
  },
  {
    name: 'html-to-figma',
    description: '--html <file|-> [--width 1280 --x --y --parent id --replace id]',
  },
  {
    name: 'shader-gradient',
    description:
      'Bake an animated ShaderGradient field onto a node as an image fill '
      + '[--node <id|selection>] [--preset <slug> | --url "<customize url>" | --set k=v,k2=v2] '
      + '[--w 1200 --h 800 --scale 2] [--static] [--timeout ms] [--list]   --preset takes a ledger '
      + 'slug (or upstream\'s camelCase key); --url takes a shadergradient.co/customize link; --set '
      + 'overrides either. --static freezes the field instead of capturing it mid-animation. --list '
      + 'prints the preset roster and --self-test renders a tiny throwaway field to report whether '
      + 'this environment can bake at all; both are read-only and make no canvas change. The '
      + 'resolved config is stored on the node so a later bake can reproduce or resize it.',
  },
  {
    name: 'exec-js',
    description:
      '<file|-> [--timeout ms (cap 120000)] [--undo-group] [--no-lint] [--strict] — exec-js lints scripts '
      + 'before dispatch; --no-lint explicitly bypasses that local preflight. Hard findings (sync '
      + 'dynamic-page getters, import declarations) refuse; warnings go to stderr — the sync '
      + 'mainComponent getter, findAll without a visible filter, componentProperties on a '
      + 'COMPONENT_SET, and the older heuristics — unless --strict, which refuses on any warning '
      + 'too. --undo-group brackets the script in ONE '
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
  {
    name: 'cowork',
    description:
      '[--wait S] [--timeout S]   wait for ONE designer change-cycle: quiescence of --wait seconds '
      + '(default 3, floor 1) after the designer edits, or --timeout seconds (default 600, in SECONDS '
      + 'like status --wait) with zero edits — that is a normal answer (cycles:0), not an error. Prints '
      + "the edited nodes plus any pending agent corrections on them, read-only from the existing "
      + 'correction ledger (never writes it). Only actor:owner edits on a LIVE batch arm the cycle — '
      + "an agent's own writes, ambiguous-actor edits, and a gapfill replay never do. The plugin "
      + 'disconnecting mid-wait refuses with a reconnect hint instead of hanging to the full timeout.',
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
    flag: '--target-file-key <raw Figma fileKey>',
    description:
      'exact broker-side target assertion for a disconnected mutation. It is passed verbatim, '
      + 'must be nonempty and unpadded, never derives from a filename/bind cache/reply, and is '
      + 'mutually exclusive with --file and --instance.',
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
      'request the broker-safe read path. Only STATUS, GET_SELECTION, EXPORT_PNG, SCAN_DESIGN_SYSTEM, '
      + 'GET_CORRECTION_MEMORY, LIST_CONNECTIONS, VERIFY_CONNECTIONS, and SHADER_GRADIENT_PROBE bypass '
      + 'the per-file mutation gate; the caller cannot declare any other command safe.',
  },
  {
    flag: '--no-wait',
    description:
      'skip the pre-dispatch plugin admission wait. By default every command the broker '
      + 'classifies as a mutation (everything outside the --read-only safe-read allowlist, '
      + 'EXEC_JS/BATCH/AUDIT_DS included) first waits up to 60s for a plugin matching '
      + '--file/--instance (else any) to register — the built-in equivalent of "status --wait '
      + '--timeout 60 &&", so the first call after an idle flap no longer fails with '
      + 'E_FILE_KEY_UNAVAILABLE. A plugin that never comes exits 1 with E_NO_PLUGIN naming the '
      + 'bound. Safe reads, --target-file-key requests (the broker parks those durably itself) '
      + 'and broker-terminal commands never wait. With --no-wait the request is sent at once '
      + "and the broker's own answer stands.",
  },
  {
    flag: '--agent <id> | FIGMA_AGENT_ID',
    description:
      'which harness sent this (the flag wins over the env var) — shown in the panel activity feed '
      + '("claude · Created frame ..."). Trimmed, then validated against an ALLOWLIST: lowercase '
      + 'letters, digits, ".", "_", "-" only, 1-32 characters — anything else refuses with '
      + "E_INVALID_ARGS naming the allowed set, it is never silently sanitized. Omitted entirely "
      + "when unset — an unlabelled request's wire frame is byte-identical to a pre-flag CLI's; the "
      + 'panel\'s own "cli" default is applied at render time, never stamped onto the wire.',
  },
];
