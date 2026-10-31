# Plugin-API gotchas — 6 classes of failure modes

Every entry: real incident → symptom → fix. Written for `exec-js` (design:os figma-agent) and `use_figma` (MCP) alike; wrapper rules differ per bridge and are marked.

## Class A — Script execution: scripts that silently don't run (or silently do)

- **`use_figma`: NO outer async IIFE.** The harness auto-wraps; double-wrapping surfaces fake errors pinned to a fixed harness line. Write top-level `await` + `return`.
- **figma-agent `exec-js`: IIFE wrapper is MANDATORY, trailing `;` is FORBIDDEN.** Script starting with top-level `const` → `result: null` but side effects APPLIED (ran invisibly, large ms). Script ending `})();` → `result: null`, `ms≈0`, ran NOTHING, no error. Correct form: `(async () => { … })()` with no trailing semicolon. Diagnostic: `null + ms≈0` = never ran; `null + large ms` = ran blind.
- **Pass the script/file as POSITIONAL arg** where the CLI expects it — a wrong flag can leave the CLI hanging on stdin (fake timeout, 0 mutations).
- **Always `await` every async API** (`loadFontAsync`, `setCurrentPageAsync`, `importVariableByKeyAsync`…). Unawaited promises complete after the script returns — half-applied changes.
- **`figma.currentPage` resets to the first page on every call.** `await figma.setCurrentPageAsync(page)` at the top of any script touching a non-default page (sync setter throws). `await page.loadAsync()` loads children WITHOUT changing focus — use it to avoid stale-active-node harness failures.
- **Fonts load BEFORE any text mutation** — `characters`, `setRangeFontName` fail or silently no-op on unloaded fonts.

## Class B — Transaction & persistence

- **A "failed" call may have mutated the file.** Errors can be thrown in a post-execution harness step AFTER mutations committed. Read-only check BEFORE retrying; if the mutation landed, fix-forward, don't re-run.
- **CLI timeout ≠ script stopped.** The plugin keeps executing to completion after the CLI gives up. Retry-without-re-read = double-apply. Re-read state after every timeout; prefer polling a job id if the tool offers one.
- **🚨 Structural ops (createComponentFromNode / combineAsVariants / cross-page reparent) in one script may NOT persist — even when a same-call re-fetch reports success.** Proven twice: node vanished after a "verified" build; a master silently never joined its variant SET (set had 1 variant, orphan component renamed `…/Default` outside the section) while live instances kept rendering fine. Fix: (a) verify with a COMPLETELY NEW call; (b) for combineAsVariants verify the SET's child count + each variant name, not one node's parent; (c) after any such incident, sweep-by-name for orphan/duplicate FRAME/COMPONENT byproducts.
- **No automatic rollback on disconnect.** Undo-grouping only rolls back on a thrown error, not a dropped connection. Scripts idempotent; inventory before rerun.
- **`.remove()` proof = full page-tree walk.** Same-session bridge still resolves the dead id; `.removed` reads `false`; only `parent: null` hints. Never certify deletion from those two signals.
- **One giant undo step per session** unless the tooling calls `commitUndo()` — warn the owner that Cmd+Z may revert everything.
- **`createComponentFromNode` can reparent the new component to the ROOT page** — always assert `comp.parent === <target section>` and re-append if wrong.
- **`combineAsVariants` requires variants on the SAME page as the parent** — `appendChild` each variant into the target container BEFORE combining.

## Class C — Identity & location

- **Node ids are NOT stable across calls** — files renumber on sync/version-save, and ids returned mid-restructure can be remapped on commit. Resolve by NAME traversal or your plugin-data tag; a cached id is safe only for the immediately-next call.
- **`findOne` by bare name = silent wrong-node writes.** Document-order traversal hits a same-named node in another branch — and node-reads still report clean. Target by **parent chain**; if you must use a name, assert the parent path before writing. Prefer `type` + `name` at minimum.
- **`clone()` can land on the wrong page / wrong parent** (whatever page is current) — hours of build silently dropped on commit. Immediately `targetPage.appendChild(clone)` before anything else; verify membership at the end.
- **Newly-created node's returned id can be transient and the node mis-parented** despite `appendChild` "working" — re-locate by name/unique text/tag in a follow-up read; check `parent.id` and `absoluteBoundingBox`.
- **Explicit x/y set after appending into a SECTION may not stick** (Figma nudges to avoid overlap) — re-read coordinates in a fresh call before reporting placement.
- **Race with the owner's live edits:** a node read seconds ago can be gone (`getNodeByIdAsync` → null). Re-find by structural path; treat null as "re-anchor", not "retry harder".
- **Page-list metadata can be stale/wrong** (MCP `get_metadata` without nodeId returned wrong page lists twice). Ground truth for file structure = a programmatic `figma.root.children` walk; never run gap-analysis from a page listing.

## Class D — Components, variants, overrides

- **`resetOverrides()` reverts EVERYTHING including `swapComponent`** — a swapped slot reverts to placeholder; the follow-up `setProperties` throws "variant prop not found" (mis-read as a variant bug); catch-and-retry yields a silently blank artboard. Don't call it on swapped slots; flip state via `slot.swapComponent(<variant COMPONENT from the set by name>)` in one shot. Also: `resetOverrides()` on an instance created before the master gained variants → empty componentProperties; delete + re-clone canonical instead.
- **Cloning a variant strips set-level `componentPropertyReferences`** — instances set props without error but render master defaults. After cloning a variant into a set, parallel-walk original ↔ clone and rebind every ref (`node.componentPropertyReferences = {characters: '<full key>'}`), then verify ONE real instance renders an overridden value.
- **Property keys carry a `#nodeId` suffix** — `setProperties({'Label': …})` silently no-ops. Always prefix-match: `Object.keys(props).find(k => k.split('#')[0] === name)`. `combineAsVariants` REASSIGNS these suffixes (existing instance overrides auto-remap) — re-look-up keys after combining, never hardcode.
- **Variant values are case-sensitive** — never guess `Active` vs `active`; query `componentPropertyDefinitions` first.
- **INSTANCE_SWAP:** defaults reject LOCAL component keys (published-library keys only) — use BOOLEAN visibility + raw instance child as the workaround. `setProperties` accepts a **node id** for INSTANCE_SWAP (key rejected). When in doubt, `swapComponent` directly.
- **`swapComponent` keeps the OLD instance name** — verify via `mainComponent.name` (async getter), never `node.name`.
- **Replacing a node inside a shared master resets that node's overrides in EVERY instance.** Protocol: sweep file-wide usages (skip mirrors inside instances), capture each usage's overrides, swap in the master, re-apply captured overrides per usage.
- **Editing/swapping SLOT content in a master wipes instances' own slot swaps** (screens render blank placeholder). After ANY master/slot edit: usage-sweep all instances + re-swap by a 1:1 name map. But **prop-set on a nested instance of a master is safe** (verified 0 drift) — distinguish the two.
- **A COMPONENT_SET's frame doesn't auto-grow** when a variant is resized post-hoc (`layoutMode='NONE'`, `clipsContent:true`) — explicitly `set.resize(...)` after resizing variants, then re-screenshot the SET.
- **Don't add a new property axis to a shared variant SET in use** — existing variants lack values for the new property → set errors + auto-rollback. Mint a SEPARATE per-context set (clone nearest variant for chrome, combine independently).
- **A shared TEXT prop syncs `textDecoration` across all bound nodes, not just the string** — put decoration in a text STYLE (per-node, survives sync). `characters =` resets range formatting (set ranges AFTER); `resetOverrides()` does NOT clear stuck decoration (recreate the instance).
- **propRefs cannot be set on sublayers INSIDE a nested instance** — silent no-op; parallel-walk restores must STOP at instance boundaries.
- **Instance children are structurally immutable** — no `.remove()`, no `appendChild` (some shells reject appends). Use `.visible=false`, variant swap, or a wrapper frame outside the instance for overlays.
- **Cloning the SAME source TEXT node ≥2× in one pass, then editing each clone, can corrupt an UNRELATED node's overrides on live instances** (override-identity lineage leak — even the original's overrides across all instances). For the 2nd+ derived text: `figma.createText()` + copy font/size/spacing/fills manually. After any clone+edit pass on a shared set: depth-first compare EVERY text node 1:1 against the master across all live instances.
- **Set a nested badge/chip's VARIANT before its text** — `setProperties({Tone})` can reset text overrides; text set after survives.
- **`combineAsVariants` doesn't grid variants** — they stack at (0,0) and `clipsContent` hides it until the PNG. Grid + resize the set explicitly.

## Class E — Layout & sizing

- **Instances default to HUG width** — `resize()` alone silently doesn't stick (re-hugs to content). Set the mode explicitly: `layoutSizingHorizontal='FIXED'` then resize, or `'FILL'`.
- **Order is law: appendChild/reparent FIRST → `resize()` → `layoutSizing*` LAST.** Sizing props set before reparenting into an auto-layout parent are silently swallowed (property reads back correct, actually reverted → 1px collapse). `resize()` also silently forces FIXED, overwriting a previously-set AUTO/HUG.
- **`figma.createFrame()` defaults to 100×100 FIXED + clipsContent** — every API-created frame must set `layoutMode` + explicit sizing or it squeezes and clips children. Never wrap sizing failures in try-catch.
- **A master's `maxWidth` silently reverts instance resizes** — clear maxWidth on the instance first, then resize.
- **Widening a cell doesn't widen its inner TEXT** — the text keeps its own box and wraps. Short single-value cells: `textAutoResize='WIDTH_AND_HEIGHT'`; wrapping cells: `layoutAlign='STRETCH'` + `textAutoResize='HEIGHT'`.
- **Hidden-label components can hold their full FIXED width** (a 320px switch drawing 36px = 284px of invisible layout-pushing space). Sweep for `width > drawn && label hidden`.
- **`resizeWithoutConstraints` on a non-auto-layout COMPONENT_SET SCALES its children** — never use it to normalize a set's box.
- **Growing a fixed-height screen:** adding content to a full-screen frame with stretched columns clips — resize the screen AND every full-height column, keep `layoutAlign='STRETCH'`.
- **Content overflow ≠ screen size:** a screenshot's bounding box includes overflow; measure screens via node reads, not exported-image heights.

## Class F — Rendering & silent binding failures ("false green")

- **Sync setters that silently no-op under `documentAccess: dynamic-page`:** `node.textStyleId = …` (whole type hierarchy silently falls to defaults — always `await setTextStyleIdAsync`; same for `setEffectStyleIdAsync`), `instance.mainComponent` (use `getMainComponentAsync`; a usage sweep that ignores this measures NOTHING and reports 0 — assert `resolvedOk > 0`).
- **`setBoundVariableForPaint(paint, 'color', undefined)` does NOT throw** — bind silently skipped. Use a fail-loud helper: assert the variable exists before, assert `boundVariables.color` after.
- **🚨 LITERAL DRIFT:** Figma stores a literal color ALONGSIDE the binding and **the renderer uses the literal** — a correctly-bound paint can render the wrong color; "0 raw hex" lints are completely blind to it. After every set/clone of a bound paint: assert `literal === resolved(variable)`. Blast radius = masters + clone/detach lineage (instances re-resolve from the binding — fix at the master, don't panic-sweep instances).
- **Icon slots on fresh instances often default `visible=false`** — after `setProperties({Has icon: true})` + `swapComponent(icon)` the icon still doesn't render. Always `iconSlot.visible = true` + PNG-confirm. (Hit 4× in one day.)
- **Stroke-based icon sets (e.g. Lucide) recolor via `strokes` ONLY** — setting `fills` turns outlines into filled blobs. `findAll(VECTOR)` (multi-subpath icons), set strokes on each. Instance-level vector recolor is a legitimate per-instance override (master untouched).
- **Dead propRefs at render level:** a TEXT prop can accept the value while the rendered text never changes. Detect only via PNG/characters read; hotfix = set `characters` directly; root fix = rebind at the master.
- **Component-level TEXT props hold ONE default across all variants** (per-variant sample text is lost when binding) — expect it, don't fight it.
- **Screenshot bounds include effect bleed** (shadows extend offset+radius past the box) — confirm layout boxes via metadata before "fixing" a phantom gap.
- **Sub-pixel rendering eats glyphs at scale <1** (`~` → `-`). Critical text is verified from node `characters`, never from an exported image.
- **Language/copy sweeps need the FULL regex including UPPERCASE diacritics** — ALL-CAPS Vietnamese headers passed lowercase-only regexes for weeks. Generalize: any content-audit regex must cover the full case/diacritic space of the target language.
- **Non-current-page findAll is slow (5–7s) and can time out** — single-pass sweeps, `findAllWithCriteria`, or an indexed scan; never nested per-node findAll loops.

## Class G — Added 2026-09-03 (VSF-PCP MCP Gateway / LLM Routing / IAM Agent tools campaign)

- **`combineAsVariants` halves FILL-sized variants** — a frame with `layoutSizingHorizontal='FILL'` becomes a FILL child of the new set's auto-layout and shrinks to 1/N. Pin `FIXED` + explicit width on every variant BEFORE combining; inputs must already be COMPONENTs (`createComponentFromNode` first).
- **`resetOverrides()` on a table cell / KeyValue also resets sizing to the master's** (FILL → master width) — re-apply `layoutSizingHorizontal='FILL'` after every reset; and cells lifted from a donor screen usually carry typography overrides you cannot see in a PNG (text 20h vs 17h) — reset all cells of a lifted table, then re-set props.
- **`swapComponent` on a Button's icon slot drops the master's stroke paint** — the swapped icon renders in the icon master's own colour (a pink Plus on a red primary button). Capture the vector `strokes` of the SAME Button variant's master icon and reassign after the swap. Ghost/compact variants name the slot after the icon (`Icon / Plus`), not `Leading icon`.
- **Popovers inside a component are painted over by later siblings and clipped by any ancestor `clipsContent`** (Body/slot inside a shell instance you cannot change) — dropdown/popover demos live on the ARTBOARD WRAPPER (like dialogs/scrims), anchored via `absoluteBoundingBox` of the trigger.
- **`findOne(n => n.type==='TEXT')` is depth-first and can return a nested slot's text before the node's own** — locate by `children.find` / exact path when a cell has a swapped slot.
- **Owner-edit feed attribution is per-plugin-session**: with two agent sessions on one file, the other session's mutations show up as `actor:owner`. Trust only entries whose `changedProps` are human-shaped (move/opacity/fills/resize of notes) and cross-check against your own script timestamps.
- **Broker idle flap**: the first CLI call after ~1–2 min idle can fail with a "disconnected mutation" error while the plugin is fine; parallel CLI invocations restart the broker. One call at a time, `status --wait` before each batch.
