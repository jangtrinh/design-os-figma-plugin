---
name: es-figma-craft
description: "Generic Figma canvas engineering discipline — the battle-tested workflow, laws, and Plugin-API failure-mode catalog for building/editing Figma files programmatically (design:os figma-agent CLI or use_figma MCP). Use for ANY project's Figma build/edit/componentize/verify work. Distilled from the VSF-PCP campaigns (2026-06 → 2026-08): every rule here paid for by a real incident."
user-invocable: true
when_to_use: "Invoke before ANY programmatic Figma mutation session in ANY project — screen builds, component minting, variant sets, table builds, master edits, batch sweeps. Pairs with a thin per-project adapter (see references/project-adapter-template.md). Skip only for pure read-only diagnosis of a single node."
category: user
keywords: [figma, design-os, figma-agent, exec-js, use_figma, plugin-api, component, variant, verification, pipeline]
metadata:
  author: jang
  version: "1.0.0"
  lineage: "Consolidated 2026-08-07 from VSF-PCP figma-idp-rebuild references + design-os supervised update + figma-agent backlog + 25 memory entries"
---

# es-figma-craft — Figma canvas engineering, project-agnostic

**This file is the router.** It holds the pipeline, the laws, and a load-table. Details live in exactly one reference each — load on demand.

## Two-part architecture (how this stays generic)

1. **This skill = the universal layer.** Laws, pipeline, Plugin-API failure modes, component-system rules, verification protocol, knowledge-sync protocol. Nothing here names a specific file, token, or font.
2. **A per-project adapter = the specific layer.** Each project ships a thin skill/doc declaring: Figma file name+key, page layout, token collections, fonts, component registry path, copy rules, overlay idioms. Template: [project-adapter-template.md](references/project-adapter-template.md). **No adapter → create one from the template before the first mutation.**

## Bridge selection (which hand touches the canvas)

| Bridge | Use for | Notes |
|---|---|---|
| **design:os `figma-agent` CLI** (Ease Design Figma Agent plugin) | ALL mutations when the project is design:os-onboarded | Preferred canonical hand. `figma-agent status` must show `plugin.connected:true` for the RIGHT file, checked 2× ~15s apart before long batches. Prefer typed ops (`clone-traits`, `inspect`) over raw `exec-js`. |
| **`use_figma` MCP** | Mutations where no figma-agent is wired; reads | MANDATORY: load the `figma-use` skill first, every call. |
| **`html_to_design` (DesignAgent)** | Bulk HTML→Figma imports of authored screens | HTML-first authoring pipeline; not for surgical edits. |
| **MCP read tools** (`get_metadata`/`get_screenshot`/`get_design_context`) | Diagnosis, recon, verification | Cheapest-first: metadata → screenshot → design_context (last resort, 25K-token cap). |

**Every mutation script opens with a file guard:** `if (figma.root.name !== '<expected file>') throw` — multi-plugin brokers can route to the wrong file.

## The pipeline (5 phases — every build)

```
0. PREFLIGHT  Adapter loaded · bridge alive (status ×2) · registry/docs read · reconcile if user changed the file
1. RECON      Cheapest-first read of source + target. Element→component mapping table BEFORE any code.
2. ENHANCE    Close component gaps by the creation ladder (reuse → override → variant → new; owner approval for shared-master changes)
3. BUILD      Sequential, one section per call, idempotent scripts, tag every created node, position explicitly (never (0,0))
4. VERIFY     3 layers: node-read asserts → numeric geometry asserts → FRESH PNG read by eye. Structural ops verified in a NEW call.
5. CLOSE      Reconcile registry/docs in the same change · distill ≤1 durable lesson · report honestly (misses as misses)
```

Detail per phase: [pipeline.md](references/pipeline.md).

## The 12 laws (gates, not advice — each one is a paid-for scar)

1. **Verified = measured.** Screenshots are for humans; geometry gets numeric asserts, structure gets metadata reads. Node-read AND rendered-PNG can BOTH lie — when they disagree, measure bounding boxes.
2. **Fresh PNG is the final arbiter of every mutation batch.** Numeric asserts passing is not done; look at the image with your eyes. Verify against FRESH artifacts (check mtime / re-export).
3. **Read before write; capture before destroy.** Dump content to JSON before replacing/instancing anything carrying data. Never destroy a rollback you haven't examined.
4. **Resolve by NAME (or plugin-data tag), never cached id.** Node ids renumber on sync and can be transient within a session. Target by parent chain, not bare name, when names repeat.
5. **A failed/timed-out call may have mutated the file.** Re-read state before ANY retry. After a mid-batch disconnect: inventory first, rerun second. Scripts must be idempotent.
6. **Structural ops (create/combine/reparent) are only proven by a NEW call.** Same-call re-fetch can report success for a mutation that never persisted. Verify set child counts + variant names, then sweep for orphan byproducts.
7. **Fix the class, not the symptom; fix at the master.** Defect in an instance → suspect the master; then sweep siblings for the same latent bug. Audit an atom's internals before composing with it. Sweep everything once — not per-complaint.
8. **One origin per geometry.** Never generate the same geometry from two code paths. One spec constant, one script.
9. **Real instances only + the creation ladder** (reuse → instance-override → add-variant → create-new last). Shared-master/component changes need OWNER APPROVAL before minting. Normalize construction BEFORE componentizing (no spacer frames — spacing = auto-layout gap).
10. **No try-catch that swallows mutation errors.** Sizing/props failures throw or collect into the returned output. A green gate that is blind is worse than a red gate.
11. **Sequential canvas, single hand.** One file, one plugin connection, rate limits: never fan out parallel agents against a Figma file. Multi-screen work = a checklist driven step-by-step.
12. **Respect the owner.** A value the owner re-changed 2× after you set it = owner intent — stop, check the decision ledger, ask once. Never delete content you didn't author without confirmation. Their DS/conventions win over your spec.

Full thinking layer (8 operating gates + rationale): [operating-gates.md](references/operating-gates.md).

## Reference docs — load by task signal

| Doc | When to load |
|---|---|
| [operating-gates.md](references/operating-gates.md) | **Every session, before the first mutation** — the thinking layer |
| [pipeline.md](references/pipeline.md) | Every build — per-phase detail, MCP/call budgeting |
| [plugin-api-gotchas.md](references/plugin-api-gotchas.md) | Before writing ANY exec-js / use_figma script — 6 classes of API failure modes with fixes |
| [component-system.md](references/component-system.md) | Any componentize / variant / table / shell decision — ladder, extraction heuristics, column-first tables, shell+slot, template-first |
| [verification-protocol.md](references/verification-protocol.md) | Closing any batch — the 3-layer verify, false-green catalog, sweep disciplines |
| [script-helpers.md](references/script-helpers.md) | Writing any mutation script — copy the fail-loud helper block + ordering laws |
| [knowledge-sync.md](references/knowledge-sync.md) | User says they changed the file, or your docs picture may be stale — URL-drop protocol, drift channels, reconcile triggers |
| [project-adapter-template.md](references/project-adapter-template.md) | Onboarding this discipline to a new project |

## Non-negotiables inherited from hard experience

- **Icons:** use the project's icon library as real instances — never text glyphs (`×`, `→`) or hand-drawn vectors. Stroke-based icon sets (Lucide): recolor `strokes` only, never `fills`.
- **Overlay idiom:** DRAWER = editing panels over content/lists; centered MODAL = single action / confirm / short form (≤3 fields).
- **Screen-state demos = variant SET on the page-content master** (`State` axis), never per-instance structural overrides. Instance overrides are for DATA only.
- **Every created node gets `setSharedPluginData(<ns>, 'run_id'/'key', …)`** for idempotent cleanup and reliable re-location.
- **Report honestly:** errors as errors, skipped as skipped, "should work" is banned — verified or listed as NOT verified.
