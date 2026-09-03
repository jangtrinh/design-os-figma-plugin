# Why it feels different

The README makes four promises in one clause each. This page is the evidence behind them, the full
comparison with Figma's official MCP server, the observability contract, and what is shipped versus
still open. Operational reference (structure, the editing loop, the rail, multi-file targeting,
troubleshooting) lives in [operations.md](operations.md); the command manual is
[`../skills/figma-agent/SKILL.md`](../skills/figma-agent/SKILL.md).

## 1. The agent arrives already knowing

The transport was never the missing piece. The broker starts on demand and the plugin reconnects
itself. What was missing is knowledge at the moment a session opens, so the CLI hands it over:

```sh
figma-agent install-skill            # into ~/.claude/skills by default; --folder to redirect
figma-agent install-hook --dry-run   # show the SessionStart hook; --dry-run writes nothing
```

The skill's command reference is emitted from the CLI's own command table, the same table `--help`
renders, and a test fails the build when the committed file and the emitter disagree. A reference that
can drift is a reference that will, so this one cannot. See `emit:skill` in
[`../package.json`](../package.json).

The hook runs one cheap question at every session start. `status --peek` reads the broker's `/tmp`
advertisement and, only if one is live, asks it one short question. It never spawns a broker, and idle
is a normal answer with exit 0. Its reply carries `versionMatch` and `protocolMatch`, so a plugin build
that no longer matches the CLI is visible before it causes a confusing failure; `null` there means the
plugin never reported a version, never "mismatch". Neither installer touches anything without asking:
`install-hook` backs up your settings first and aborts untouched if it cannot parse them.

## 2. Every edit reaches the codebase, and the right codebase

Every change a designer makes is captured live and, after the file goes quiet, offered back as one
prompt: "N changes ready, Sync now." A click runs a deterministic reconcile over the ledger. No model
sits in that path, so a sync is reproducible and auditable. And a sync cannot guess where it goes:
each Figma file is bound to its project once.

```sh
figma-agent bind --file "Design System v4" --dir ~/code/your-app
```

From then on that file's changes land in that project's registry, never in whatever directory a
process happened to start from. The confirmation never flatters itself: "Synced, 3 added, 1 updated"
only when records were written, "Nothing synced" when the run landed nothing, and a failure keeps the
prompt alive so the retry is still there.

Edits made while the plugin was closed are not lost either. On the next open a gap-fill diff reports
them. On a 21-page file every page produced a signal, 21 of 21: pages under the node cap per node,
pages over it through top-level frame fingerprints. The capture handler and the diff live in
[`../plugin/src/main/document-change-capture.ts`](../plugin/src/main/document-change-capture.ts) and
[`../plugin/src/main/edit-gapfill.ts`](../plugin/src/main/edit-gapfill.ts).

## 3. The agent cannot wreck your file

Every mutating operation seals its own undo step. ⌘Z rolls back one thing, not the whole session.
Arbitrary scripts run inside a bracket that undoes itself on error, and report `rolledBack: true` only
when the rollback actually completed.

Mutations are jobs. One runs per file at a time, the rest queue in order, reads bypass the queue. A
timeout tells you the work was not cancelled and hands you a job id to poll. Cancel actually cancels.
A reply arriving after a job was killed is discarded, never served. If transport drops after a
mutation was dispatched, its outcome is unknown: poll the job, inspect the canvas, then run the
reported bare `job <id> --force-release`. Never retry that mutation automatically.

A file can also be sealed on purpose. `mutation-gate pause --file-key <key>` shuts the door on agent
mutations for exactly that file, keyed on the raw Figma `fileKey` and never on a filename. Reads keep
working and your own manual editing is never blocked.

Every error lands in `design/figma-errors.jsonl` with its full untruncated reason, a log written for
the agent that caused it so it can read and fix, and `figma-agent errors` reads it back without
crashing on a bad line.

## 4. Multiple files, one broker

Several open Figma files stay connected at once. They no longer evict each other. Commands without a
target prefer a ready file, `FIGMA_AGENT_FILE` pins the default by name, and exact `--file` or
`--instance` targets never fall through to a different file: if the exact target is connected but
app-unready, the broker probes only that target, then dispatches once after readiness returns or fails
with a bounded `E_APP_UNREADY`. Several agents can share one file too. Pass `--agent claude`, or set
`FIGMA_AGENT_ID`, and the panel labels each entry with the harness that sent it, so a designer watching
the canvas can tell who just did that. Readiness gates only agent dispatch; manual edits stay available.

## 5. Fast on a file large enough to hurt

Measured on a real 21-page, 418k-node file, before and after the September 2026 performance work:

| | before | after |
|---|---|---|
| Worst synchronous stall at plugin open | 0.3 to 1.5 s per page | 21 to 44 ms (20 ms time-budgeted slices) |
| Idle re-index / close | one blocking tick | 0.75 s in slices / close costs nothing |
| Bookkeeping bytes written into the design file | 0 (the writer was failing silently) | 0 (baseline lives in `clientStorage`) |
| Pages producing a closed-window edit signal | 5 of 21 | 21 of 21 |
| Store reads for a 200-change batch | 400 | 2 |
| Broker discovery when no broker is up | up to 12 s | one 1.2 s window |

Two rows matter beyond the stopwatch. The gap-fill baseline lives in `figma.clientStorage`, so zero
bytes are written into the design file for bookkeeping and its own version history stays clean.

And edits captured before the WebSocket opens are buffered and dated at capture time. They are never
dropped silently, and the drops a full buffer does force are counted.

Those numbers describe one real file. `figma-agent status` prints yours. The slicing budget and bounded
walk live in [`../plugin/src/main/page-walk-bounded.ts`](../plugin/src/main/page-walk-bounded.ts).

## Honesty guarantees

House rule, enforced in code and in review: nothing vanishes silently. Every eviction, prune,
rotation, and drop leaves a counter, an archive, or an audit record. A wrong fact is worse than an
absent one. It is readable in `figma-agent status`:

- `gapfill.pagesDiffed`, `pagesTruncated`, `pagesTopLevelOnly` show how much coverage the last
  reconnect actually delivered, per page, rather than leaving it to inference.
- `gapfill.pagesWithReadErrors` and `deletedRechecked` are present only when non-zero. A node that went
  missing mid-walk is carried to the next session, never reported as a deletion that did not happen.
- `gapfill.baselineWrittenAt`, `baselineBytes`, `baselineEvicted`: a session that wrote no baseline
  reports `null` instead of looking identical to one that did.
- `perf.bootWalkMaxSliceMs`, `idleWalkMaxSliceMs`, `bootLoadAllPagesMs` are the worst chunk, not the
  mean, because a mean hides the stall you actually felt. They appear only after boot completes, so
  `0` always means measured-zero and never never-ran.

Field definitions and the reasoning for each live in
[`../plugin/src/main/gapfill-status.ts`](../plugin/src/main/gapfill-status.ts) and
[`../plugin/src/main/perf-stats.ts`](../plugin/src/main/perf-stats.ts). Panel and CLI output never
fabricate: a name appears only when the reply carried one, a count only when one parsed.

## With this plugin, or Figma's official MCP alone?

Both are real bridges and they are not exclusive. Figma documents its remote MCP server as
"available on all seats and plans", so reading a file through it is open to everyone. Write to canvas
is documented as "currently available to Full and Dev seats on paid plans" and as something that
"will eventually be a usage-based paid feature, but is currently available for free during the beta
period". This plugin covers the other side: the Plugin API in Figma Desktop, where editor rights on
the open file are the only permission involved.

| | figma-agent plugin | Figma's official MCP alone |
|---|---|---|
| Getting connected | `status --peek` at session start, plus a skill emitted from the CLI's own command table | OAuth sign-in to `https://mcp.figma.com/mcp`, from a client in Figma's MCP catalog |
| Write path | Public Plugin API, through a plugin you import in Figma Desktop | `use_figma`, `generate_figma_design`, `create_new_file`, `upload_assets`; write to canvas needs a Full or Dev seat on a paid plan |
| Undo granularity | One undo step per mutation; scripts roll back on error and report `rolledBack: true` only when the rollback completed | Not covered by the published tool list |
| Seeing the designer's edits | Live `documentchange` feed, gap-fill diff across a closed window, `changes --owner-only` | Read on demand; no change-subscription tool in the published list |
| Two actors at once | Per-file mutation FIFO, one job at a time, reads bypass, cancel, explicit outcome-unknown protocol | Not covered by the published tool list |
| Large files | 21 to 44 ms worst stall at open on a 418k-node file, measured | No published figures to compare against |
| Multiple open files | Several files on one broker; exact `--file` targets never fall through | One authenticated session; targeting is per call |
| Observability | `status` reports `gapfill.*` and `perf.*`, plus an errors log and a contention counter | `whoami` reports identity and plans |
| Where it runs | Broker on `127.0.0.1`, no model call in the CLI or broker | Hosted endpoint; a desktop server exists for "a Dev or Full seat for all paid plans" |
| Code context | Not offered | `get_design_context`, `get_code_connect_map`, `get_variable_defs`, `get_motion_context`, `search_design_system` |
| FigJam, Slides, new files | Manifest covers the Figma, FigJam and Slides editors | `get_figjam`, `generate_diagram`, `create_new_file` |

### What this plugin does not do

Said plainly, because the official server does these and this one will not:

- **No code context.** No `get_design_context`, no Code Connect mapping, no motion or variable
  extraction aimed at code generation. For design-to-code the official MCP is the better tool.
- **No design-system search across libraries.** `scan-design-system` reads the open file only.
- **Nothing works with the panel closed.** Every live command needs Figma Desktop open with the
  plugin running. The official remote server has no such requirement.
- **No hosted anything**, and it is a development plugin you import yourself, not a published Figma
  Community plugin.

### Use both

The two answer different questions, and the design:os craft skill already routes them that way: MCP read
tools for diagnosis, recon, and verification on a cheapest-first ladder (`get_metadata`, then
`get_screenshot`, then `get_design_context`), and the figma-agent CLI for mutations on a project wired
for it. `figma-agent seat` encodes the same split. Reading through the official server and writing
through the plugin is a supported combination, not a compromise.

## Commands

Full reference in [`../skills/figma-agent/SKILL.md`](../skills/figma-agent/SKILL.md), emitted from the
CLI's own command table so `--help` and the skill cannot disagree.

| | |
|---|---|
| Connect | `status` (`--peek`, `--wait`) · `seat` · `bind` · `install-skill` · `install-hook` |
| Read | `get-selection` · `inspect` · `scan-design-system` · `scan-node` · `scan-conventions` · `audit-ds` |
| Draw | `create-frame` · `create-instance` · `set-variant` · `set-autolayout` · `set-text` · `clone-traits` · `html-to-figma` · `export-png` |
| Flows | `connect` · `disconnect` · `list-connections` · `reroute` · `draw-flow` · `verify-connections` |
| Variables | `create-variable` · `bind-variable` |
| Escape hatch | `exec-js` · `batch` · `job` · `mutation-gate` |
| Read back | `changes` · `errors` · `contention` · `cowork` · `sync-corrections` |

`cowork` waits for one designer change-cycle: the designer edits, then goes quiet for `--wait` seconds,
and the command returns the nodes they touched. Only an owner edit arms it, so an agent can never wake
itself up.

## Status and roadmap

Version `0.1.0`. Shipped and merged to `main`: the adaptive semantic agent rail, the background-file
heartbeat and outcome-unknown recovery contract, the broker mutation admission gate, the
connect/reconnect path (`status --wait` plus Figma's native relaunch action), the published-lint panel
boundary, and the performance work above. Four gates run on every pull request: `typecheck` (including
a DOM-less config that catches main-sandbox globals Vitest cannot), `lint:comments`, `test` (2,168
tests, including a panel gate running the same layout, accessibility, taste, and content linters as
ease-design artifacts), and `build`.

Known follow-ups, tracked and unshipped: bounding the serial node re-check on a mass deletion; counting
a replayed capture as activity inside the quiet window; isolating the test harness from a live broker on
the shared port; Tier-2 subtree hashes for inner edits on oversized pages.
