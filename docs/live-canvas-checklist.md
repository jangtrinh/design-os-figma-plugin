# Live-canvas verification checklist (owner-manual)

The one verification layer CI cannot reach: everything below needs a real Figma Desktop with
the plugin loaded, because it either drives the canvas or opens an editor (FigJam / Slides) a
headless test can't. Consolidated across absorption phases #10/#13/#26/#28 so it runs in a
single connected session instead of four scattered PR bodies.

## Setup (once)

1. In Figma Desktop → Plugins → Development → **re-import** the manifest from
   `/Users/jang/Products/design-os-figma-plugin/plugin/manifest.json` (the plugin moved out of
   the monorepo; the old dev entry points at the deleted path).
2. Confirm the panel opens and reads **"design:os by JANG"**, status shows **Connected**.
3. `figma-agent status` from a terminal → `plugin.editorType: "figma"`, no errors.

## A. Design file (regression — MUST be unchanged)

The absorption phases widened `editorType` to `["figma","figjam","slides"]`. This section proves
the existing design-file path is byte-unaffected — the one real risk of the manifest change.

- [ ] Open a normal **Figma Design** file. Panel connects, `editorType: "figma"`.
- [ ] Run a known-good command (e.g. `ui figma reconcile --apply` on a bound file, or a small
      `figma-agent exec-js` that reads a node) — behaves exactly as before the phases.
- [ ] `ui.componentSet(...)` / `ui.slot.*` still work in a design file (the reverse guard must
      NOT wrongly refuse here).
- [ ] `ui.figjam.*` and `ui.slides.*` REFUSE in the design file with an actionable message
      naming the editor they need (forward guard fires).
- [ ] Gap-fill / sync still capture design-file edits normally (no regression from the widen).

## B. FigJam (new surface — phase-03)

- [ ] Open a **FigJam** board. Panel connects, `figma-agent status` → `editorType: "figjam"`.
- [ ] `ui.figjam.sticky(...)` creates a sticky; `ui.figjam.connector(...)`, `.shape`, `.table`,
      `.codeBlock`, `.section` each create their node; reply names what was made (no fabrication).
- [ ] `ui.figjam.board()` reads the board; `ui.figjam.connections()` lists edges — an unresolved
      endpoint shows `unresolved: true`, never a dropped edge.
- [ ] `ui.figjam.arrange(...)` with one bad id → the bad id lands in `skipped[]`, the rest arrange.
- [ ] A design-only command (`ui.componentSet`, `ui.slot.*`) REFUSES in FigJam, naming the editor.
- [ ] Make a manual edit (move a sticky) → it appears in the change feed with `nodeType: "STICKY"`
      verbatim (honest-by-construction — never a fabricated design-file fact).

## C. Slides (new surface — phase-04)

- [ ] Open a **Figma Slides** deck. Panel connects, `editorType: "slides"`.
- [ ] `ui.slides.list()` / `.grid()` / `.content(slideId)` read the deck honestly.
- [ ] `ui.slides.background(slideId, color)` sets the slide fill directly (no rectangle appears on
      the slide — it uses `setFillsAsync`, method `slide-fill`).
- [ ] **The single-slide-view trap** (the load-bearing correctness test): switch to single-slide
      view, focus slide X, then `ui.slides.addText(targetSlide=Y, ...)` → the text lands on **Y**,
      NOT the focused slide X. (This is the silent-misattribution guard; if it lands on X, that's a
      real bug to report.)
- [ ] `ui.slides.reorder(...)` with a grid that drops or duplicates a slide → REFUSES, naming the
      missing/duplicate id (never silently drops a slide).
- [ ] `ui.slides.setTransition(...)` applies; `ui.slides.transition(slideId)` reads it back.
- [ ] **Undo honesty**: run an exec-js that navigates (`ui.slides.focus`/`viewMode`) then throws →
      `rolledBack: true` covers the CONTENT, but you are left on a different slide (navigation is
      not undoable — this is documented, verify the message is honest about it).

## Report back

For each section: pass / fail-with-detail. Any failure in **A** is a regression (blocks — tell
the team). Failures in **B/C** are new-surface bugs (file as board issues). All-pass on A + a
working sticky/slide in B/C = the cross-editor absorption is live-verified.
