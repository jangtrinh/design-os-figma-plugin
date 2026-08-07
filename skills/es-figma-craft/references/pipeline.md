# The build pipeline — phase detail

Five phases plus preflight. Do them in order; don't skip RECON because the screen "looks simple".

## Phase 0 — PREFLIGHT (every session)

- [ ] Project adapter loaded (file name+key, pages, tokens, fonts, registry path, conventions). No adapter → create from [project-adapter-template.md](project-adapter-template.md) first.
- [ ] Bridge alive and pointed at the RIGHT file: `figma-agent status` shows `plugin.connected:true` + correct file, checked **2× ~15s apart** before long batches (connections flap). MCP path: `figma-use` skill loaded.
- [ ] Component registry / inventory read — reuse-or-create is a lookup, not a memory test.
- [ ] If the file carries machine-readable markers (AI manifest, `status` plugin-data: `canonical`/`deprecated`/`legacy-unstandardized`), read them before cloning ANY design-system node.
- [ ] If the user says they changed the file → reconcile FIRST via [knowledge-sync.md](knowledge-sync.md).
- [ ] Every mutation script opens with the file guard: `if (figma.root.name !== '<expected>') throw new Error('wrong file')`.
- [ ] Persist all scripts to the project's `plans/{plan}/scripts/` from the start (never scratchpad-first); verification PNGs to `verify-pngs/`.

## Phase 1 — RECON

Read the source/target cheapest-first: `get_metadata` (structure) → `get_screenshot` (visual intent, maxDimension ~1440) → `get_design_context` (exact values, LAST resort — 25K-token response cap; on overflow pivot to screenshot + a programmatic `{id, name, type}` walk).

Then build the **mapping table BEFORE writing any code**:

| Visible element | Library equivalent? | Decision |
|---|---|---|
| Status pill | `Badge Tone=ok` | Reuse |
| Stat tile | `MetricCard` lacks trend slot | Enhance (add BOOLEAN) |
| 4× repeated row | none | NEW composite (3+ rule) |
| Brand row | shell chrome, 1× | Inline |

List: (1) enhancements needed, (2) new composites, (3) inline pieces. 30 sec of planning saves 5 min of retries.

**Study references via DOM/metadata, not PNG** — a PNG can never tell you the owner already componentized something; the node tree can.

## Phase 2 — ENHANCE

Close component gaps by the creation ladder (see [component-system.md](component-system.md)). Hard points:

- **Shared-master or component-set changes require OWNER APPROVAL of the build plan first.** Small fixes inside an approved scope don't.
- Pre-flight `deleteComponentProperty` cleanup of stuck props before any `addComponentProperty` batch (partial failures leave stuck state).
- Normalize construction BEFORE `createComponentFromNode` (normalize-first gate in component-system.md).
- Tag every new node with plugin-data (`run_id`, logical `key`).

## Phase 3 — BUILD

- **One section per call** (sidebar → top bar → header → main card → …). Errors scope to a section; recovery from a mid-build monolith is expensive.
- Each call: load fonts first → look up components/variables/styles ONCE → build → **return structured data** (ids, counts, errors array — the agent sees only what you `return`).
- Scripts **idempotent** (guard skip-if-done): the bridge can disconnect mid-request without rollback. After any mid-batch break: **inventory first, rerun second.**
- Swap operations are atomic transactions: insert-new and remove-old adjacent in the SAME script.
- Position every new top-level node explicitly — never let it default to (0,0); anchor next to a named sibling. When placing into a SECTION, compute real maxY / find free space, then **pairwise-bbox overlap assert** against all children; sections don't auto-grow. Re-read x/y in a FRESH call before reporting "placed at X" (Figma may nudge on append).
- Full screens: assemble via the project's shell-template + page-content slot architecture if it exists (component-system.md) — never re-assemble chrome per screen.

## Phase 4 — VERIFY

Three layers, in order — full protocol in [verification-protocol.md](verification-protocol.md):

1. **Node-read asserts** (structure, props, counts) — in a **FRESH call** for any structural op.
2. **Numeric geometry asserts** (drift ≤0.5px, no overlap, no collapse).
3. **FRESH PNG read by eye** — the final arbiter. Four separate incidents were caught ONLY by the PNG after all numeric asserts passed.

## Phase 5 — CLOSE

- Reconcile the registry/docs scoped to what this build touched (read-only ground-truth walk; `duplicate-name` and `count-mismatch` are must-fix before declaring done). Any id that fails to resolve by name → full sweep.
- Registry rows for new components added **in the same change**.
- 1-line summary: components reused (count + names), new composites, registry rows touched, call count. No per-screen report files unless asked.
- Distill **at most one** durable lesson → project patterns/gotchas file or memory; wrong-tool frictions → the tool's improvement backlog (backlog ≠ patterns: "tool must fix" vs "how to avoid").

## Call budget

- Simple screen: 1–3 calls + 1 fetch · medium: 2–4 · complex: 4–6 (sectioned). Target ~5–15% of the daily cap per screen.
- Screen-build SLA once patterns are established: **1–3 minutes per screen** — batch mutations into one script, verify with 1 PNG + 1 assert pass. Heavy ceremony is for first-time patterns only.

## What NOT to do

- Don't build a whole screen in one call. Don't fetch the same node twice — cache what you need.
- Don't code straight from fetched markup without the mapping table.
- Don't fan out parallel agents against the file (law 11).
- Don't create per-screen markdown reports unless asked.
