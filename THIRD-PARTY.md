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
