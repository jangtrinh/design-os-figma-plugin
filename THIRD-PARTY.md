# Third-party attribution

This repo absorbs specific capabilities studied from existing open-source Figma tools,
under their MIT licenses. This file lists exactly what was adapted, from where, and how —
the citations in `plugin/src/main/` doc comments and `knowledge/` point back here. Each
source gets its own section below.

## Source — figma-console-mcp

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

## Source — cast-to-figma (the auto-connect surface)

- Project: `cast-to-figma` (a local CLI + Figma plugin workflow, distributed with its own
  agent skill)
- Read at: `newfiction/cast-to-figma`, npm package `@newfiction/cast-to-figma`
- Version read: **0.2.2**
- Read date: **2026-08-12**
- License: MIT

Verbatim MIT notice from that project's `LICENSE`:

```
MIT License

Copyright (c) 2026 New Fiction

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

**No code was vendored from this project — nothing here derives from its source
expression.** What was studied is its README/SKILL.md and its CLI's user-facing surface:
the *shape* of four ideas, each re-designed and re-implemented against this repo's own
broker, protocol, and ledger.

| Our file | Idea studied | Nature of adaptation |
|---|---|---|
| `cli/src/commands/install-skill.ts`, `cli/src/skill-emitter.ts`, `cli/src/command-catalog.ts`, `skills/figma-agent/SKILL.md` | A CLI that distributes its OWN agent skill, whose frontmatter declares the CLI version it needs (`requiresCli`) | Adopted: the concept of the skill as the distribution unit, the `requiresCli`/`version`/`cliBinary` frontmatter keys as a compatibility contract, and an installer command as the delivery path. Deliberately DIVERGENT, and the reason this was worth building rather than copying: the source ships a hand-written static `SKILL.md`, so its reference can drift from its binary. Here the command-reference section is **emitted** from the same `command-catalog.ts` that renders `--help`, and `tests/skill-emitter-drift.test.ts` fails the build when the committed artifact and the emitter disagree — the repo's standing "a standard needs an emitter AND a linter" rule. The consent behaviour (version compare before overwrite, a non-interactive run that refuses to assume) is this repo's own. |
| `cli/src/transport/broker-peek.ts`, `cli/src/commands/install-hook.ts` | A session-start status surface an agent reads before doing anything | Concept only. The implementation is entirely this repo's: a non-spawning read of our own `/tmp` broker advertisement plus one short bounded WS query, three-state honesty (`connected: true|false|null`), and `versionMatch`/`protocolMatch` computed from the `pluginVersion` our plugin already sends on `PLUGIN_HELLO`. The consent rules around writing a hook into a user's settings file (confirm, backup, abort on unparseable JSON, `--dry-run`) have no counterpart in the source. |
| `shared/protocol.ts` (`RequestMsg.agent`), `cli/src/transport/broker-client.ts`, `plugin/src/ui/activity-feed.ts`, `plugin/src/ui/panel-ui.ts` | An `--agent <id>` label so a panel can show which harness is driving | Adopted: the flag name, the env-var fallback, and the `cli` default. Implemented against our own envelope with this repo's additive-field contract — omitted entirely when unset so an unlabelled frame stays byte-identical to a pre-flag CLI's, with the default applied at render time instead. Validation against an explicit allowlist (refusing rather than sanitizing) is this repo's own. |
| `cli/src/commands/cowork.ts`, `cli/src/transport/cowork-waiter.ts` | A `cowork` command that waits for the designer to finish a round of edits | Concept and command name only. This repo already had an actor-labelled edit feed and a supervised-memory correction ledger, so quiescence is detected broker-side from edits that already cross the wire — no second store, no new plugin timer, no polling. The actor/source gating (only a LIVE `owner` batch arms a cycle; agent, ambiguous, and gap-fill replay never do), the `cycles: 0`-is-success contract, and the read-only ledger lookup are this repo's own design. |

## Attribution already carried in `knowledge/figma-agent-hand.md`

The broker/relay design (websocket-server pending-request correlation, heartbeat
approach) and the `scripts/probe/visual-diff.mjs` pixel-diff approach were adapted from
other MIT-licensed projects prior to this repo's own extraction from the `ease-design`
monorepo — see the top-level `README.md`'s Attribution section for those (pre-existing,
unrelated to this phase's absorption work).
