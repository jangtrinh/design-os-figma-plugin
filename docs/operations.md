# Operations notes

Reference material that used to live in the README: repository structure, the supervised editing loop,
how the panel row behaves, multi-file targeting, troubleshooting, and the optional probe suite.

## Structure

```
cli/          figma-agent CLI: commands, the broker daemon + WS transport
plugin/       Figma plugin: main-thread executor + a hidden-iframe HTML→Figma converter
shared/       wire-protocol types shared by cli/ and plugin/
scripts/      esbuild build script + an optional probe/ suite (site recon, visual diff)
tests/        vitest unit tests (pure-logic; run with `npm test`)
```

`tests/figma-plugin-panel.test.ts` runs the same layout, accessibility, taste, and content linters as
ease-design-generated artifacts. They come from the exact dev dependency `ease-design@0.5.0`, so `npm ci` is
sufficient to run the panel gate in a fresh clone.

## Supervised editing loop

`inspect` resolves an explicit node first and otherwise uses the current selection. It returns the scoped
node spec and a PNG marked `VISUAL_CHECK_REQUIRED`; run it before and after visual mutation.

`clone-traits` copies only named groups: `layout`, `fills-variables`, `typography`, `spacing`, and `text`.
Text content is never copied unless `text` is explicitly included.

Successful typed mutations stamp agent-operation provenance. A later designer edit on the same node becomes
an immutable linked correction in Figma shared plugin data. `sync-corrections` merges that bounded edge cache
into the project's own `design/memory/figma-corrections.jsonl`. Same-ID/different-hash conflicts are
quarantined; corrections never promote themselves into knowledge.

`cowork` is the live door onto that same ledger — no second store, no polling. It waits for one **designer
change-cycle**: the designer edits, then goes quiet for `--wait` seconds, and the command returns with the
nodes they touched plus any corrections still pending on them.

```bash
figma-agent cowork --wait 3 --timeout 600   # both in seconds; read-only against the ledger
```

Only a live edit whose actor is the *owner* arms that cycle — the agent's own writes, an edit nobody could
confidently attribute, and a gap-fill replay older than the quiet window all leave it alone, so an agent can
never wake itself up. Quiet for the whole budget is a normal answer (`cycles: 0`, exit 0), not an error, and
the plugin disconnecting mid-wait refuses with a reconnect hint rather than hanging to the deadline. Edits it
declined to attribute are reported as a count rather than dropped.

## The agent rail

Once loaded, the plugin is a single `44px` row and nothing else — there is no expanded state. Its width hugs
whatever the row is currently saying: the iframe measures the rendered row and the plugin main thread clamps
that to `240–560px`, so the panel covers as little of the canvas as the sentence allows and the host window
title still reads in full. **Keep it open** while you or an agent drive the CLI; closing it drops the
connection. Multi-file targeting and pending sync appear only when they matter. The sizing contract lives in
[`panel-model.ts`](../plugin/src/ui/panel-model.ts), with the [panel gate](../tests/figma-plugin-panel.test.ts),
a Chromium [hug measurement](../tests/panel-rail-geometry.test.ts) and a
[behaviour test against the built panel](../tests/panel-ui-browser.test.ts) behind it.

The Thinking Orb gives peripheral progress without adding another icon or a verbose status panel. Stable
command identity selects semantic motion; it never guesses from user-facing labels. Concurrent operations
converge on a coordinating state, while an unknown future command falls back to Processing instead of
inventing meaning. The taxonomy and priority rules are owned by
[`orb-command-state.ts`](../plugin/src/ui/orb-command-state.ts), [`thinking-orb.ts`](../plugin/src/ui/thinking-orb.ts),
and their [behavior tests](../tests/orb-command-state.test.ts). `COWORK` maps to Listening only when that
activity is visible to the plugin; a broker-side wait does not fabricate plugin telemetry.

The row's one sentence is ranked, never merged: any edits the relay lost while offline first, then connection
trouble, then sync, then the current activity, then `Idle`. A lost edit leads the line and is the one part
that never shrinks, so when the row runs out of width the ellipsis can only ever cut what ranks below it.
Whatever the line had no room for stays readable in its tooltip. Full history lives in the CLI —
`figma-agent status`, `figma-agent changes`, `figma-agent errors`.

Pending edits show as a count badge on the sync button, and clicking it runs the sync; the result lands in
the sentence. A failed or unbound sync keeps the button for the retry, and only a genuine success clears the
count. An apply with unreliable completion evidence is reported as outcome unknown: its private temporary
capture path remains available for inspection, and `ui figma reconcile --dry-run` must verify state before
retry. If direct-child exit cannot be confirmed, the current broker keeps the sync lane closed. This hold
does not survive broker restart; independently confirm that the child ended before restarting or retrying.

Reconcile evidence records `uiCommand` and `uiExecutable`. On POSIX, the broker selects one absolute
launch path before preview and reuses it for apply. `uiExecutable: null` means native command lookup
was unresolved or delegated (including a bare command on Windows); it is never a fabricated identity.
The path identifies the selected command, not immutable binary contents or its interpreter. Selection
keeps `FIGMA_AGENT_UI_BIN`, then `DESIGN_OS_UI_BIN`, then `ui` on the broker's inherited PATH. An npm
context can put the panel-test dependency's older `ui` ahead of the global kernel. Check the recorded
executable with `--version`; a version printed in another shell may belong to a different command.
To select a known install, set `FIGMA_AGENT_UI_BIN` to its absolute executable path in the environment
that starts the broker. An already running broker retains its original environment; follow the child-exit
checks above before restarting. An override is one executable path or name, never a shell command.

Unresolved failures show as a red count next to the line; that count is
the button that marks them seen, which clears it and the orb's *Needs attention*. Nothing is deleted — the failures stay in the edit
feed and in `figma-agent errors` — and the next failure re-arms both. Every icon action is a locally
vendored Lucide SVG with a tooltip, accessible name, keyboard focus, and a 32px target. The orb canvas is
decorative; its labelled cell announces the semantic status (and carries the build identity in its tooltip),
and reduced motion renders a static frame instead of continuous animation.

## Multiple files open at once

`figma-agent status` lists every connected file (`plugins[]`) and marks the **active** one (`activePlugin`).
By default a command goes to the file you touched most recently. To pin commands to a specific file
regardless of recency:

```bash
FIGMA_AGENT_FILE="VSF" figma-agent html-to-figma --html page.html   # only ever the "VSF …" file
```

With the pin set and no open file matching, the command waits briefly then fails with `E_NO_PLUGIN` naming
the requested file and listing the ones actually connected. Mutating commands wait (up to 60 s, `--no-wait`
to skip) for a plugin whose name matches `--file` exactly before dispatching, so a command issued right
after the broker went idle does not fail with `E_FILE_KEY_UNAVAILABLE`.

## Payload import admission

Direct `IMPORT_PAYLOAD` requests and HTML converter results are validated in the UI relay;
the main importer validates again before creating styles, variables, or nodes. Invalid
fields, active cycles, unrecognized properties, and inputs above the admission budgets
return `E_INVALID_ARGS`. Direct and `{ payload, x, y, parentId, replaceId }` envelopes remain
supported. Omitted or legacy `null` token groups become empty arrays before import consumers
receive them; valid repeated object references are allowed.

The current node, depth, string, image, token, and aggregate budgets are defined in
[`IMPORT_PAYLOAD_LIMITS`](../shared/figma-payload-validation-context.ts). Image strings have
separate headroom for the existing 8 MiB image producer's base64 output. These admission
budgets bound validation and forwarding; they do not isolate arbitrary renderer JavaScript
or establish a whole-process memory limit.

## Runtime snapshot writes

Advertisement, last-plugin and mutation-gate snapshots acquire temporary files exclusively,
write them with owner-only permissions (`0600`), and rename only after closing the write.
An existing temporary path is refused without following a symlink or deleting the collision;
a failed replacement keeps the prior complete snapshot. Mutation-gate write failures continue
to refuse mutations. The implementation is shared in
[`private-file-write.ts`](../cli/src/transport/private-file-write.ts).

This protects these snapshot writes on the local filesystem. Runtime locations are unchanged;
other logs, existing-state reads and processes running as the same OS user require separate
controls. File permissions do not authenticate broker clients.

The binding restart cache uses the same exclusive private temporary-file boundary and
atomic replacement through [`bind-cache.ts`](../cli/src/transport/bind-cache.ts). A failure
preserves the previous cache; the daemon logs its filesystem cause and `bind` adds an
`E_BIND_CACHE_WRITE` warning while reporting the durable binding that was actually saved.
Inspect the cache directory and reported cause before retrying. Cache locations and project
binding markers are unchanged; existing live files are not migrated by installing this code.
A destination symlink is replaced as a directory entry without writing its referent.

## Troubleshooting

- **Panel says "No broker yet" and never connects** — that's the resting state; it only connects once a CLI
  command spawns the broker. Run `figma-agent status` to spawn + verify.
- **`E_NO_PLUGIN`** — the broker is up but no panel is connected: open (or reopen) the plugin and retry, or
  run `figma-agent status --wait`, which blocks until one registers and prints the file's `figma://` link
  while it waits. Right after a rebuild the broker hot-replace can race the panel's reconnect (<1s) — retry.
- **Stuck on "Looking for the broker"** — confirm a CLI command has actually run (the broker is
  demand-started) and that nothing else holds ports 9410–9419. `figma-agent status` is the one-shot health
  check.
- **`N edits lost while offline` in the row** — the relay's pre-connect buffer overflowed while no broker
  was reachable; the count is also in the broker log. Start the broker sooner next session.
- **`status` shows `gapfill.errors`** — the gap-fill baseline could not be read or written this session;
  the previous baseline is kept and the next successful boot diffs against it.

## The `probe/` suite (optional)

`scripts/probe/` holds a small set of Playwright/Puppeteer-based helpers for reconnaissance and visual-diff
work on external sites (recon, network capture, screenshot diffing). These use heavier browser-automation
dependencies (`playwright`, `puppeteer-core`, `pixelmatch`, `pngjs`) declared as `optionalDependencies` —
they do not block installing or building the core CLI/plugin if they fail to install in a given environment.
Run `npm install playwright` inside this repo to enable them.
