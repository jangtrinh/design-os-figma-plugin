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

## Request chunk recovery

CLI request chunks are admitted in strict sequence before retention. A malformed or missing frame
releases only that connection's affected request; closing the connection releases its partial
requests immediately. Gap-sweep and close cleanup leave numeric request, frame, and UTF-8-byte
records in the broker log without payloads or paths. The executable contract lives in
[`request-chunk-admission.ts`](../cli/src/transport/request-chunk-admission.ts), with daemon coverage
in [`broker-request-chunk-admission.test.ts`](../tests/broker-request-chunk-admission.test.ts).

## Upgrading the installed CLI and broker

Swapping the global `figma-agent` replaces the broker that serves every open Figma file. Do it on a quiet
canvas, from a release checkout that nothing rebuilds, and keep the rollback targets written down first.

**How a newer build takes over.** Every connecting command calls `ensureBroker`
([`broker-discovery.ts:284-310`](../cli/src/transport/broker-discovery.ts)). It reuses the advertised broker
only when its `protocolV` equals the CLI's `PROTOCOL_VERSION` and the CLI's bundle is not newer than the
broker's `buildMtime` (1 ms tolerance). Otherwise it sends `BROKER_SHUTDOWN_REQUEST`, waits up to 3 s,
sends SIGTERM if the pid is still alive (`:206-240`), and spawns its own broker. So the **first** connecting
command from the new build replaces the running broker; open plugin panels drop and reconnect to it on
their own. The reverse never happens: an older build with the same `PROTOCOL_VERSION` reuses a newer
broker, and a new daemon refuses to start while a same-or-newer one is live
([`broker-daemon.ts:538-544`](../cli/src/transport/broker-daemon.ts)). No CLI command shuts a broker
down, which is why rollback below has an explicit `kill -TERM`.

**The spawned broker inherits the spawning command's cwd and environment**
([`broker-discovery.ts:243-249`](../cli/src/transport/broker-discovery.ts)). The change log defaults to
`<cwd>/design` unless `FIGMA_AGENT_CHANGES_DIR` is set
([`change-log.ts:31-35`](../cli/src/transport/change-log.ts)), and `FIGMA_AGENT_*` knobs are read from that
environment. Run the first post-swap command from a fixed, neutral directory with only the variables you
mean the broker to keep.

### 1. Pre-flight (read-only)

```sh
readlink -f "$(which figma-agent)"                   # the bundle the global command runs
ls -la "$(npm root -g)" | grep figma                 # the global package link(s)
ls -la "$(npm prefix -g)/bin/figma-agent"            # the global bin link
python3 -c "import json;d=json.load(open('/tmp/figma-agent-broker.json'));print(d['pid'],d['buildMtime'],d['protocolV'])"
```

Write down both link targets **verbatim** (`readlink`, not `readlink -f`) — they are the rollback. On a
machine where the global package is a symlink to a folder without a `package.json` (an older monorepo
workspace), `npm ls -g` shows `figma-agent@` with an empty version and `npm install -g .` can refuse to
overwrite the foreign `figma-agent` bin; that is why the swap below removes the links by hand.

**Quiet canvas.** No job may be running or queued. On a broker that has the job table, `figma-agent job
--list` must show nothing running; otherwise ask the people on the canvas. Do not proceed on a busy canvas.
Pause every agent, watcher, hook or cron job that invokes `figma-agent` (e.g. project SessionStart/PreToolUse
hooks, comment pollers) until the verify step passes — any of them could otherwise become the first post-swap
command and spawn the broker from an arbitrary cwd.

**Plugin caps.** The new broker refuses a `--file` mutation to a plugin whose HELLO lacks `fileGuard`
(`E_PLUGIN_STALE`, [`broker-daemon.ts:126-129, 1417-1420`](../cli/src/transport/broker-daemon.ts)), and
app-readiness needs `correlatedHeartbeatV1` + `appProbeV1`
([`plugin-registry.ts:100-106`](../cli/src/transport/plugin-registry.ts)). Check the plugin folder imported in
Figma (Plugins → Development): `grep -c '"fileGuard"' <plugin-folder>/ui.html` must print a non-zero count. If
it does not, rebuild and reopen that plugin before the swap.

### 2. Build a release checkout

```sh
git -C <repo> fetch origin
git -C <repo> worktree add ~/Products/figma-agent-release <merged-commit-or-tag>
cd ~/Products/figma-agent-release && npm ci && npm run build
```

npm installs a folder as a **symlink**, so the global command *is* this checkout: never develop in it or
rebuild it in place — a rebuild changes `buildMtime` under the live broker. Keep its `node_modules`; the
bundle loads runtime dependencies from it. The next release gets its own worktree.

### 3. Swap

```sh
rm "$(npm prefix -g)/bin/figma-agent" "$(npm root -g)/figma-agent"   # only the two recorded links
npm install -g ~/Products/figma-agent-release
readlink "$(npm prefix -g)/bin/figma-agent"   # ../lib/node_modules/design-os-figma-plugin/cli/dist/figma-agent.js
readlink -f "$(npm root -g)/design-os-figma-plugin"   # the release worktree (npm writes a relative link)
```

The package installs as `design-os-figma-plugin` (this repo's name), so `npm ls -g figma-agent` finds nothing
afterwards; the bin is still `figma-agent`.

### 4. First command and verify

```sh
cd <neutral-dir> && figma-agent status          # replaces the broker; spawns the new one here
python3 -c "import json;d=json.load(open('/tmp/figma-agent-broker.json'));print(d['pid'],d['buildMtime'])"
node -e 'console.log(require("fs").statSync(process.argv[1]).mtimeMs)' "$(readlink -f "$(which figma-agent)")"
```

- The advertised `pid` changed, and `buildMtime` equals the new bundle's mtime. `status` does not print
  `buildMtime`; read it from `/tmp/figma-agent-broker.json`.
- `figma-agent status --wait` shows the plugin connected (`appHeartbeatMode: "correlated"` on its row).
- One read-only `exec-js` round trip succeeds, e.g. `echo 'return figma.currentPage.name' | figma-agent exec-js -`.

### 5. Rollback

Relinking alone does nothing: the old CLI reuses the newer broker. Stop the new broker explicitly.

Quiet canvas first, as in step 1: no job running (`figma-agent job --list` on the new broker), because killing
the broker mid-job loses the reply.

```sh
rm "$(npm prefix -g)/bin/figma-agent" "$(npm root -g)/design-os-figma-plugin"
ln -s <recorded bin target> "$(npm prefix -g)/bin/figma-agent"
ln -s <recorded package target> "$(npm root -g)/figma-agent"
kill -TERM "$(python3 -c "import json;print(json.load(open('/tmp/figma-agent-broker.json'))['pid'])")"
```

SIGTERM runs the broker's `shutdown()`: it records each connected plugin as a `broker-shutdown` disconnect
and removes the advertisement only if it still owns it
([`broker-daemon.ts:910-962`](../cli/src/transport/broker-daemon.ts)). Wait until that pid is gone
(`kill -0 <pid>` fails), then run the old CLI's first command from the neutral directory and verify as in
step 4. Any later invocation of a newer build — another shell, a worktree's `node cli/dist/figma-agent.js` —
replaces the old broker again, so stop those first.

### What operators will meet after the swap

- **One script at a time per file.** `exec-js` jobs queue in a per-file FIFO. Against this broker,
  `--timeout` counts from dispatch, not from send; `--queue-timeout` (default 600 000 ms) bounds the wait
  and cancels a still-queued script, which then never runs.
- **Wedged jobs keep the slot.** The watchdog marks a silent job `E_TIMEOUT` at ~125 s, but the file's
  mutation slot stays held until the plugin replies or `figma-agent job <id> --force-release`. A script
  queued behind it fails at once, naming the blocker and that command.
- **Refusal codes** a July-era build never returned: `E_MUTATION_GATE_UNAVAILABLE`,
  `E_FILE_KEY_UNAVAILABLE`, `E_STALE_ADMISSION`, `E_OUTCOME_UNKNOWN`.
- **Flags:** `export-png --timeout` (default 60 000, max 120 000); `exec-js --timeout` above 120 000 is
  lowered with one stderr notice; `exec-js --queue-timeout`.
- **Disconnect record:** every plugin socket close appends one line to `/tmp/figma-disconnects.jsonl`
  (mode 0600; `/tmp` is cleared on reboot), and `status` shows a `disconnects` field with the path, the
  newest records, and the append-failure count.

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
