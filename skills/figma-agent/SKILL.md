---
name: figma-agent
description: "figma-agent — the CLI bridge between an agent and a live Figma file, over a local WebSocket broker. Use it to read connection state at session start, then read/write the open Figma document without the paid official write MCP."
version: 0.1.0
requiresCli: ">=0.1.0"
cliBinary: figma-agent
---

# figma-agent

A thin CLI that talks to the Figma plugin "Ease Design Figma Agent" through a local
broker (127.0.0.1, ports 9410-9419). One command per invocation; every command prints
exactly one JSON object to stdout and exits 0, or `{error:{code,message}}` and exits 1.

## Connect protocol

1. Check state cheaply first: `figma-agent status --peek`. This never spawns a broker —
   it only reads the `/tmp` broker advertisement and, if one is live, asks it one short
   question. Idle (no broker, or the plugin not open) is a normal, non-error answer.
2. Only run a real command (`status`, `connect`, `create-frame`, ...) once you need to
   act — those DO start a broker on demand if none is running.
3. `status`'s `versionMatch`/`protocolMatch` fields tell you whether the connected
   plugin build matches this CLI. `null` means the plugin didn't report a version (an
   older bundle) — treat that as unknown, not as a mismatch.
4. If nothing is connected, the human's remaining step is opening the plugin panel in
   Figma desktop — this CLI cannot do that for them.

## Typical workflow

1. `figma-agent status --peek` — is anything alive, and does it match this CLI build.
2. `figma-agent status` — full detail on the active connection (spawns a broker if idle).
3. Read before you write: `get-selection`, `inspect`, `scan-design-system`.
4. Mutate with the typed commands (`create-frame`, `set-text`, `clone-traits`, ...)
   before falling back to `exec-js` for anything they don't cover.
5. `changes`/`errors`/`contention` read durable local logs — they work even with the
   plugin closed, useful for catching up after a session gap.

## Error hints

- `E_NO_BROKER` — no broker answered; the plugin almost certainly isn't open. Peek first
  next time, don't assume.
- `E_NO_PLUGIN` — the broker is alive but no Figma file is connected right now.
- `E_WRONG_FILE` — a command named `--file`/`--instance` and the plugin currently
  answering doesn't match; open the right file, or drop the filter to see what IS live.
- `E_TIMEOUT` (with a `jobId`) — the command is still running as a background job; poll
  it with `figma-agent job <jobId> --wait` instead of re-issuing the same command.
- `E_VERSION_MISMATCH` — the broker speaks a different protocol version than this CLI;
  rebuild/reinstall one side.

## Command reference

- `status` — Broker + plugin connection info [--peek [--json]] — --peek reads only the /tmp broker advertisement plus one short broker query; it NEVER spawns a broker. --json is accepted for compatibility but is a no-op: output is always the same single JSON object.
- `seat` — Probe seat → {seat, bridge, reason} [--seat free|paid skips the probe]
- `bind` — --file "<name>" --dir <projectDir>   bind a file to a project for panel/idle sync (refuses to guess otherwise) [--list] [--unbind]
- `get-selection` — Serialize the current selection [--depth 1]
- `inspect` — [nodeId|--node id] [--out file.png --scale 1 --timeout ms]
- `job` — <jobId> [--wait] [--wait-timeout 60000] | --list [--file name] | <jobId> --cancel (queued only) | <jobId> --force-release [--force]   poll/wait/cancel/list a job the CLI stopped waiting for (backlog 1.1+2.6+4.3) — --force-release refuses a HEALTHY still-running job unless --force is also passed — --force overrides the guard and discards its result, unverified; a watchdog-wedged job still unwedges without --force
- `scan-design-system` — Components/variables/styles registry [--out file.json --timeout ms]
- `scan-node` — [SPIKE] Reverse-walk one node → FigmaExportNode spec <nodeId> [--timeout ms]
- `mirror-verify` — Prove one node round-trips: scan → rebuild → scan → diff <nodeId> [--parent id --keep --timeout ms]
- `scan-conventions` — Convention-DNA walk over sections → usage-dna.json [<sectionId...> --out file.json --budget 14000 --timeout ms]
- `audit-ds` — DS-hygiene audit of the open file's component library [--out file.json --sections "01 A,02 B" --facts raw.json --from-facts raw.json --timeout ms]
- `create-frame` — --name n --w 400 --h 300 [--parent id --x 0 --y 0]
- `connect` — --from id --to id [--label t --intent flow|annotation --flow n --transition id]
- `disconnect` — --id conn-id | --from id --to id
- `list-connections`
- `reroute` — [--id conn-id | --flow name]
- `draw-flow` — --flow path/to/flow.json [--page name]
- `verify-connections` — [--flow path/to/flow.json]
- `create-instance` — --component <key|id> [--parent id]
- `set-variant` — --node id --props k=v,k2=v2
- `create-variable` — --collection c --name n --type COLOR|FLOAT|STRING|BOOLEAN --value v [--mode m]
- `bind-variable` — --node id --field fills|cornerRadius|... --variable <id|name>
- `set-autolayout` — --node id --mode H|V|GRID|NONE [--gap n --pad t,r,b,l --align-primary --align-counter --wrap --sizing-h --sizing-v --rows n --cols n --col-sizes ...]
- `set-constraints` — --node id --h MIN|MAX|CENTER|STRETCH|SCALE --v MIN|MAX|CENTER|STRETCH|SCALE
- `set-text` — --node id --chars "..." [--font f --size n --weight n]
- `clone-traits` — --source id --target id --traits layout,fills-variables,typography,spacing,text
- `sync-corrections` — [--dir project] sync Figma edge memory with design/memory
- `export-png` — --node <id|selection> --out file.png [--scale 2]
- `html-to-figma` — --html <file|-> [--width 1280 --x --y --parent id --replace id]
- `exec-js` — <file|-> [--timeout ms (cap 120000)] [--undo-group] — --undo-group brackets the script in ONE undo step and reverts it on error; the script must not call figma.commitUndo/triggerUndo itself, and a timeout cannot stop a running script (the plugin has no cancellation). While it runs, figma.currentPage carries one extra invisible child (the undo sentinel) — a script that enumerates or counts the page's children will see it. `console` and `ui` are injected — a script cannot declare its own.
- `capture` — <url> [--out dir --headless --channel chrome --width 1440 --timeout ms --carousel-window ms]
- `batch` — <file.json> [--stop-on-error]
- `changes` — [--since ts|iso --owner-only --actor owner|agent|ambiguous --file name|slug --limit 50 --page name]  read the owner-edit feed (wave 4.4) — pure fs, works even with the plugin closed; --owner-only is sugar for --actor owner
- `errors` — [--since ts|iso --file name --limit 50]  read the broker's error log (backlog 4.6) — full untruncated message + cmd/activity/code/fileName, for an agent to read-and-fix; --file filters by the entry's own fileName
- `contention` — [--file name --since days]  read the durable per-file/per-day queued-time counter — total ms a mutation waited in the FIFO before dispatch, plus jobCount, per UTC day; --file filters by fileSlug, --since limits to the last N days; pure fs, works with the plugin closed
- `install-skill` — [--folder ~/.claude/skills] [--with-craft|--no-craft] [--yes]   write this emitted SKILL.md to a folder Claude Code reads skills from; prompts before overwriting an older installed version and before bundling skills/es-figma-craft — a non-interactive run needs --with-craft/--no-craft or it skips craft and says so
- `install-hook` — [--dry-run] [--yes] [--settings <path>]   add a SessionStart hook to Claude Code settings that runs "figma-agent status --peek" at the start of every session; confirms before writing, backs up the file first, and aborts untouched if it can't parse the file as JSON
