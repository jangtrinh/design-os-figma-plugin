# Build-script standard — anatomy of a correct Figma mutation script

Every mutation script follows ONE canonical shape. The shape exists because each deviation
has already caused a real incident (silent no-run, double-apply, wrong-file mutation,
orphan nodes, self-certified false-greens).

## Contract

- **One script = one intent** (one section, one sweep, one component mint). Never a whole screen in one monolith — recovery from a mid-monolith error is expensive.
- **Persisted from the start** to the project's `plans/{plan}/scripts/` with a numbered kebab name (`03-build-filter-drawer.js`) — never scratchpad-first, never inline-only. Verify PNGs → `verify-pngs/`.
- **Idempotent**: safe to run twice. The bridge can disconnect mid-request with NO rollback; a CLI timeout does NOT stop server-side execution.
- **Fail-loud**: zero try-catch that swallows mutation errors; failures throw or land in the returned `errors` array.
- **Self-reporting, never self-certifying**: the script returns structured data (layer-1 evidence), but persistence proof and the PNG verdict come from SEPARATE follow-up calls.

## The skeleton (order is law)

```js
(async () => {                                     // exec-js: IIFE, NO trailing ';'
                                                   // use_figma: NO IIFE — top-level await
// ── 1. GUARDS ────────────────────────────────────────────────
if (figma.root.name !== '<expected file>') throw new Error('WRONG FILE');

const RUN_ID = '<yymmdd-hhmm>-<slug>';
const NS = '<plugin-data namespace>';
// Idempotency guard: skip-if-done via tag or unique name — NEVER blind re-create
const page = figma.root.children.find(p => p.name === '<target page>');
await page.loadAsync();
const already = page.findOne(n => n.getSharedPluginData(NS, 'key') === '<logical-key>');
if (already) return { skipped: true, existing: already.id };

// ── 2. SETUP (once) ──────────────────────────────────────────
await figma.setCurrentPageAsync(page);             // resets every call
for (const f of FONTS) await figma.loadFontAsync(f); // fail loud
// variable/style/component lookups ONCE, by NAME (see script-helpers.md block)

// ── 3. SPEC CONSTANTS — one origin per geometry ──────────────
const COLUMNS = [ { name: 'NAME', w: 220 }, { name: 'STATUS', w: 120, flex: true } ];
// Header AND rows both generate from THIS constant. Never a second origin.

// ── 4. MUTATIONS ─────────────────────────────────────────────
const errors = [];
// Ordering laws: appendChild/reparent FIRST → resize() → layoutSizing* LAST
// Nested variant BEFORE its text; characters BEFORE range formatting
// Swap = atomic: insert-new + remove-old adjacent, same script
// Every created node: tag(node, key) + explicit position (never (0,0))

// ── 5. IN-SCRIPT ASSERTS (layer 1) ───────────────────────────
// counts, parents, exactly-1-active, no-collapse (≥ expected px), overlap pairs
// throw or push into errors — NEVER swallow

// ── 6. STRUCTURED RETURN — the agent sees ONLY this ──────────
return {
  runId: RUN_ID,
  created: [/* {id, name, key} */],
  counts: { instances: 0, texts: 0 },
  errors,                                          // empty array = actually clean
};
})()
```

## Pre-dispatch lint (run BEFORE sending any script — kills the top error families)

Grep the script text for banned patterns; any hit = fix before dispatch, no exceptions. This 5-second check would have prevented the two biggest families in the error-log harvest (21 sync-API hits + wrapper-preventable trio):

| Banned pattern | Why (all fail/rollback at runtime) |
|---|---|
| `figma.getNodeById(` · `.mainComponent` (property) · `figma.getLocalTextStyles(` / `getLocalPaintStyles(` / `getLocalEffectStyles(` without `Async` | dynamic-page: sync APIs throw — use `*Async` |
| `figma.currentPage =` · `.textStyleId =` · `.effectStyleId =` | sync setters: throw or SILENTLY no-op |
| `require(` / `import ` | sandbox has neither |
| `figma.combineAsVariants(` not via `combineVariantsSafe` | same-page throw |
| `.fontName =` / `setRangeFontName(` without a matching `loadFontAsync` | unloaded-font throw |
| bare `findOne(...)` result chained without null-guard (`mustFind`) | null-deref crash mid-batch |
| `exec-js`: file not starting `(async () => {` or ending `})();` (trailing `;`) | silent no-report / silent no-run |
| missing `figma.root.name` guard | wrong-file mutation |
| `try {` around a mutation without rethrow/collect | swallowed failure |

## After the script returns (mandatory follow-ups — separate calls)

1. **Structural ops** (create/combine/reparent) → verify in a **COMPLETELY NEW call**: node exists, `parent` correct, SET child count + variant names. Same-call re-fetch has lied twice.
2. **Fresh PNG, read by eye** — the arbiter. 1 PNG + 1 assert pass per batch (SLA 1–3 min/screen).
3. On timeout/disconnect/error: **inventory first** (sweep for orphans, half-applied swaps, duplicates by tag/name), rerun second.

## Prefer safe wrappers over raw API calls

The top recurring runtime errors (same-page combineAsVariants, unloaded font, FILL outside auto-layout) each have a wrapper in [script-helpers.md](script-helpers.md) (`combineVariantsSafe`, `setFont`, `sizing`) that makes the error impossible by construction. A script calling the raw API where a wrapper exists must justify it. New recurring runtime errors → harvest into new wrappers per [quality-gate-system.md](quality-gate-system.md) §Error-harvest loop.

## Batching rules

- Batch a section's mutations into ONE script (SLA); split a screen into sequential section-scripts.
- Single-pass sweeps: one `findAll`/`findAllWithCriteria` + iterate — never nested per-node findAll (5–7s each, timeouts).
- Long batches: check bridge status ×2 (~15s apart) before starting; between error batches, return to inventory.
- Data capture (dump-to-JSON of overrides/texts) is its OWN read-only script BEFORE the mutation script that destroys them.

## Anti-patterns (each caused a real incident)

| Anti-pattern | Consequence already paid |
|---|---|
| Whole-screen monolith script | expensive mid-build recovery |
| Blind retry after error/timeout | double-apply, duplicated blocks |
| try-catch around sizing/props | 100px-clip shipped, wrong diagnosis chain |
| Hardcoded node ids across calls | dead ids, wrong-node writes |
| `findOne` by bare name | silent wrong-node write (node-read stays green) |
| Same-call verify of structural op | "verified" node that never persisted |
| Skipping the file guard | mutation landed in the WRONG FILE |
| No idempotency guard | reruns created doubled sections |
| Unstructured return (`'done'`) | agent blind to what actually happened |
| Verify by script report alone | 4× only the PNG exposed the defect |

Cross-references: helper functions + ordering laws → [script-helpers.md](script-helpers.md) · verify layers → [verification-protocol.md](verification-protocol.md) · API traps the skeleton guards against → [plugin-api-gotchas.md](plugin-api-gotchas.md).
