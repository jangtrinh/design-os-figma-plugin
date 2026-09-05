# design-os-figma-plugin

**An agent and a designer in the same Figma file, without the wreckage.**

One undo step per mutation. One mutation per file at a time. Every edit you make while it works
comes back as a reviewable sync.

Free write, no seat, no token, on your machine. A Figma plugin and a CLI over a local broker,
Public Plugin API only. Built and used on a 418k-node production file.

<p align="center">
  <img src="docs/images/agent-rail-single-row.gif" width="560" alt="The figma-agent panel, one row: the orb, the current activity, a pending-sync badge, then the sync result">
</p>
<p align="center"><sub>One row, hugging its content: idle, an import, three changes ready, sync, done.</sub></p>

## You know this moment

**The plugin opens and Figma stops responding.** You wait, then close it and do the work by hand.
Here the worst stall at open measured 44 ms on a cold open of the shipping build, on a 418k-node file.
[How](docs/deep-dive.md#5-fast-on-a-file-large-enough-to-hurt)

**You press ⌘Z once and twenty minutes of automated work vanishes.** One undo step per mutation.
[How](docs/deep-dive.md#3-the-agent-cannot-wreck-your-file)

**Your registry says a component is where it no longer is.** Edits made while the panel was closed
still arrive. [How](docs/deep-dive.md#2-every-edit-reaches-the-codebase-and-the-right-codebase)

**A script times out and you have no idea whether it applied.** A timeout hands you a job id, never
a shrug, and an outcome-unknown job refuses to be retried.
[How](docs/deep-dive.md#3-the-agent-cannot-wreck-your-file)

## It is fast because someone measured it

On a real 21-page, 418k-node file, before and after the September 2026 performance work:

| | before | after |
|---|---|---|
| Worst synchronous stall at open | 0.3 to 1.5 s per page | 44 ms cold open, 21 ms for the walker alone |
| Idle re-index / close | 10 to 15 s in one blocking tick | 0.75 s in slices / close costs nothing |
| Bookkeeping bytes in your design file | 0 (the writer was failing silently) | 0 (baseline in `clientStorage`) |
| Pages reporting edits made while closed | 5 of 21 | 21 of 21 |
| Store reads per 200-change batch | 400 | 2 |

Those are one real file, not a benchmark. `figma-agent status` prints yours, including the uncomfortable ones: every drop is counted, and a
field appears only when it is real. [The full contract](docs/deep-dive.md#honesty-guarantees)

## Two actors, one file

You keep editing. Your changes are captured live and offered back as one reviewable sync, and
`figma-agent changes --owner-only` reads your own edit history as plain sentences at any time. Nodes
the agent made carry provenance, so a later edit of yours on the same node is recorded as a
correction rather than silently overwritten.

Underneath, one mutation runs per file at a time, the rest queue, reads never wait, and an exact
`--file` target never falls through to another open file.

And there is a door. `figma-agent mutation-gate pause --file-key <key>` seals one file against agent
mutations, keyed on the raw Figma `fileKey` and never on a filename. Reads keep working. Your own
editing is never blocked. [How it is enforced](docs/deep-dive.md#3-the-agent-cannot-wreck-your-file)

## With it, or Figma's MCP alone?

Not exclusive, and the official server is the better tool for a whole class of work. Its reads are
documented as "available on all seats and plans", it has Code Connect, and for design-to-code it
wins outright. Write to canvas is where the paths diverge: Figma documents it as needing a Full
seat, and as something that "will eventually be a usage-based paid feature, but is currently
available for free during the beta period" (Figma docs, September 2026).

This plugin is the weaker tool for some jobs and that is not a close call: **no Code Connect, no
cross-library search, no rendered framework code**, **nothing works with the panel closed**, and **no org layer**
(no SSO, no roles, no per-user audit: a per-file kill switch and local logs are what you get). Use both. Read
through the MCP, write through the plugin.

`figma-agent context` returns what the Plugin API exposes on every plan — a node's Inspect-panel CSS
declarations, the variables and styles it binds, its text and component properties, and the designer's
intent where it exists (Ready-for-dev status, annotations, a component's description) — as data for an
agent, budgeted before the wire and counting everything it leaves out. It does not generate
React/Tailwind, it is not Dev Mode, and Ready-for-dev/annotations read as empty on a file where nobody
set them.

[Row-by-row comparison](docs/deep-dive.md#with-this-plugin-or-figmas-official-mcp-alone)

## If you are coming from

**Doing it by hand.** Keep your hands and your taste. The agent is not asked to have either. What it
takes over is the boring 200-node pass: variant sets, re-pointing, rename sweeps. Start read-only.
Run `scan-design-system`, then `audit-ds` on your own library, and see whether it tells you something
true about your file before you let it write to one.

**Figma's official MCP.** Everything stays: your OAuth session, every read tool, Code Connect, your
design-to-code prompts. What changes is the write half. Writes run through a CLI against the file
open in front of you, panel open, no seat involved. You give up working with Figma closed.

**A community talk-to-Figma bridge.** They got here first and several are good. cursor-talk-to-figma
is the most-starred write bridge; figma-console-mcp is the most actively maintained, ships far more
tools, and does advertise real-time document change monitoring; cast-to-figma is the closest
architectural neighbour to this project and has an `undo` command for the last operation. The mental
model here is the same: local WebSocket, plugin panel, script the canvas. What differs is what
happens when things go wrong. Mutations are jobs in a per-file queue with ids. A timeout gives you a
job id to poll instead of a blind retry. Scripts are linted before dispatch, so a sync
dynamic-page getter is refused before it can half-apply. An outcome-unknown job blocks its queue and forbids replay
until you inspect the canvas. And a closed panel is not a blind spot: the next open diffs what
changed while you were away, and counts anything it had to drop.

## Nothing to sign up for

- **Figma Free.** Public Plugin API in Figma Desktop. No OAuth, no access token, no paid seat.
- **Local.** Broker on `127.0.0.1`, no model call in the CLI or broker. The one exception: the
  `html-to-figma` and shader iframes load pinned CDN assets, declared in `plugin/manifest.json`.
  HTML extraction runs inside an opaque iframe with `sandbox="allow-scripts"`. Repository JavaScript
  can update its own DOM and styles; it cannot access the panel document. The panel accepts a result
  only from the active child with the matching protocol and request identity, then validates the payload
  before import. This browser boundary does not provide a separate CPU or process budget.
- **MIT licensed**, and 2,168 tests behind four CI gates.

## Start in 60 seconds

```bash
git clone https://github.com/jangtrinh/design-os-figma-plugin.git
cd design-os-figma-plugin
npm install
npm run build
```

Figma Desktop → Plugins → Development → Import plugin from manifest → `plugin/manifest.json`.
Keep the panel open. Closing it drops the connection.

```bash
FA="node $(pwd)/cli/dist/figma-agent.js"
$FA status --peek                                 # never spawns anything; idle is a fine answer
$FA bind --file "Design System v4" --dir ~/code/your-app
$FA create-frame --name Card --w 320 --h 200
```

Then hand the agent its own manual: `figma-agent install-skill`. Written for Claude Code, and
usable by any agent that can run a shell command.

Why it feels different: [`docs/deep-dive.md`](docs/deep-dive.md) · operations and troubleshooting:
[`docs/operations.md`](docs/operations.md) · full command manual:
[`skills/figma-agent/SKILL.md`](skills/figma-agent/SKILL.md) · part of
[DESIGN:OS](https://github.com/jangtrinh/design-os) · attribution:
[THIRD-PARTY.md](THIRD-PARTY.md) · MIT, see [LICENSE](LICENSE).
