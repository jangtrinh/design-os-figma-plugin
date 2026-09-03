---
name: figma-agent
description: "figma-agent — the CLI bridge to the Figma file already open in the designer's Figma desktop app, over a local WebSocket broker. SessionStart MAY have already run figma-agent status --peek and left its result in context (only if the optional install-hook was set up) — if no peek result is visible, run figma-agent status --peek first. When it reports a live connection, use THIS skill — not the DesignAgent MCP or any other Figma bridge — for every request to inspect, read, edit, or check the status of that open file: selection, nodes, layers, styles, components, variables, frames, screenshots, or making changes to the canvas. Read connection state, then read/write the open Figma document without the paid official write MCP."
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
3. `status --peek`'s `versionMatch`/`protocolMatch` fields tell you whether the
   connected plugin build matches this CLI. `null` means the plugin didn't report a
   version (an older bundle) — treat that as unknown, not as a mismatch. Plain `status`
   does not compute these fields itself — read them from `--peek`.
4. If nothing is connected, the human's remaining step is opening the plugin panel in
   Figma desktop — this CLI cannot do that for them.

## Typical workflow

1. `figma-agent status --peek` — is anything alive, and does it match this CLI build.
2. `figma-agent status` — full detail on the active connection (spawns a broker if idle).
3. Read before you write: `get-selection`, `inspect`, `scan-design-system`. Resolve a
   component by name with `resolve-component --name "<n>"` — it returns exactly one node
   or refuses (E_AMBIGUOUS lists the duplicates; pass `--page` or use an id).
4. Mutate with the typed commands (`create-frame`, `set-text`, `clone-traits`, ...)
   before falling back to `exec-js` for anything they don't cover. Every mutating
   command first waits (up to 60s) for the plugin to register, so the first call after
   an idle flap no longer needs a `status --wait &&` prefix — `--no-wait` opts out.
5. `changes`/`errors`/`contention` read durable local logs — they work even with the
   plugin closed, useful for catching up after a session gap.

## Error hints

- `E_NO_BROKER` — no broker answered; the plugin almost certainly isn't open. Peek first
  next time, don't assume.
- `E_NO_PLUGIN` — the broker is alive but no Figma file is connected right now. A
  mutating command already waited its 60s bound for one before saying so — retrying at
  once will not help; the human must open the plugin panel in the target file.
- `E_WRONG_FILE` — a command named `--file`/`--instance` and the plugin currently
  answering doesn't match; open the right file, or drop the filter to see what IS live.
- `E_TIMEOUT` (with a `jobId`) — the command is still running as a background job; poll
  it with `figma-agent job <jobId> --wait` instead of re-issuing the same command.
- `E_VERSION_MISMATCH` — the broker speaks a different protocol version than this CLI;
  rebuild/reinstall one side.

## Command reference

- `status` — Broker + plugin connection info [--peek [--json]] [--wait [--timeout N]] — --peek reads only the /tmp broker advertisement plus one short broker query; it NEVER spawns a broker. --json is accepted for compatibility but is a no-op: output is always the same single JSON object. --wait blocks (MAY spawn a broker) until a matching plugin registers, printing a figma:// deep link (when one can be built) to stderr immediately; --timeout N is in SECONDS, default 60 — on timeout this exits non-zero with E_NO_PLUGIN instead of the normal payload.
- `mutation-gate` — <pause|resume|status> --file-key <raw-key>   control the local broker's durable per-file mutation admission gate. The key is passed verbatim and must be a nonempty raw Figma fileKey; this command never derives identity from a filename.
- `seat` — Probe seat → {seat, bridge, reason} [--seat free|paid skips the probe]
- `bind` — --file "<name>" --dir <projectDir>   bind a file to a project for panel/idle sync (refuses to guess otherwise) [--list] [--unbind]
- `get-selection` — Serialize the current selection [--depth 1]
- `inspect` — [nodeId|--node id] [--out file.png --scale 1 --timeout ms]
- `job` — <jobId> [--wait] [--wait-timeout 60000] | --list [--file name] | <jobId> --cancel (queued only) | <jobId> --force-release [--force]   poll/wait/cancel/list a job the CLI stopped waiting for (backlog 1.1+2.6+4.3) — --force-release refuses a HEALTHY still-running job unless --force is also passed — --force overrides the guard and discards its result, unverified; a watchdog-wedged job still unwedges without --force. An outcome-unknown job requires canvas inspection, then a bare --force-release; never retry it automatically.
- `scan-design-system` — Components/variables/styles registry [--out file.json --timeout ms]
- `resolve-component` — --name "<exact name>" [--page <page name>] [--timeout ms]   exactly ONE component or component set {id,key,name,type,page} for a name — read-only (rides scan-design-system, a safe read that bypasses the mutation FIFO). Name match is exact after trim, case-insensitive, never a substring. Duplicates: --page filters first; without it a tie is broken only when exactly one hit sits on a design-system-looking page (/design.?system|\bds\b|component|library/i) and the reply says preferred: "design-system-page". Anything still ambiguous exits 1 with E_AMBIGUOUS listing every candidate; no match exits 1 with E_NOT_FOUND. `matched` reports how many live nodes carried the name.
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
- `shader-gradient` — Bake an animated ShaderGradient field onto a node as an image fill [--node <id|selection>] [--preset <slug> | --url "<customize url>" | --set k=v,k2=v2] [--w 1200 --h 800 --scale 2] [--static] [--timeout ms] [--list]   --preset takes a ledger slug (or upstream's camelCase key); --url takes a shadergradient.co/customize link; --set overrides either. --static freezes the field instead of capturing it mid-animation. --list prints the preset roster and --self-test renders a tiny throwaway field to report whether this environment can bake at all; both are read-only and make no canvas change. The resolved config is stored on the node so a later bake can reproduce or resize it.
- `exec-js` — <file|-> [--timeout ms (cap 120000)] [--undo-group] [--no-lint] [--strict] — exec-js lints scripts before dispatch; --no-lint explicitly bypasses that local preflight. Hard findings (sync dynamic-page getters, import declarations) refuse; warnings go to stderr — the sync mainComponent getter, findAll without a visible filter, componentProperties on a COMPONENT_SET, and the older heuristics — unless --strict, which refuses on any warning too. --undo-group brackets the script in ONE undo step and reverts it on error; the script must not call figma.commitUndo/triggerUndo itself, and a timeout cannot stop a running script (the plugin has no cancellation). While it runs, figma.currentPage carries one extra invisible child (the undo sentinel) — a script that enumerates or counts the page's children will see it. `console` and `ui` are injected — a script cannot declare its own.
- `capture` — <url> [--out dir --headless --channel chrome --width 1440 --timeout ms --carousel-window ms]
- `batch` — <file.json> [--stop-on-error]
- `changes` — [--since ts|iso --owner-only --actor owner|agent|ambiguous --file name|slug --limit 50 --page name]  read the owner-edit feed (wave 4.4) — pure fs, works even with the plugin closed; --owner-only is sugar for --actor owner
- `errors` — [--since ts|iso --file name --limit 50]  read the broker's error log (backlog 4.6) — full untruncated message + cmd/activity/code/fileName, for an agent to read-and-fix; --file filters by the entry's own fileName
- `contention` — [--file name --since days]  read the durable per-file/per-day queued-time counter — total ms a mutation waited in the FIFO before dispatch, plus jobCount, per UTC day; --file filters by fileSlug, --since limits to the last N days; pure fs, works with the plugin closed
- `install-skill` — [--folder ~/.claude/skills] [--with-craft|--no-craft] [--yes]   write this emitted SKILL.md to a folder Claude Code reads skills from; prompts before overwriting an older installed version and before bundling skills/es-figma-craft — a non-interactive run needs --with-craft/--no-craft or it skips craft and says so
- `install-hook` — [--dry-run] [--yes] [--settings <path>]   add a SessionStart hook to Claude Code settings that runs "figma-agent status --peek" at the start of every session; confirms before writing, backs up the file first, and aborts untouched if it can't parse the file as JSON
- `cowork` — [--wait S] [--timeout S]   wait for ONE designer change-cycle: quiescence of --wait seconds (default 3, floor 1) after the designer edits, or --timeout seconds (default 600, in SECONDS like status --wait) with zero edits — that is a normal answer (cycles:0), not an error. Prints the edited nodes plus any pending agent corrections on them, read-only from the existing correction ledger (never writes it). Only actor:owner edits on a LIVE batch arm the cycle — an agent's own writes, ambiguous-actor edits, and a gapfill replay never do. The plugin disconnecting mid-wait refuses with a reconnect hint instead of hanging to the full timeout.
