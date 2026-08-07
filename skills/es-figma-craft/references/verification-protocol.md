# Verification protocol — 3 layers + the false-green catalog

**Core doctrine: a gate that passes because it is blind is worse than a gate that fails.** Four separate real incidents passed every numeric assert and were caught ONLY by a human-read PNG.

## The 3 layers (run in order, every batch)

### Layer 1 — Node-read asserts (structure)

- Counts, parents, props, names against expectations. For any **structural op** (create/combine/reparent): run in a **COMPLETELY NEW call** — same-call re-fetch can report success for a mutation that never persisted (Class B gotcha).
- `combineAsVariants`: verify the SET's child count + every variant name.
- Usage sweeps: `getMainComponentAsync` (sync getter throws under dynamic-page) and **assert `resolvedOk > 0`** — a sweep that resolved nothing "found 0 issues" by measuring nothing.
- Master minting: read back w/h/children of every new master and compare to expectation BEFORE wiring instances (ancestor walk-ups love grabbing the parent container).

### Layer 2 — Numeric geometry asserts

- **Overlap:** pairwise `absoluteBoundingBox` checks after placing nodes into sections/pages.
- **Collapse:** no created container at ~1px or at createFrame's default 100px; no container narrower than content min-width.
- **Legacy row-based tables:** per-column drift header-vs-every-row ≤0.5px. (Column-first tables don't need it — aligned by construction.)
- **Nav state:** exactly-1-active per nav level, thrown (never silently caught).
- **Binding integrity:** after any bound-paint set/clone: `literal === resolved(variable)` (literal-drift check).
- Write asserts to **throw or collect into returned output** — never swallowed in try-catch.

### Layer 3 — FRESH PNG, read by eye

- Export AFTER the last mutation (check mtime / re-export — a stale PNG once caused a false alarm AND a missed defect).
- Actually LOOK: clipped columns, doubled blocks, stray buttons, wrong active nav, spacing garbage from scripts that "succeeded" but found no targets.
- 1 PNG + 1 assert pass per screen once patterns are stable (SLA 1–3 min/screen); heavy multi-shot ceremony only for first-time patterns.
- Know the PNG's limits (below) — it's the arbiter of LAYOUT, not of text content or bindings.

## When layers disagree

Node-read says fine, PNG looks broken (or vice versa) → **neither wins; measure.** Compare `absoluteBoundingBox` numbers; read text from node `characters`. A PNG crop can fake an overlap; a node-read can miss a render-level failure. Fixing "defects" that only one layer reports has deformed correct layouts before.

## False-green catalog (things that report success while wrong)

| Signal that lied | Truth |
|---|---|
| Same-call re-fetch after structural op | Op may not persist — verify in new call |
| `exec-js` `result:null, ms≈0` | Script never ran (trailing `;`) |
| `exec-js` `result:null`, large ms | Script RAN blind (top-level const) — side effects applied |
| Sync `textStyleId=` sweep "ran clean" | 0 texts styled — silent no-op |
| `setBoundVariableForPaint(..., undefined)` | Bind skipped, no throw |
| Bound paint + "0 raw hex" lint | Renderer uses the parallel LITERAL (literal drift) |
| `setProperties` full-key miss | Silent no-op (`#id` suffix) |
| propRef set on nested-instance sublayer | Silent no-op |
| `.removed === false` after `.remove()` | Node IS deleted — walk the tree |
| Property read-back after set-before-reparent | Value reads correct, actually reverted |
| "hitCount 0" from a sweep using sync `mainComponent` | Sweep measured nothing |
| PNG "looks aligned" | Latent HUG bug drifting every row |
| CLI timeout / E_NO_PLUGIN | Script may still be running server-side |
| `node.name` after `swapComponent` | Old name kept — read `mainComponent.name` |
| Structural script found no targets | "Succeeded", did nothing — garbage remains |

## Sweep disciplines

- **Sweep everything once, not per-complaint** — one owner complaint about a cell = audit ALL cells/columns/fields in one pass.
- After clone+edit passes on shared sets: depth-first 1:1 text comparison of every live instance against the master; fix by index; re-audit to 0 mismatches (don't trust the fix report).
- After any mid-batch crash/disconnect: inventory (sweep for orphans, half-applied swaps, duplicates) BEFORE rerunning.
- After master/slot edits: usage-sweep every instance for wiped slot swaps; re-swap via 1:1 name map.
- Content-language sweeps: full diacritic+case regex; keep legitimate proper nouns.

## Reconcile at close (docs ↔ canvas)

Read-only ground-truth walk over the design-system page(s): component names, duplicate names, counts, variable totals — diff against the registry by NAME. `duplicate-name` and `count-mismatch` are must-fix before "done". Any registry id that fails to resolve by name → full sweep + refresh ids. Aggregate returns only (never the node tree — response caps).
