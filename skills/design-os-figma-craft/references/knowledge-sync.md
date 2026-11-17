# Knowledge sync — keeping the AI's picture of a live-edited Figma file honest

The owner edits the file **live, sometimes without telling you**. Recorded knowledge (registry / docs / memory) drifts; acting on stale facts breaks builds. This is the standing, cheap mechanism that closes the gap — generic to any project.

## The spine

**Figma is authoritative; the docs are a cache.**

- Docs/registry hold **intent & rationale** (conventions, decisions, *why*) — the part a live read can't reconstruct.
- **Structural facts** (what exists, variants, counts, ids) are re-derived from a **live read every time** you're about to act on them.
- **Resolve by NAME, never by id** — ids renumber; the name is the key. A URL's id is safe for the first read only.

There is no stored snapshot to diff — you diff *your belief* against *reality*, which is the gap that matters.

## Two drift channels

| Channel | What drifts | Mechanism |
|---|---|---|
| **Structural** | renamed/moved/deleted/added nodes, variant/count changes | **URL-drop protocol** (below) — never depend on the owner narrating it |
| **Intent** | a rule changed, a component's meaning was redefined | **Chat → memory** in the same turn (with the why). Invisible to any read. |

Both halves can ride one message: URL-drop reconcile for structure + memory write for intent.

## The URL-drop protocol (owner says "I changed X")

Read cheapest-first; stop as soon as the change is clear:

1. **`get_metadata` on the dropped node** — reveals renames, moves, adds, deletes, counts, variant shape.
2. **Escalate only if structure doesn't show it** (restyle/recolor/copy don't change the tree): `get_screenshot` → `get_design_context` (last resort, scoped to the single node).
3. **Reconcile the records by NAME in the same pass** — update the affected registry row / doc line.

Cost discipline: point at the specific frame, batch multiple URLs, read a changed MASTER once (instances inherit). If every drop escalates to design_context, the drops are scoped too broadly.

If the toolchain has a change feed / corrections log (design:os: `figma-agent sync-corrections`, `design/memory/figma-corrections.jsonl`), drain it after designer correction cycles — corrections are **evidence**, promoted to rules only through the project's governance gate, never auto-converted.

## Proactive reconnaissance

Self-invoke a reconcile at the start of any build touching an area you haven't verified fresh this session — canvas may have drifted since the last doc update. Also: "no docs for X" ≠ "X doesn't exist" — another session may have built undocumented work; recon the canvas before assuming greenfield.

## Full-file reconcile — periodic backstop, not a session-start ritual

The read-only doc↔Figma diff (verification-protocol.md §Reconcile) catches file-wide integrity issues a scoped read can't: duplicate names, orphans, count drift, rotted ids.

| Trigger | Scope |
|---|---|
| Owner URL-drop | dropped subtree |
| Build close | components the build touched |
| Any id fails to resolve by name | full sweep |
| Scoped read surfaces un-reconcilable drift | full sweep |
| Periodic deep-clean | full sweep, occasional |

**NOT a trigger:** blanket session-start reconcile (degrades to a full sweep every session).

## Rejected designs (don't rebuild)

- **Persistent node-tracker / hash mirror** — any mirror of an authoritative live-edited file can only be wrong.
- **Separate "knowledge agent"** — "update the row in the same change" already fuses knowing and doing.
- **Native Figma comments as a channel** — unreadable from the Plugin API/MCP; the async escape hatch is a single named canvas text node, read only when the owner says so.
