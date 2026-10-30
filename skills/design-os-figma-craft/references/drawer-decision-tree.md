# Drawer decision tree — which component goes inside an overlay (generic method + ruleset)

Owner ask that produced this (2026-09-03): "we need a better decision tree for which component to use in a drawer" — after an agent composed a bare list where the DS already had a facet component. The reusable part is (a) the METHOD that derives the tree from the file and (b) the purpose ruleset; component names are ROLES the adapter binds.

## 0. Derive, don't invent (method — run once per file, re-run when the DS changes)

1. Scan every `Drawer body / *` and `Dialog body / *` master + every legacy inline drawer frame: width, header variant, child instance names (depth 2), footer buttons. One read-only script, JSON to the plan's reports dir.
2. Group by width → the width tiers ARE the rule (the file already votes). Group body compositions by purpose → the rows below.
3. Write the tree with live example names per row and a "deviations found" list at the end. Deviations are backlog, not exceptions.
4. Every later drawer must map to exactly one row; if it cannot, that is a question for the owner, never a new ad-hoc composition.

## 1. Dialog or drawer?

```
single action · confirm · ≤3 fields ─────────────► Dialog (+ `Dialog body / <App> · <Purpose>`)
filter · form · pick-list · entity edit · detail ─► Drawer
```

Destructive confirm (deactivate/delete) = dialog with danger primary; reversible toggles need no confirm (owner ruling pattern — ask once per product).

## 2. Shell is not a choice

`Drawer / Shell` instance in a wrapper frame outside the screen shell; body = `Drawer body / <App> · <Purpose>` COMPONENT swapped into the shell's slot, FILL both axes; body master HUG; drawer height = artboard height. Never an inline frame named like a component.

## 3. Width — by the heaviest content inside (typical tiers 480 / 560 / 700; bind real values from the scan)

| Tier | Body holds |
|---|---|
| narrow | filter facets · checkbox sections · date ranges · short one-column form (≤6 controls) · pick-list blocks |
| medium | form with sections, switches, code/JSON editor |
| wide | key-value grids · column-first mini tables · multi-card · domain composites |
| full-workspace | exception only, owner GO recorded |

## 4. Header

`Title` by default. `Identity` (name · code · avatar) only when the drawer is about ONE existing entity and the identity is not already in the body.

## 5. Body — one row per purpose; compose only from these roles

| Purpose | Composition | Footer |
|---|---|---|
| **A · FILTER** | per facet: cardinality ≤ N (N from the facet component's cap, typically 5) → eyebrow label + bare `CheckboxRow` list · > N → `MultiSelectFacet` (search + capped scroll + count + select-all) · date range → eyebrow + From/To input with calendar icon · never a `Select` as a filter | Clear all · Apply |
| **B · CREATE / EDIT short form** | `Field` = label row (+required mark) → helper → control (`Input`/`Textarea`/`Select`/`Switch`) → hidden error line; sections split by `Separator`; validation = control `State=error` + inline message | Cancel · Create/Save |
| **C · PICK MANY children of a chosen parent** | per parent: a collapsible `Block` (header: chevron · parent name · `n/m selected` caption · select-all link · remove) + rows with **real `Switch`** when children carry a description and an on/off meaning; children that are only names → `MultiSelectFacet` in a popover instead · a NEW block starts as a single `Select` of the parent · picker popover = `MenuItem` list, **non-selectable entries hidden, not disabled** · summary line above blocks = plain text | Cancel · Save (disabled until change) |
| **D · EDIT ENTITY with facts** | `KeyValue` (read-only facts) + B-controls + domain composite · `AlertBanner` for warnings | Cancel · Save |
| **E · DETAIL / READ-ONLY** | `KeyValue` grid + column-first mini table (card header → head + cells → footer) · `AlertBanner` for degraded state | none / one secondary |

Cross-cutting: chips = neutral tag unless semantic status → `Badge`; counts in headers = plain text, not badges; every button carries its leading icon; states/demos = variants on the body SET, never per-instance structural overrides; high-cardinality single pick = `MenuItem` popover; multi pick = `MultiSelectFacet` popover.

## 6. Forbidden (each one was found in a real file)

Inline frame named like a component · bare checkbox list above the facet cap · spacer frames · `Select` as filter · badge for non-status chips · disabled entries in a parent picker (hide them) · a popover composed inside a component master.

## 7. When the owner's board disagrees with the tree

The board wins for THAT drawer (owner law), and the tree gets a conditional row tagged with the sample size (`n=1`), not a rewrite. Two boards agreeing = promote to rule.
