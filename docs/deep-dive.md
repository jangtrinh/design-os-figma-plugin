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
with a bounded `E_APP_UNREADY`. Several agents can share one file too. Pass ``, or set
`FIGMA_AGENT_ID`, and the panel labels each entry with the harness that sent it, so a designer watching
the canvas can tell who just did that. Readiness gates only agent dispatch; manual edits stay available.

## 5. Fast on a file large enough to hurt

Measured on a real 21-page, 418k-node file, before and after the September 2026 performance work:

| | before | after |
|---|---|---|
| Worst synchronous stall at plugin open | 0.3 to 1.5 s per page | 44 ms on a cold open, 21 ms for the walker alone (slices end at 500 nodes or 20 ms, whichever comes first) |
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
"available on all seats and plans", so reading a file through it is open to everyone. For writing,
Figma states "You need a Full seat to write to Figma files with agents", that "Dev Seats get
read-only access outside of their drafts", and that this "will eventually be a usage-based paid
feature, but is currently available for free during the beta period" (Figma docs, September 2026).

| | figma-agent plugin | Figma's official MCP alone |
|---|---|---|
| Getting connected | `status --peek` at session start, plus a skill emitted from the CLI's own command table | OAuth sign-in to `https://mcp.figma.com/mcp`, from a client in Figma's MCP catalog |
| Write path | Public Plugin API, through a plugin you import in Figma Desktop | `use_figma`, `generate_figma_design`, `create_new_file`, `upload_assets`; writing needs a Full seat |
| Undo granularity | One undo step per mutation; scripts roll back on error and report `rolledBack: true` only when the rollback completed | Not covered by the published tool list |
| Seeing the designer's edits | Live `documentchange` feed, gap-fill diff across a closed window, `changes --owner-only` | Read on demand; no change-subscription tool in the published list |
| Two actors at once | Per-file mutation FIFO, one job at a time, reads bypass, cancel, explicit outcome-unknown protocol | Not covered by the published tool list |
| Where it runs | Broker on `127.0.0.1`, no model call in the CLI or broker | Hosted endpoint; a desktop server exists for "a Dev or Full seat for all paid plans" |
| Code context | Not offered | `get_design_context`, `get_code_connect_map`, `get_variable_defs`, `search_design_system` |

### What this plugin does not do

Said plainly, because the official server does these and this one will not:

- **No code context.** No `get_design_context`, no Code Connect mapping, no variable extraction aimed
  at code generation. For design-to-code the official MCP is the better tool.
- **No design-system search across libraries.** `scan-design-system` reads the open file only.
- **Nothing works with the panel closed**, and the remote server has no such requirement.
- **No hosted anything**, and it is a development plugin you import yourself, not a published Figma
  Community plugin.

### Use both

The design:os craft skill already routes them that way: MCP read tools for diagnosis, recon and
verification on a cheapest-first ladder (`get_metadata`, then `get_screenshot`, then
`get_design_context`), and the figma-agent CLI for mutations on a project wired for it.
`figma-agent seat` encodes the same split.

## Which bridge should you use?

Several projects solve overlapping parts of this problem and most arrived first. Stars as of
2026-09-03: [Framelink](https://github.com/GLips/Figma-Context-MCP) 15.8k,
[cursor-talk-to-figma](https://github.com/grab/cursor-talk-to-figma-mcp) 7.0k,
[figma-console-mcp](https://github.com/southleft/figma-console-mcp) 2.2k,
[cast-to-figma](https://github.com/newfiction/cast-to-figma) 9. This project is new and has none of
that history.

Where each does well, in their own words. Figma's official server is the design-to-code path and the
one that runs without the desktop app. Framelink is the most-adopted Figma MCP of any kind and
"simplifies and translates the response" from Figma's API for the model. figma-console-mcp is the
most actively maintained write bridge here, ships 121 tools in its local mode, and advertises
"Real-time selection tracking and document change monitoring". cursor-talk-to-figma is the
most-starred write bridge. cast-to-figma is the closest architectural neighbour to this project,
ships an `undo` command for the last operation, and is published on Figma Community, which this
plugin is not.

**A** this repo · **B** [Figma official MCP](https://developers.figma.com/docs/figma-mcp-server/) ·
**C** cursor-talk-to-figma · **D** figma-console-mcp · **E** cast-to-figma · **F** Framelink.
"not documented" means the capability is absent from that project's published docs, which is not the
same as absent from the product.

| capability | A | B | C | D | E | F |
|---|---|---|---|---|---|---|
| Write to canvas | yes | yes, `use_figma`, remote server only | yes | yes, `figma_execute` | yes | no |
| Works on Figma Free | yes | reads "available on all seats and plans"; writes need a Full seat | not documented | yes, documented for Free, Pro and Organization plans | not documented | not documented |
| Driveable from a CLI | yes | MCP client, no CLI | MCP, no CLI | MCP, no CLI | yes | MCP, no CLI |
| One undo step per mutation | yes | not documented | not documented | not documented | `undo`, last operation | n/a |
| Sees designer edits live | yes | no subscribe tool in the published list | not documented | yes, "document change monitoring" | yes, `cowork` | no |
| Recovers edits made while closed | yes | n/a, never closed | not documented | not documented | not documented | no |
| Per-file mutation queue | yes | not documented | not documented | not documented | not documented | n/a |
| Multiple files at once | yes | yes, any file by URL | not documented | multi-instance ports | file-local | yes |
| Local only, no cloud call | yes, CDN iframes excepted | hosted; the local server needs a paid seat | yes | local yes, Cloud mode no | yes | no, REST cloud |
| Published large-file numbers | yes, 418k nodes | no | no | no | no | no |
| Design-to-code context | no | yes, `get_design_context` and Code Connect | read tools | extraction | no | yes |
| No desktop app needed | no | yes, remote server | no | Cloud mode, read-only | no | yes |
| Licence | MIT | proprietary | MIT | MIT | MIT | MIT |

Read the grid honestly. Row 5 is not a win: figma-console-mcp documents live change monitoring and
cast-to-figma ships `cowork`. What is particular here is the combination of rows 6, 7 and 10:
recovering the window while the panel was closed with every dropped frame counted, a per-file
mutation queue with an explicit outcome-unknown protocol, and published numbers on a file large
enough to hurt. That combination is what "built for two actors on one file" means in practice.

Different job, not competitors: [html.to.design](https://html.to.design/docs/pro-plan/), Builder.io
Visual Copilot, Anima and Locofy are design-to-code or one-shot import products.

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
and the command returns the nodes they touched. An owner edit arms it; an agent cannot wake itself up.

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
the shared port; Tier-2 subtree hashes for oversized pages.
