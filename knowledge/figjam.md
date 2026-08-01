# FigJam — stickies, connectors, shapes, tables, code blocks, board reads

`ui.figjam.*` (absorption phase-03). Gives an agent hands on a FigJam board:
stickies (single and batch), connectors, shape-with-text, sections, tables, code
blocks, layout arrangement, plus reading a board's contents and its connection
graph. Every helper's first line is `requireEditor('ui.figjam.<name>', ['figjam'])`
(`plugin/src/main/exec-stdlib-editor.ts`) — no hand-written refusal string anywhere
in this repo.

All snippets are `figma-agent exec-js` ready (async body, `ui`/`figma` globals,
`return` a JSON-safe value).

**The manifest change was the phase, not the helpers.** `plugin/manifest.json` now
declares `"editorType": ["figma", "figjam"]` (was `["figma"]` only). The boot-path
trace done before writing any helper found NOTHING in this plugin's current boot
sequence needs a FigJam-specific skip: `figma.showUI`/`figma.loadAllPagesAsync` are
editor-agnostic per `@figma/plugin-typings` (no editorType-scoped note on either, nor
on `documentAccess: "dynamic-page"` anywhere in the ~40 places the typings mention
it), and the live-sync capture path (`main.ts`'s `onDocumentChange` + gap-fill) is
**already honest-by-construction for FigJam nodes** — see below. `STATUS.bootSkipped`
therefore reports an empty list today; the field exists (present-only-when-non-empty,
same contract as `senderMismatchCount`/`legacyMigrationDeferred`) so a future editor
surface has somewhere to report a real skip without a payload shape change.

## Live-sync capture already degrades honestly in FigJam — no guard, no rewrite

Traced in code, not inferred: `resolveComponentIdentity` (main.ts) walks up looking
specifically for `COMPONENT`/`COMPONENT_SET` types, which never exist in FigJam — it
always returns `null` for a FigJam node, so the component-scoped `DOC_CHANGE` branch
is naturally inert on a FigJam board (never posts, never fabricates). The WIDENED
`EDIT_FEED` branch and gap-fill's own snapshot/diff (`edit-gapfill.ts`) both stamp
`nodeType: node.type` **verbatim** off the real node — a sticky reports
`nodeType: 'STICKY'`, a connector `'CONNECTOR'`, never a guessed design-file type.
`enclosingName`/`pageNameOf` degrade to `null` for FigJam's ancestor chain (no
`FRAME`/`COMPONENT` exists there either) the same way an already-deleted node
degrades to a null name elsewhere in this codebase. Nothing needed fixing here.

## Reverse-guard audit — which EXISTING design-only helpers need a FigJam refusal

Audited, not assumed: the bar is "would raw-throw a confusing platform error, or
fabricate/mutate wrongly" — a helper that already refuses cleanly via its own
existing type check does NOT need a new guard.

**Update — a second pass front-loaded a clean refusal ahead of the type checks
below.** "Already safe" (below) meant non-crashing, not clean: a caller in FigJam
still saw a raw `not found: X` once a bogus id failed the type check, which reads
like a bad id rather than "wrong editor". `ui.componentSet`, `ui.slot.*` (create/
list/append/reset/addProperty), `ui.setProps`, and `ui.swapInstance` now each call
`requireDesignFile(capability)` (`exec-stdlib-editor.ts`) as their FIRST line —
before any arg validation or node lookup — so the refusal names the capability, the
wrong editor, and the fix, the same shape `ui.figjam.*`'s own forward guard uses.
The type checks below are unchanged and still guard the orthogonal bug they always
did (a wrong-type node passed IN Figma itself, where the new gate is a no-op).

- **`ui.componentSet` / `ui.slot.*` — gated, on top of the existing type checks.**
  `figma.createComponent()` / `figma.combineAsVariants()` ARE documented `"Note:
  This API is only available in Figma Design"` in the typings, but every call site
  (`exec-stdlib-component-build.ts`, `exec-stdlib-slot.ts`) also checks
  `node.type !== 'COMPONENT'` on every input BEFORE reaching those APIs — since no
  FigJam node can ever be type `COMPONENT`, that check always fires, with an
  already-clear message. Both checks now run: the design-file gate first, the type
  check as a second line of defense.
- **`ui.setProps` — gated, on top of the existing type check.** Explicit
  `inst.type !== 'INSTANCE'` check still runs before any INSTANCE-only call.
- **`ui.swapInstance` — gated, on top of the general fix.** Had NO type check on
  `inst` at all — a caller passing any non-INSTANCE node hit a raw, uncoded platform
  error (`in swapComponent: node is not an instance`). This pre-dates FigJam
  (already reachable in a design file with e.g. a FRAME); FigJam just makes it far
  more likely. Fixed with the same `inst.type !== 'INSTANCE'` check `setProps`
  already had — a general fix, not an editor guard, since an editor guard alone
  would leave the same hole open for a wrong-type node in Figma itself. The new
  design-file gate is additive, not a replacement for that fix.
- **`ui.annotate.*` — deliberately left ungated.** `get`/`set` gate via
  `requireAnnotatable`'s `'annotations' in node` check first; `categories()`'s only
  call to the file-level `figma.annotations.getAnnotationCategoriesAsync()` is
  already wrapped in try/catch → clean `E_EVAL`. Checked again for the design-file
  gate specifically: `AnnotationsMixin` (per `@figma/plugin-typings`) is implemented
  by base shape/text node types (`RECTANGLE`, `TEXT`, `VECTOR`, …) that also exist
  in FigJam, and neither `AnnotationsAPI` nor `setBoundVariable`-adjacent APIs carry
  a "Figma Design only" note anywhere in the typings (unlike `createComponent`/
  `combineAsVariants`, which do). Gating this would risk refusing a legitimate FigJam
  annotation read/write — an over-gating regression, not a fix. Still `[re-verify]`
  on a live canvas either way.
- **`ui.vars.*` — deliberately left ungated, same reasoning as `ui.annotate.*`.**
  Variable CRUD operates entirely through `figma.variables.*` (document-level, not
  node-type-dependent) — no
  "wrong node type" risk applies. No editor-scoping note found in `VariablesAPI`'s
  typings either.

## `ui.figjam.*` reference

```js
return await ui.figjam.sticky('Hello', { color: 'YELLOW', x: 0, y: 0 });
// → { id, type: 'STICKY', name, x, y } — name is READ BACK, never derived from text
// (FigJam names a sticky itself).

return await ui.figjam.stickies([
  { text: 'One' }, { text: 'Two', color: 'BLUE' },
]);
// → { created, failed, results: [...], errors: [{index, error}] }
// created.length + errors.length === specs.length, ALWAYS — one bad spec never
// aborts the batch. Font loaded ONCE, reused for the whole batch (a real 200x
// saving, not a micro-optimisation).

return await ui.figjam.connector(startNodeId, endNodeId, { label: 'flows to' });
// Both endpoints resolved via getNodeByIdAsync BEFORE assignment.

return await ui.figjam.shape({ text: 'Node', shapeType: 'ROUNDED_RECTANGLE', width: 200, height: 80 });
// Resized BEFORE text is set, so the text reflows to the final size — order matters.

return await ui.figjam.section({ name: 'Group A', width: 400, height: 300 });
// resizeWithoutConstraints, not resize.

return await ui.figjam.table(3, 3, { data: [['a','b','c'],['d','e','f']] });
// → { ..., cellsWritten, dataRowsIgnored? } — extra input rows past the declared
// row count are clamped AND reported, never silently dropped.

return await ui.figjam.codeBlock('const x = 1;', { language: 'TYPESCRIPT' });
// Loads Source Code Pro Medium, falling back to Inter Medium on failure.

return await ui.figjam.arrange([id1, id2, id3], { layout: 'grid' });
// → { arranged, layout, skipped } — an id that doesn't resolve is SKIPPED and
// reported, never aborts the whole call the way the fork's "throw only when ALL
// ids fail" does.

return await ui.figjam.board({ maxNodes: 500 });
// → { nodes, totalFound, truncated, page, scope: 'page-top-level' }. TOP-LEVEL
// children only — never a deep findAll; `scope` says so explicitly. `truncated` is
// computed from whether the SOURCE list was exhausted, not `results.length >= maxNodes`
// (the fork's own bug: wrong when the board has EXACTLY maxNodes matching nodes).

return await ui.figjam.connections();
// → { edges, connectedNodes, totalConnectors, totalConnectedNodes }. An endpoint
// that cannot be resolved appears as `unresolved: true`, NEVER dropped — a dropped
// edge would silently change the graph.
```

### Sticky colour is a fill, not an enum property

The nine names (`YELLOW BLUE GREEN PINK ORANGE PURPLE RED LIGHT_GRAY GRAY`) map to a
hardcoded RGB fill (`exec-stdlib-figjam-types.ts`'s `STICKY_COLORS`) — this is the
fork's own workaround, copied and labelled as one, not presented as a first-class
API. `[re-verify]`: whether Figma now exposes a real sticky-colour property directly
has not been checked against a live canvas.

## Open questions — `[re-verify]` on a live canvas

Per the standing rule for this track: worded as unverified, not confirmed, until a
real FigJam board proves it.

- **`documentAccess: "dynamic-page"` + FigJam compatibility.** Strong evidence, not a
  live-canvas confirmation: the fork's own shipped manifest declares
  `editorType: ["figma","figjam","slides","dev"]` together with
  `documentAccess: "dynamic-page"`, and its own boot code branches on
  `figma.editorType === 'figjam'` at the very top of the file — both facts point at
  this combination being real and shipped, and the typings' ~40 `dynamic-page`
  mentions carry zero editorType qualifier anywhere. But the phase's own live run (a
  real plugin opened in a real FigJam board) has not happened from this session — no
  live canvas access. Until that run, treat this as strongly-evidenced, not proven.
- Whether the WS bridge (iframe → broker) actually connects inside a FigJam board —
  architecturally editor-agnostic (`figma.showUI`/`ui-relay.ts` never reference
  editorType), but likewise unconfirmed on a live board.
- Sticky colour API (above).
- Whether every table cell genuinely shares one default font, or only cells in the
  same row/column group do (`exec-stdlib-figjam-table.ts` hoists the load from the
  first cell touched and assumes the rest match).
- `codeLanguage` validation — passed through as a string, not validated against a
  confirmed list of accepted values; an unknown value's real behavior (silently
  ignored vs. rejected) is unconfirmed.
- Whether `ui.annotate.*`/`ui.vars.*` are genuinely available in FigJam (see the
  reverse-guard audit above) — no typings evidence either way.
