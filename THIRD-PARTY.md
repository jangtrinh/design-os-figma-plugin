# Third-party attribution

This repo absorbs specific capabilities studied from a fork of an existing open-source
Figma tool, under its MIT license. This file lists exactly what was adapted, from where,
and how — the citations in `plugin/src/main/` doc comments and `knowledge/` point back
here.

## Source

- Project: `figma-console-mcp` (Figma Desktop Bridge)
- Read at: `southleft/figma-console-mcp` (studied locally as
  `/Users/jang/Products/research/figma-console-mcp`)
- Version read: **v1.38.2**
- Read date: **2026-07-31**
- License: MIT

Verbatim MIT notice from that project's `LICENSE`:

```
MIT License

Copyright (c) 2025 Figma Console MCP Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Derivations

| Our file | Derives from | Nature of derivation |
|---|---|---|
| `plugin/src/main/exec-stdlib-component-set.ts` + `exec-stdlib-component-matrix.ts` | `src/core/write-tools.ts:2825-3050` (`figma_create_component_set` tool contract) + `figma-desktop-bridge/code.js:2121-2411` (`CREATE_COMPONENT_SET` handler) | Adapted algorithm + constraint list: the two-mode contract (base+axes vs. combine-existing), the `=`/`,` name-token ban, the 100-combination hard cap and 40-variant size-warning threshold, and the cartesian-product-then-`combineAsVariants` approach. NOT ported: the handler's manual clone/rename rollback bookkeeping (`rollbackComponentSetWork`) — this repo's own `--undo-group` bracket (`executor-exec-js.ts`) already gives atomic rollback over the whole script via Figma's real undo stack, so a second hand-rolled mechanism would duplicate it. Also not ported: `autoArrange`/grid-layout — out of scope for this phase. |
| `plugin/src/main/exec-stdlib-slot.ts`, `-slot-resolve.ts`, `-slot-content.ts`, `-slot-property.ts` (absorption phase-02) | `figma-desktop-bridge/code.js:2837-3112` (CREATE_SLOT/GET_SLOTS/APPEND_TO_SLOT/RESET_SLOT handlers) + `code.js:409-486` (`serializeSlotsFromNode`/`resolveSlotNode`) + `src/core/slot-tools.ts:280-378` (manual SLOT-property path) | Adapted algorithm + constraint list: the four-operation contract, the raw-COMPONENT-append guard preceding the clone, the clearExisting-after-content-resolves ordering, the cloned-node position-snap, and the merge-not-assign rule for `componentPropertyReferences`. Deliberately NOT ported: the fork's full 8-type `content.nodeType` set (this repo supports RECTANGLE/FRAME/TEXT only) and its silent `[0]`-on-ambiguous-name-match behavior — this repo throws ambiguous instead, matching `byPath`'s existing precedent. The "nested inside another slot" check is implemented here for real; the fork's own tool description claims it but its code never does. |
| `plugin/src/main/exec-stdlib-annotate.ts` (absorption phase-02) | `figma-desktop-bridge/code.js:2454-2692` (GET/SET_ANNOTATIONS, GET_ANNOTATION_CATEGORIES handlers) | Adapted algorithm: category-id-to-name resolution with `categoryName:null` on no match, and the append-mode merge that prefers `labelMarkdown` over `label` when a stored annotation carries both (Figma auto-populates both on read but rejects writing both). The `skippedChildren` counter on child-walk throws is this repo's own addition, not the fork's. The 32-value `AnnotationPropertyType` list itself is copied as **values** — an API fact from `@figma/plugin-typings`, cited not attributed, per the phase spec's own ruling. |
| `plugin/src/main/exec-stdlib-figjam-content.ts`, `-figjam-table.ts`, `-figjam-arrange.ts`, `-figjam-read.ts` (absorption phase-03) | `figma-desktop-bridge/code.js:5970-6524` (all FigJam handlers) + `src/core/figjam-tools.ts:8-59` (enums, caps) | Adapted algorithm + constraint list: the font-load-before-characters order for sticky/connector/shape/table-cell text, the fallback-to-Inter-Medium-and-record-it pattern on a font load failure, the resize-before-text ordering for shape-with-text, `resizeWithoutConstraints` for sections, the `__stickyColors` name→RGB map (copied as **values**, labelled a workaround per the fork's own comment), and the batch caps (200 stickies/100×50 table/5000 text chars/50000 code chars/500 arrange nodes/1000 board-read nodes) — timeout/DoS guards, not real API limits. Deliberately NOT ported: the fork's full delivery mechanism for `arrange` (a JS string shipped through `executeCodeViaUI`) — this repo is already inside the sandbox and needs none of that, only the geometry. Fixed, not ported: the fork's `arrange` throws only when ALL ids fail (loses the partial truth — this repo reports `skipped`); its `board`'s `truncated` flag is `results.length >= maxNodes` (wrong when the board has exactly `maxNodes` matching nodes — this repo computes it from whether the source list was exhausted). |
| `plugin/src/main/exec-stdlib-slides-crud.ts`, `-slides-view.ts`, `-slides-content.ts`, `-slides-types.ts`, `-slides-resolve.ts` (absorption phase-04) | `figma-desktop-bridge/code.js:6530-7220` (all Slides handlers) + `src/core/slides-tools.ts:8-63` (enums, caps) | Adapted algorithm + constraint list: the array-like (not `.children`-bearing) `getSlideGrid()` row iteration, the `slideId → SlideNode` lookup `setSlideGrid` needs (ids are not accepted directly), the SLIDE type assertion after every `getNodeByIdAsync` (ids go stale), `isSkippedSlide` as a plain boolean, the view-mode-before-focusedSlide ordering for `focus`, the font-load-before-characters + fallback-to-Inter-Medium pattern for `addText` (same shape as FigJam), the RECTANGLE/ELLIPSE-only set for `addShape`, and the `TRANSITION_STYLES`/`TRANSITION_CURVES`/`TIMING_TYPES` enums (copied as **values**, cross-checked against the current Plugin API docs — the two agree exactly). Batch/size caps (10,000 text chars / 1,000 font size / 10,000 shape dimension) adopted from the fork's own guards — timeout/DoS guards, not real API limits. Deliberately NOT ported, REWRITTEN instead: `background` — the fork creates/updates a hardcoded-1920×1080 `RECTANGLE` named `'Background'` (`code.js:7060-7083`), a workaround for an API that did not exist when it was written; this repo's re-anchor found `SlideNode` itself carries a real `fills`/`setFillsAsync` via `GeometryMixin` and uses that directly, no rectangle at all. Fixed, not ported: `reorder` here refuses a grid that drops or duplicates a slide (the fork's own `setSlideGrid` accepts a grid missing slides, silently reorganising the deck); `content` uses this repo's own `serializeNode` (with a cycle guard and a real depth cap) instead of the fork's ad-hoc 7-field local serializer (`code.js:6585-6598`); `duplicate` uses `SlideNode.clone()`, not a fork-invented `duplicate()` the current typings do not show. |

## Facts cited, not derived expression

`knowledge/component-sets.md`'s state→CSS-selector table and its case-sensitivity
warning are **facts about Figma's own naming convention and about a bug observed in the
source project's analysis code** (`code.js:1318`, `code.js:1176-1197`), cited for
re-verifiability — so a reader can go check the claim against the source — not
reproduced as licensed expression. The table itself is rewritten in this repo's own
words per `knowledge/component-sets.md` §2.3.

## Attribution already carried in `knowledge/figma-agent-hand.md`

The broker/relay design (websocket-server pending-request correlation, heartbeat
approach) and the `scripts/probe/visual-diff.mjs` pixel-diff approach were adapted from
other MIT-licensed projects prior to this repo's own extraction from the `ease-design`
monorepo — see the top-level `README.md`'s Attribution section for those (pre-existing,
unrelated to this phase's absorption work).
