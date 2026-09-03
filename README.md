# design-os-figma-plugin

Your agent freezes Figma. ⌘Z eats twenty minutes of its work. Your registry lies because a
designer moved a frame on Tuesday. And when you both edit at once, half the change survives.

**An agent and a designer in the same Figma file, without any of that.** A Figma Free plugin and
a CLI, over a local broker. Public Plugin API only.

<p align="center">
  <img src="docs/images/agent-rail-single-row.png" width="320" alt="The figma-agent panel: a single row showing the orb and the status Ran a script">
</p>
<p align="center"><sub>One row, hugging its content.</sub></p>

## You know this moment

**The plugin opens and Figma stops responding.** You wait, then close it and do the work by hand.
Here the worst stall at open measured 21 to 44 ms on a 418k-node file.
[How](docs/deep-dive.md#5-fast-on-a-file-large-enough-to-hurt)

**You press ⌘Z once and twenty minutes of automated work vanishes.** One undo step per mutation.
[How](docs/deep-dive.md#3-the-agent-cannot-wreck-your-file)

**Your registry says a component is where it no longer is.** Edits made while the panel was closed
still arrive. [How](docs/deep-dive.md#2-every-edit-reaches-the-codebase-and-the-right-codebase)

**You and the agent both write, and half the change survives.** One mutation per file at a time,
the rest queue, reads never wait. [How](docs/deep-dive.md#3-the-agent-cannot-wreck-your-file)

## It is fast because someone measured it

On a real 21-page, 418k-node file, before and after the September 2026 performance work:

| | before | after |
|---|---|---|
| Worst synchronous stall at open | 0.3 to 1.5 s per page | 21 to 44 ms |
| Idle re-index / close | 10 to 15 s in one blocking tick | 0.75 s in slices / close costs nothing |
| Bookkeeping bytes in your design file | 0 (the writer was failing silently) | 0 (baseline in `clientStorage`) |
| Pages reporting edits made while closed | 5 of 21 | 21 of 21 |
| Store reads per 200-change batch | 400 | 2 |

Those are one real file, not a benchmark. `figma-agent status` prints yours, including the
uncomfortable numbers: every drop is counted, and a field appears only when it is real.
[The full contract](docs/deep-dive.md#honesty-guarantees)

## With it, or Figma's MCP alone?

Not exclusive. Figma documents its remote MCP server as "available on all seats and plans", so
reading is open to everyone; write to canvas is documented as "currently available to Full and Dev
seats on paid plans". This plugin covers the other side, where editor rights on the open file are
the only permission involved.

It is the weaker tool for some jobs, and that is not a close call: **no code context, no Code
Connect, no cross-library search**, and **nothing works with the panel closed**. For design-to-code
the official MCP wins. Use both. Read through the MCP, write through the plugin.
[Row-by-row comparison](docs/deep-dive.md#with-this-plugin-or-figmas-official-mcp-alone)

## Nothing to sign up for

- **Figma Free.** Public Plugin API in Figma Desktop. No OAuth, no access token, no paid seat.
- **Local.** Broker on `127.0.0.1`, no model call in the CLI or broker. The one exception: the
  `html-to-figma` and shader iframes load pinned CDN assets, declared in `plugin/manifest.json`.
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
$FA create-frame --name Card --w 320 --h 200 --agent claude
```

Then hand the agent its own manual: `figma-agent install-skill`.

Why it feels different: [`docs/deep-dive.md`](docs/deep-dive.md) · operations and troubleshooting:
[`docs/operations.md`](docs/operations.md) · full command manual:
[`skills/figma-agent/SKILL.md`](skills/figma-agent/SKILL.md) · part of
[DESIGN:OS](https://github.com/jangtrinh/design-os) · attribution:
[THIRD-PARTY.md](THIRD-PARTY.md) · MIT, see [LICENSE](LICENSE).
