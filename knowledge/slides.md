# Figma Slides — deck-level hands

`ui.slides.*` (absorption phase-04 — the last phase of the capability-absorption
track). Gives an agent hands on a Slides deck: list/read the grid, create/delete/
duplicate/reorder slides, read+write transitions, switch view mode, focus/skip a
slide, set a background, and add text/shapes to a slide. Every helper's first line
is `requireEditor('ui.slides.<name>', ['slides'])` (`plugin/src/main/exec-stdlib-
editor.ts`) — no hand-written refusal string anywhere in this repo.

All snippets are `figma-agent exec-js` ready (async body, `ui`/`figma` globals,
`return` a JSON-safe value).

**The manifest change is the phase, same as FigJam.** `plugin/manifest.json` now
declares `"editorType": ["figma", "figjam", "slides"]`.

## Navigation is NOT undoable — read this before scripting a multi-slide build

`figma.viewport.slidesView` and `currentPage.focusedSlide` are not revertible by
`⌘Z` — the same class of exclusion `AUDIT_DS`'s page navigation already has from
`MUTATING_COMMANDS` (page navigation is not undoable, so a commit would do nothing;
`shared/mutating-commands.ts`). `ui.slides.viewMode`/`ui.slides.focus` are queued as
mutating (they change what the user sees) but their SIDE EFFECT is not covered by
`--undo-group`. **A script that navigates and then throws leaves the user looking at
a different slide** — `rolledBack: true` in an `exec-js` reply covers CONTENT only,
never the view. This is the single most likely place a caller over-claims a clean
rollback; the recipe says so here so nobody has to learn it live.

## Boot-path trace — nothing needed a Slides-specific skip

Traced in code, not inferred, mirroring the phase-03 (FigJam) trace: `writeSnapshot`/
`snapshotPage` (`edit-gapfill.ts`) uses `page.findAll(() => true)` — generic,
editor-agnostic, descends into a Slides file's real hierarchy (`PageNode` →
`SLIDE_GRID` (non-selectable) → `SLIDE_ROW` children → `SLIDE` children → the
slide's own real design content) the same as any other node tree. `node.type` is
stamped **verbatim** into the snapshot record — real values (`'SLIDE_GRID'`,
`'SLIDE'`, `'TEXT'`…), never guessed. `resolveComponentIdentity` (main.ts) walks up
for `COMPONENT`/`COMPONENT_SET`, which never exist in a Slides deck (component
creation is Figma-Design-only) — naturally `null`, same honest-by-construction shape
as FigJam. `enclosingName`/`pageNameOf` degrade the same way through the
`SLIDE`→`SLIDE_ROW`→`SLIDE_GRID`→`PAGE` chain. `figma.loadAllPagesAsync()` carries no
editor-type scoping in the typings or docs, same as FigJam.

**One genuinely NEW case** (did not occur in FigJam): `SLIDE_GRID`/`SLIDE_ROW` are
structural containers with no `x`/`y`/`width`/`height` in their documented property
list (unlike `SlideNode` itself, which has them via `LayoutMixin`). The EXISTING
`'x' in node && 'y' in node` guard in `snapshotPage` already handles this exactly as
designed — defaults to 0, no crash, no fabrication. Nothing needed fixing; this is
precisely the class of case that guard was written for.

`STATUS.bootSkipped` stays empty for this phase too — the mechanism (present-only-
when-non-empty, same contract as `senderMismatchCount`/`legacyMigrationDeferred`)
now has two editor traces behind it finding nothing to skip.

## Reverse-guard audit — generalizes cleanly from FigJam, not a fresh audit

The bar: a helper needs a Slides refusal if it would raw-throw a confusing platform
error or fabricate/mutate wrongly in a Slides deck; one that already refuses cleanly
via its own type check does not need a new guard.

- **`ui.componentSet` / `ui.slot.*` / `ui.setProps` / `ui.swapInstance` — already
  safe, same reasoning as FigJam.** No `SLIDE` node is ever type `COMPONENT` or
  `INSTANCE`, so the existing type-checks (not editor-specific, just type-specific)
  fire first regardless of which non-design editor is open.
- **`ui.annotate.*` / `ui.vars.*` — `[re-verify]`, checked fresh for Slides, not
  assumed identical to FigJam.** Searched official docs and typings-adjacent sources
  specifically for Slides + annotations/variables availability — found nothing
  confirming or denying either way. Same unverified status as FigJam; do not assert
  availability that was not confirmed.

## `ui.slides.*` reference

```js
return await ui.slides.list();
// → { slides: [{id,name,row,col,isSkippedSlide,childCount}], totalSlides, totalRows }
// Fact 1: figma.getSlideGrid() returns rows that are ARRAY-LIKE — iterated by
// numeric index, never `.children` (the fork's own comment says so twice, having
// gotten it wrong once).

return await ui.slides.grid();
// → { grid: [{rowIndex, slides:[{id,name,col,isSkippedSlide}]}], totalRows }

return await ui.slides.create({ row: 1, col: 0 });
// → { id, name }. With no args, appends to the last row (a first row is created if
// the deck is empty). [re-verify]: what happens when row/col collide with an
// existing slide — the fork's own code does not say.

return await ui.slides.remove(slideId);
// → { deleted: id, name }. Fact 3: type asserted AFTER getNodeByIdAsync — ids go
// stale across sessions, never trust the caller's own claim of what an id names.

return await ui.slides.duplicate(slideId);
// → { originalId, newId, name }. Uses .clone() — the full SlideNode property list
// pulled directly from developers.figma.com/docs/plugins/api/SlideNode/ shows only
// `clone(): SlideNode`, no distinct `duplicate()`. [re-verify]: a real duplicate()
// may exist in the live typings with different semantics (deep vs shallow,
// transition-preserving) — a follow-up issue if so, not a blocker here.

return await ui.slides.reorder([[slideA, slideB], [slideC]]);
// → { rows, grid: [[ids]] } — read back off getSlideGrid(), never the input.
// Fact 2 + THIS REPO'S OWN ADDITION: the fork's setSlideGrid accepts a grid missing
// slides, silently reorganising the deck — this refuses a grid that drops OR
// duplicates a slide, naming the missing/duplicated ids.

return await ui.slides.setTransition(slideId, { style: 'DISSOLVE', duration: 0.5, curve: 'EASE_IN' });
// → { id, transition } — read back via getSlideTransition(). Fact 5: style/curve/
// timing validated against a closed vocabulary BEFORE calling setSlideTransition —
// an invented value Figma might silently ignore is exactly what this catches.
// timing defaults to {type:'ON_CLICK'}.

return await ui.slides.transition(slideId);
// → { id, transition }

return await ui.slides.viewMode('single-slide');
// → { mode } — read back, never echoed.

return await ui.slides.focused();
// → { id, name } | { focused: null } — fact 7: null is reported, never the first
// slide invented.

return await ui.slides.focus(slideId);
// → { focused: id, name, viewMode: 'single-slide' } — fact 6: view mode is set
// BEFORE focusedSlide is assigned (preserved from the fork's own ordering); the
// reply names the viewMode it caused, since that side effect is NOT undoable.

return await ui.slides.skip(slideId, true);
// → { id, isSkippedSlide } — fact 4: a plain assignable boolean.

return await ui.slides.background(slideId, '#101010');
// → { slideId, color, updated, method: 'slide-fill' }. REWRITTEN, not ported —
// see below.

return await ui.slides.addText(slideId, { text: 'Hello', fontFamily: 'Inter', fontStyle: 'Semi Bold' });
// → { id, characters }. Fact 10: font loaded BEFORE characters is assigned;
// textAutoResize:'HEIGHT' accompanies an explicit width. Falls back to Inter Medium
// on a font-load failure, same fallback-and-record pattern as FigJam.

return await ui.slides.addShape(slideId, { shapeType: 'ELLIPSE', color: '#3355ff' });
// → { id, type }. Fact 11: RECTANGLE/ELLIPSE only (the fork's own narrow set) — a
// caller wanting more writes raw Plugin API in the same script.

return await ui.slides.content(slideId, { depth: 5 });
// → our serializeNode's shape (id/name/type/x/y/width/height/children), not the
// fork's ad-hoc 7-field local one with no cycle guard (fact 12).
```

### The single-slide-view default-parenting trap (`addText`/`addShape`)

**First-class correctness finding, confirmed against official Figma docs, not a
footnote:** in single-slide view, Figma's own create methods
(`figma.createText()`/`createRectangle()`/`createEllipse()`) append the new node to
the FOCUSED slide by default, not wherever the caller intends. Trusting default
parenting would silently misattribute content to the wrong slide — exactly the
silent-misattribution class this whole absorption track exists to close. Every
create-into-slide helper here explicitly `targetSlide.appendChild(node)` after
creation, REGARDLESS of view mode, and verifies the node's parent is the intended
slide before returning — a mismatch throws honestly rather than reporting success on
the wrong slide.

### Background — REWRITTEN, not ported

The fork creates or updates a hardcoded-1920×1080 `RECTANGLE` named `'Background'`,
inserted at index 0 (`code.js:7060-7083`) — a workaround for an API that did not
exist when it was written. This phase's re-anchor (checked directly against
developers.figma.com/docs/plugins/api/SlideNode/, not assumed) found `SlideNode`
itself carries `fills`/`fillStyleId`/`setFillsAsync` via `GeometryMixin`, the same as
any other geometry node — a REAL background API exists now. `ui.slides.background`
uses it directly: no rectangle, no hardcoded size, no redundant
`appendChild`+`insertChild(0,…)`. `method: 'slide-fill'` names it so no caller
believes a `Background` rectangle now exists on the slide. `updated` reports whether
the slide already carried a fill before this call.

### `createSlide`'s real signature differs from the fork's own call shape

The fork calls `figma.createSlide({ row: msg.row, col: msg.col })` (an options
object) — but the current `@figma/plugin-typings` (verified by `tsc` itself
rejecting the object-shaped call during this phase's implementation) takes
`createSlide(row?: number, col?: number)` as two POSITIONAL arguments. JS never
type-checked the fork's own call, so this drifted silently there; this repo's
compiler caught it immediately. A small, concrete instance of "count before you
target" — the typings are the ground truth, not a fork's runtime-untyped call.

## Open questions — `[re-verify]` on a live canvas

Per the standing rule for this track: worded as unverified, not confirmed, until a
real Slides deck proves it.

- **`documentAccess: "dynamic-page"` + Slides compatibility.** Same evidence class as
  FigJam: the fork's own shipped manifest declares
  `editorType: ["figma","figjam","slides","dev"]` together with
  `documentAccess: "dynamic-page"` — strong evidence, not a live-canvas confirmation.
- `duplicate()`'s use of `.clone()` vs a possible distinct `duplicate()` method (above).
- `create({row, col})` colliding with an existing slide at that position — unspecified
  by the fork.
- Whether `ui.annotate.*`/`ui.vars.*` are genuinely available in a Slides deck (see
  the reverse-guard audit above) — no typings or docs evidence either way.
- The transition `style`/`curve` enums were cross-checked against TWO sources (the
  fork's own zod enum, `slides-tools.ts:19-56`, and developers.figma.com's
  `SlideTransition` page, fetched twice — a first, looser summary of a different
  overview page suggested a curve value, `"EASE_IN_AND_OUT_BACK"`, that a second,
  targeted fetch of the actual `SlideTransition` type page did NOT contain). The two
  authoritative sources (fork + targeted docs fetch) agree exactly, 23 style values
  and 8 curve values, nothing to flag — but the discrepancy in the FIRST, looser
  fetch is recorded here as a caution: a summarized web fetch of an overview page is
  not the same confidence level as a targeted fetch of the exact type's own page.
- The manifest `editorType` widening + design-file/FigJam regression check stay
  OWNER-MANUAL live verification (see the PR's live-canvas checklist).
