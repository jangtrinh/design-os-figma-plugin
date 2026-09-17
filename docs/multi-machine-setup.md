# Working from more than one computer

A recommended setup for one designer-owner who runs this bridge on two or more Macs (for example a
laptop on the move and a desktop that runs agents in the background) against the same Figma files.
It is distilled from a production case study (two Macs, several agents, one 400k-node Figma file,
in daily use since September 2026). Adapt the names; keep the invariants.

<p align="center">
  <img src="images/multi-machine-architecture.png" width="680" alt="Two Macs, each with Figma Desktop plus the design:os plugin and its own agents, both editing the same Figma cloud files live and both syncing one private GitHub repo every five minutes">
</p>

## The two planes of truth

| Plane | Lives in | Synced by | Never copied into |
|---|---|---|---|
| Design (frames, components, variables) | Figma cloud | Figma, in real time, through each machine's own plugin instance | Git |
| Context (specs, plans, scripts, pins, verify reports, agent config) | One private Git repo, branch `main` | A background `commit → rebase → push` loop on every machine | Figma |

Figma never travels through Git. Two machines edit the same file through the Plugin API and Figma
reconciles them live; Git carries only *what was decided*, *what script ran*, *what the canvas looked
like before the mutation* (a pin), and *what could not be verified* (a report).

## What stays on each machine

Put these in `.gitignore` of the project repo. They are secrets, caches, or regenerable:

```gitignore
# secrets — recreate per machine
figma-key.md
.env
.env.*
*.pem

# per-machine agent state
.claude/settings.local.json

# dependencies / build output
node_modules/
dist/

# session transcript archives (hundreds of MB, per machine)
.brv/context-tree/session-handoffs/archive/

# raster verify shots — the Figma file is the source; a verifier always takes a fresh capture
*.png
*.jpg
*.gif
*.webp

.DS_Store
*.log
```

Two consequences worth writing down for your agents:

- **Durable knowledge goes through tracked files** (`docs/`, `plans/`, a handoff `latest.md`), never
  through an agent's private memory directory. Memory is a per-machine cache.
- **A verifier never trusts another machine's screenshot.** It captures its own, on its own plugin
  instance, after the mutation.

## The five-minute sync loop

One script, committed in the repo, run by `launchd` on every machine. It never guesses on conflict.

```bash
#!/bin/bash
# scripts/git-auto-sync.sh — commit local changes, rebase onto origin/main, push.
# On a rebase conflict: abort, keep local commits, post one notification, retry
# silently each tick until you run `git pull --rebase origin main`, resolve, push.
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
NAME="$(basename "$REPO")"
LOG="$HOME/Library/Logs/$NAME-sync.log"
LOCK="/tmp/$NAME-sync.lock"
MARKER="$REPO/.git/sync-conflict"
HOST="$( (scutil --get LocalHostName 2>/dev/null || hostname -s) | tr '[:upper:]' '[:lower:]')"
NOW="$(date '+%Y-%m-%d %H:%M')"

log() { printf '%s [%s] %s\n' "$(date '+%F %T')" "$HOST" "$*" >> "$LOG"; }
notify() { osascript -e "display notification \"$1\" with title \"$NAME sync\"" 2>/dev/null || true; }

mkdir -p "$(dirname "$LOG")"
if ! mkdir "$LOCK" 2>/dev/null; then log "skip: another sync running"; exit 0; fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT
cd "$REPO" || { log "error: repo missing at $REPO"; exit 1; }

# another tool is mid-operation → wait for the next tick
for f in index.lock rebase-merge rebase-apply MERGE_HEAD CHERRY_PICK_HEAD; do
  [ -e ".git/$f" ] && { log "skip: git busy (.git/$f)"; exit 0; }
done
[ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || { log "skip: not on main"; exit 0; }

# 1. snapshot local changes
git add -A
if ! git diff --cached --quiet; then
  git -c commit.gpgsign=false commit -q -m "chore(sync): $HOST $NOW" && log "commit: $(git rev-parse --short HEAD)"
fi

# 2. bring in the other machine's work
if ! git fetch -q origin main 2>>"$LOG"; then log "skip: fetch failed (offline?)"; exit 0; fi
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  if git rebase -q --autostash origin/main >>"$LOG" 2>&1; then
    [ -e "$MARKER" ] && { rm -f "$MARKER"; log "conflict resolved"; notify "Conflict resolved, sync resumed"; }
    log "rebased onto $(git rev-parse --short origin/main)"
  else
    git rebase --abort 2>/dev/null
    log "CONFLICT: rebase aborted; local commits kept. Resolve: git pull --rebase origin main"
    [ -e "$MARKER" ] || { touch "$MARKER"; notify "Rebase conflict on $HOST. Run: git pull --rebase origin main"; }
    exit 0
  fi
fi

# 3. publish
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  if git push -q origin main >>"$LOG" 2>&1; then log "pushed $(git rev-parse --short HEAD)"; else log "push failed (see above)"; fi
fi
```

Install it once per machine, after cloning:

```bash
#!/bin/bash
# scripts/install-git-auto-sync.sh — register the launchd agent for THIS machine.
# Remove: launchctl bootout gui/$UID/<label> && rm ~/Library/LaunchAgents/<label>.plist
set -eu
REPO="$(cd "$(dirname "$0")/.." && pwd)"
NAME="$(basename "$REPO")"
LABEL="com.$(id -un).$NAME-sync"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/$NAME-sync.log"
chmod +x "$REPO/scripts/git-auto-sync.sh"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$REPO/scripts/git-auto-sync.sh</string></array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict></plist>
PLIST
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST"
echo "installed $LABEL -> $REPO (every 5 min, log: $LOG)"
```

What the loop guarantees:

- **Linear history.** Rebase, never merge commits; `git log --oneline` stays one straight line.
- **Snapshots, not feature commits.** `chore(sync): <host> <time>` every five minutes on `main`. Real
  feature commits appear only when a worktree is merged by hand.
- **Conflicts stop and tell you.** The script aborts the rebase, keeps your local commits, posts one
  macOS notification, then retries quietly every tick. You resolve with `git pull --rebase origin main`.
- **Offline is a skip, not an error.** A failed fetch waits for the next tick; nothing is lost.
- **Worktrees are exempt.** The loop only runs on `main`; a branch checked out in a worktree is a
  workspace, and merging it is a deliberate gate. Delete the remote branch after the merge.

Cost per tick with nothing to do: one `git fetch`. With changes: commit, rebase, push, under five seconds.

## Splitting roles between machines

The setup in the diagram assigns roles; the bridge itself does not care which machine does what.

| Machine | Role | Why |
|---|---|---|
| Laptop | Owner sits here: reviews comments, makes quick edits, decides | Human-in-the-loop lives where the human is |
| Desktop | Runs a maker worker and an independent verifier, each in its own worktree | Long background runs, isolated file ownership |

Three rules the verifier follows, taken from real reports:

1. **Pin before mutating.** The maker snapshots the name, size, and child count of every master it will
   touch into a `pin.json`. The verifier compares against the pin, not against the maker's report.
2. **Fresh capture only.** The verifier takes its own screenshots after the mutation; the maker's
   screenshots are treated as claims.
3. **"What could not be verified" is the first section** of every verify report, with a residual-risk
   column, so the owner can decide from the first five lines.

## Bridge state: what is shared and what is not

Each machine runs its own broker on loopback and its own imported plugin, so each machine has its own
`instanceId` for the same Figma file. Always take `--instance` from `status` on the machine you are
typing on; an `instanceId` copied from the other machine's shell will not resolve.

The bound capture feed and the binding record live inside the project directory
(`design/changes/<fileKey>.jsonl`, `design/figma-bind.json`) and are tracked, so a designer edit
captured on one machine is readable with `changes --owner-only` on the other after the next tick.
The feed is append-only JSONL; if both plugins capture the same file between two ticks, the rebase
can conflict at the tail. The loop stops and notifies as designed; keep both hunks when resolving.

## Known gaps

- **No "who holds this plan" flag yet.** If both machines open a session on the same plan directory,
  the sync will conflict on its handoff file. A line `OWNER: <host>` at the top of the plan is the
  cheapest fix; enforce it by convention.
- **Hostnames.** If `scutil --get LocalHostName` is empty, commits arrive under a placeholder name.
  Set it once with `sudo scutil --set LocalHostName <name>`.
- **Figma has no backup beyond version history.** Save a named version before each package of
  mutations; a periodic export is still an open item.
