# Project adapter — template

Copy into the target project as `.claude/skills/figma-<project>/SKILL.md` (or a `## Figma` section of `.project-agent.md` for small projects). The adapter carries ONLY project-specific facts; all discipline lives in `es-figma-craft`. Keep it thin — if you're writing a *rule* here that isn't project-specific, it belongs upstream in es-figma-craft (record a gap instead).

```markdown
---
name: figma-<project>
description: "Figma adapter for <Product>: file identity, DS layout, tokens, conventions. Pairs with es-figma-craft (the discipline lives there)."
category: project
---

# Figma adapter — <Product>

**Always load `es-figma-craft` alongside this file. This file = facts; that file = law.**

## File identity
- File: `<Figma file name>` · key `<fileKey>` — THE source of truth for design.
- Mutation guard for every script: `if (figma.root.name !== '<Figma file name>') throw`.
- Bridge: <figma-agent CLI via "<plugin name>" | use_figma MCP>. Status precheck: `<command>`.

## Page layout
- `<Design system page>` — component masters; sections: <list section frames>.
- `<Screens page(s)>` — built screens; placement convention: <right-of-previous +80 | per-section>.
- Machine-readable markers: <e.g. `_AI MANIFEST` node + plugin-data namespace `<ns>` with status canonical/deprecated/legacy — or "none">.

## Tokens & styles
- Variable collections: <names + counts>. Canonical token cache: `<path, e.g. design/tokens.json>` (DERIVED — re-scan, never hand-edit).
- Text styles ramp: <list or pointer>. Effect styles: <list>.
- Fonts to load: <family + styles>.
- Icon library: <e.g. Lucide as `Icon / *` components, stroke-recolor only>.

## Component registry
- `<path, e.g. docs/figma-component-registry.md>` — the ONLY inventory (name · type · variants · id-as-hint · purpose). New component ⇒ registry row in the same change.

## Architecture in this file
- Shell template: <master name + slot name, or "none — chrome inline">.
- Screen templates registered: <Template · Table card, … or "none yet">.
- Table standard: <column-first per es-figma-craft | legacy notes>.

## Conventions (owner law — cite source)
- Copy/language: <e.g. UI copy full English; data stays local-language>.
- Color restraint: <rules>.
- Overlay idiom: <drawer vs modal split>.
- Date/number formats: <e.g. DD/MM/YYYY hh:mm:ss>.
- <other locked conventions, each with date + decision source>

## Sanctioned exceptions (leak-vs-sanctioned)
- <values/strings that LOOK like violations but are intentional — keep this list or audits re-flag them forever>

## Workstream docs
- <per-domain READMEs to load when touching that area>

## Scripts & artifacts
- Mutation/recon/verify scripts → `plans/{plan}/scripts/` (never scratchpad). PNGs → `verify-pngs/`.
```

## Onboarding a new project (checklist)

1. Fill the template above — file identity + guard first; everything else can start sparse.
2. Run a full-file reconcile walk (verification-protocol.md) to seed the registry from live canvas truth.
3. Establish page structure + AI-manifest tagging if the file will be multi-agent.
4. Register the first templates as patterns stabilize (template-first, component-system.md §6).
5. Wire the knowledge-sync channels: where intent memories go, where the corrections feed lands, who the owner is.
6. Project-specific *lessons* accumulate in the ADAPTER (or the project's known-patterns file); universal lessons go UPSTREAM to es-figma-craft — one fact, one home.
