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
   For code context — CSS declarations, bound tokens, text, component props — use
   `context <nodeId>` (a page id works; a document id is refused). Read its `budget`
   block before trusting the tree: `emitted` is always `nodes.length` — except under
   `--dedup`, where `emitted = nodes.length + dedup.foldedNodes` — `partial`
   counts records that arrived incomplete, and `complete: false` means something is
   missing. `frontier[]` says what: reason `budget`/`deadline` → re-run `context`
   on that id; reason `depth` → re-run with a larger `--depth`. `--budget` bounds the
   node records only — `refsBytes` reports the identity tables separately, and the soft
   deadline covers the WALK only: ref resolution runs after it unbounded (`refsMs`), so a
   very large `--budget` can still hit the wire timeout — then `E_TIMEOUT` carries a
   `jobId`, and `job <id> --wait` collects the answer.
   A record's `intent` block is what the designer MEANT — `devStatus`, `annotations`,
   and a `componentKey` into `refs.components`, where a component's description and
   documentation links are resolved once per key; it is absent when nothing was set, which on
   a file where nobody used Dev Mode is every node. Dev-resource links are read only with
   `--dev-resources`: one subtree-wide read, measured at a fixed ~2s on a Free file (a
   server round trip, not a walk), reported as
   `budget.devResources {found, attached, readMs}`.
   `--dedup` (opt-in) shares repeated css/layout blocks and repeated subtrees through
   `refs.literals`/`refs.templates`; it never merges two named refs, it reports
   `dedup {applied, savedBytes?, foldedNodes?}`, and it ships the raw form with
   `applied: false` plus a reason when it would not be smaller. Under it a `frontier`
   entry may name a node folded into a template occurrence — resolve it through that
   occurrence's `rootMap`, or inflate first.
4. Mutate with the typed commands (`create-frame`, `set-text`, `clone-traits`, ...)
   before falling back to `exec-js` for anything they don't cover. Every mutating
   command first waits (up to 60s) for the plugin to register, so the first call after
   an idle flap no longer needs a `status --wait &&` prefix — `--no-wait` opts out.
5. Verify a screen with `export-png --node <id> --out shot.png --assert verify.js` — the
   structural assert runs read-only first and the PNG is written only when it passes.
6. `changes`/`errors`/`contention` read durable local logs — they work even with the
   plugin closed, useful for catching up after a session gap. `changes --owner-only --png
   <dir>` also exports an after PNG per owner-edited node (before only when a prior
   export predates the edit) so you can look instead of re-exporting.

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
- `context` — [nodeId|--node id] [--budget 64] [--depth N] [--no-css] [--dedup] [--dev-resources] [--timeout ms]   code context for one node's subtree as DATA: the Inspect panel's own CSS declarations (verbatim — a var(--token, #hex) fallback is never rewritten), the variable and style ids each node binds with one identity table per reply, text, and component properties. Not generated React/Tailwind, not Dev Mode. Read-only: it bypasses the mutation FIFO and adds no undo step. A page id walks that page, budget-bounded; a document id is refused (not a subtree). Breadth-first. --budget (KILOBYTES, default 64) bounds the NODE RECORDS, measured in the plugin before the wire; the refs identity tables are resolved after the walk and reported separately as refsBytes (under --dedup that covers the WHOLE refs object, so it includes the literals and templates content, not only identity tables), so finalBytes can exceed --budget. A soft deadline 2s inside --timeout means a big subtree answers with a partial AND its counts instead of a bare timeout — but that deadline covers the WALK only: ref resolution runs after it, is not bounded, and is reported as refsMs/refsBytes, so a very large --budget on a token-dense subtree can still hit the wire timeout (then E_TIMEOUT + jobId, recover with job <id> --wait). --budget is capped at 512 KB and --timeout is clamped to 120000 ms (the value actually used is reported as budget.timeoutMs). Every reply carries schema "context/1" and a budget block whose numbers add up: visited counts the nodes the walk ENQUEUED (not the subtree size), emitted is always nodes.length — except under --dedup, where emitted = nodes.length + dedup.foldedNodes — visited = emitted + omitted.budget + omitted.deadline, and partial counts records that shipped incomplete — a cssError, mainComponentError or childrenError, a collapsed.readErrors above 0, an intentError, or a minimal {id, readError} record whose own identity read refused (still counted in emitted). The intent reads are always on and cannot be declined, so a refused devStatus or annotations getter can raise partial and drop complete for a caller who only wanted the schema "context/1" fields. complete is true only when every omitted count, the frontier and partial are all 0. frontier[] lists what was not walked: reason "budget"/"deadline" → re-run context on that id; reason "depth" → re-run with a larger --depth (or none), since that node itself is already in nodes[] — though under --dedup it may have been folded into a template occurrence, so resolve it through that occurrence rootMap (or inflate first). childCount null means its children could not be read, not that it is a leaf. An isAsset subtree collapses to counts by node type plus readErrors, never a silent drop. changeBatchesDuringWalk counts DOCUMENT-WIDE change batches during this dispatch (a conservative bound, not subtree edits). Multi-selection reads the first selected node only, and bindings.fills names the first bound paint only. --no-css skips the one expensive read (~7-8ms per node). Each record may also carry intent — what the DESIGNER meant: devStatus (Ready for dev), annotations (label + categoryId + property types; categoryId is raw, exec-js ui.annotate.categories() names them), devResources (links, but ONLY with --dev-resources: that one subtree-wide read measured a FIXED ~2s on a Free file whatever the subtree size — 11 nodes 2115ms, 121 nodes 2060ms, a 453-node page 2149ms — because it is a server round trip, not a walk, so it is never paid unless asked for. With the flag it runs BEFORE the walk, bounded by neither --budget nor --depth (on a page target it reads the whole page; at --depth 0 it narrows to the target node itself, measured 408ms). Its cost is CHARGED against the soft deadline (the walk gets deadlineMs minus readMs), so passing the flag never pushes the reply past the wire timeout — it shortens the walk instead, and the partial-with-counts still arrives. budget.devResources {found, attached, unaddressed?, readMs, error?} is reported UNCONDITIONALLY, found 0 included — presence means "you asked", so "none here" is never confused with "nobody looked". found and attached both count LINKS, not layers (one layer routinely takes several), so attached below found means those links belong to nodes absent from this reply: descendants the budget or deadline never enqueued, nodes outside --depth, or a record whose identity read refused and which therefore carries no intent. unaddressed (present only above 0) counts links the read returned that name no readable node id and so could be attached to nothing), componentKey pointing at refs.components[key], where a component description, descriptionMarkdown (only when it differs) and documentationLinks are resolved ONCE PER KEY, and intent.component carrying those same fields INLINE for a component whose key is empty or unreadable (there is no key to dedup by). intent is absent when nothing is set — on a file where nobody used Dev Mode that is every node, and it is an honest absence, not a missing capability. A refused intent read keeps the node, adds intentError and counts it partial. --dedup (opt-in, off by default) shares repeated literal css/layout blocks as refs.literals[hash] + cssRef/layoutRef and repeated subtrees as refs.templates[hash] + a templateRef occurrence carrying rootMap {relativeId: {id, name, at}}; it never merges two named refs and never merges a literal with a named ref, so bindings and styles are untouched. It reports dedup {applied, savedBytes?, foldedNodes?} — foldedNodes counts the records that went into a template occurrence and is present whenever applied is true, 0 included — and ships the RAW form with applied:false plus a reason whenever the deduped one would not be smaller. --budget still bounds the RAW records (estimatedBytes); the transform runs after the walk and its cost is finalBytes. There is no --inflate flag: inflateContextReply in cli/src/commands/context-inflate.ts is the exact inverse, for agents importing the CLI as a module. --format is reserved and refused, not ignored.
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
- `export-png` — --node <id|selection> --out file.png [--scale 2] [--assert <script.js> [--assert-timeout ms] [--no-lint] [--strict]]   --assert runs the script FIRST as a plugin-enforced read-only exec-js (same preflight lint as exec-js; a script that writes is refused by the plugin with E_READONLY_VIOLATION — the write is sealed into its own undo step, never applied silently) and exports only when it passes: a truthy return or {ok:true}. A falsy return or {ok:false,...} exits 1 with E_ASSERT_FAILED quoting the result; a throw keeps its own code. No PNG is written on any failure, so a file on disk always means the structural check held (craft gate 9: structure + PNG in one command). The reply carries assert:{script,result}.
- `html-to-figma` — --html <file|-> [--width 1280 --x --y --parent id --replace id]
- `shader-gradient` — Bake an animated ShaderGradient field onto a node as an image fill [--node <id|selection>] [--preset <slug> | --url "<customize url>" | --set k=v,k2=v2] [--w 1200 --h 800 --scale 2] [--static] [--timeout ms] [--list]   --preset takes a ledger slug (or upstream's camelCase key); --url takes a shadergradient.co/customize link; --set overrides either. --static freezes the field instead of capturing it mid-animation. --list prints the preset roster and --self-test renders a tiny throwaway field to report whether this environment can bake at all; both are read-only and make no canvas change. The resolved config is stored on the node so a later bake can reproduce or resize it.
- `exec-js` — <file|-> [--timeout ms (cap 120000)] [--undo-group] [--no-lint] [--strict] — exec-js lints scripts before dispatch; --no-lint explicitly bypasses that local preflight. Hard findings (sync dynamic-page getters, import declarations) refuse; warnings go to stderr — the sync mainComponent getter, findAll without a visible filter, componentProperties on a COMPONENT_SET, and the older heuristics — unless --strict, which refuses on any warning too. --undo-group brackets the script in ONE undo step and reverts it on error; the script must not call figma.commitUndo/triggerUndo itself, and a timeout cannot stop a running script (the plugin has no cancellation). While it runs, figma.currentPage carries one extra invisible child (the undo sentinel) — a script that enumerates or counts the page's children will see it. `console` and `ui` are injected — a script cannot declare its own.
- `capture` — <url> [--out dir --headless --channel chrome --width 1440 --timeout ms --carousel-window ms]
- `batch` — <file.json> [--stop-on-error]
- `changes` — [--since ts|iso --owner-only --actor owner|agent|ambiguous --file name|slug --limit 50 --page name]  [--png <dir> [--scale 2]]  read the owner-edit feed (wave 4.4) — pure fs, works even with the plugin closed; --owner-only is sugar for --actor owner. --png (needs a live plugin) exports a read-only AFTER PNG per unique node in the listed window to <dir>/<node-id>.after.png and reports every path under png:{dir,exported,skipped}; a BEFORE exists only when a prior export of that node in <dir> predates the earliest edit (then it is kept as <node-id>.before.png, beforeSource:"prior-export") — otherwise before:null with the reason, never a guess. Nodes deleted in the window and nodes the plugin cannot find are listed in skipped with a reason; --limit bounds the export count the same way it bounds the listing. A transport failure (E_NO_PLUGIN/E_NO_BROKER/E_TIMEOUT/E_VERSION_MISMATCH) stops the export at that node: the same JSON is still printed with everything that landed plus png.error:{code,message,atNodeId}, and the command exits 1.
- `errors` — [--since ts|iso --file name --limit 50]  read the broker's error log (backlog 4.6) — full untruncated message + cmd/activity/code/fileName, for an agent to read-and-fix; --file filters by the entry's own fileName
- `contention` — [--file name --since days]  read the durable per-file/per-day queued-time counter — total ms a mutation waited in the FIFO before dispatch, plus jobCount, per UTC day; --file filters by fileSlug, --since limits to the last N days; pure fs, works with the plugin closed
- `install-skill` — [--folder ~/.claude/skills] [--with-craft|--no-craft] [--yes]   write this emitted SKILL.md to a folder Claude Code reads skills from; prompts before overwriting an older installed version and before bundling skills/es-figma-craft — a non-interactive run needs --with-craft/--no-craft or it skips craft and says so
- `install-hook` — [--dry-run] [--yes] [--settings <path>]   add a SessionStart hook to Claude Code settings that runs "figma-agent status --peek" at the start of every session; confirms before writing, backs up the file first, and aborts untouched if it can't parse the file as JSON
- `cowork` — [--wait S] [--timeout S]   wait for ONE designer change-cycle: quiescence of --wait seconds (default 3, floor 1) after the designer edits, or --timeout seconds (default 600, in SECONDS like status --wait) with zero edits — that is a normal answer (cycles:0), not an error. Prints the edited nodes plus any pending agent corrections on them, read-only from the existing correction ledger (never writes it). Only actor:owner edits on a LIVE batch arm the cycle — an agent's own writes, ambiguous-actor edits, and a gapfill replay never do. The plugin disconnecting mid-wait refuses with a reconnect hint instead of hanging to the full timeout.
