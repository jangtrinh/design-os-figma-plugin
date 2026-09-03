# Screen composition — shell + slot + overlays + lifting masters (generic)

Companion to [component-system.md](component-system.md) §5 (shell + slot). That section says WHAT the architecture is; this file is the HOW that survived a 40-screen campaign (3 apps, 2026-09). Names in backticks are ROLES — the adapter maps them to the project's real component names.

## 1. Anatomy of one screen (invariant)

```
Artboard (FRAME, no auto-layout, size = shell size)
└─ `Shell / Template` INSTANCE            ← chrome: rail + sub-sidebar + top bar, variants pick the app
   └─ Content / Body
      └─ `Slot / Page content` INSTANCE   ← swapped to `Page content / <App> · <Screen>` (FILL × FILL)
```

- **The whole page is never one component.** Page content is its own master; the shell is shared by every app in the file.
- Chrome per app = VARIANTS on the chrome sets (`Rail`, `Sub-sidebar`), never a per-app copy of the shell. A screen only *selects* variants.
- Nav state is a variant on each nav item. Assert **exactly one active per nav level** before leaving the artboard — the template's default active app leaks silently and is the #1 defect found by audits.
- No breadcrumbs / no duplicate title if the adapter says the shell already carries them — check the adapter's "Conventions" before adding chrome-like content to page content.

## 2. Lift a page-content master from a LIVE INSTANCE (never from a stale master)

```js
const c = screenInstance.clone(); screenInstance.parent.appendChild(c); c.y = -9000;   // park off-canvas
const detached = c.detachInstance();                                                      // shell → frame
const pc = detached.findOne(n => n.type === 'INSTANCE' && /^Page content \//.test(n.name));
const master = figma.createComponentFromNode(pc.detachInstance());                        // content → master
dsPage.appendChild(master); master.name = 'Page content / <App> · <Screen>'; detached.remove();
```

- Why from an instance: the instance carries the overrides the owner actually approved; the old master may be stale or hand-edited.
- After `combineAsVariants` on page-content masters, **FILL widths collapse to ~½** — pin every variant `FIXED` to the slot width, then set the slot back to FILL. Verify in a NEW call (law 6).
- Lifted table cells can carry typography overrides from the source screen (bigger text, bold column). `resetOverrides()` per plain cell → re-set Type/Last/Text props → re-set FILL. Only reset cell types that hold no slot swaps / hidden layers (allowlist), or you wipe legitimate structure.

## 3. Screen states = a `State` axis on the page-content SET

Empty · Filled · Error · Loading · Select-open … are variants of the page-content set; the demo artboard flips `State` on the slot. Never fake a state with per-instance structural overrides (law 13). Extra axes (e.g. `Tools=Assigned|Empty` on a detail page) are fine when the axis is orthogonal to `State`.

## 4. Overlays live OUTSIDE the shell instance

```
Wrapper FRAME `<Screen> · <Overlay>` (clipsContent, size = artboard)
├─ shell instance clone  "(background)"
├─ Scrim (rect, token-bound fill, opacity from DS)
└─ Dialog | Drawer | Toast | Popover instance (positioned: centerIn / topRight / anchored)
```

- Shell instances reject `appendChild` — that is the reason, not a style choice.
- Dialog = `Dialog` shell + `Dialog body / <App> · <Purpose>` swapped into its slot. Drawer = `Drawer / Shell` (width variant) + `Drawer body / …`. Toast anchors top-right at the adapter's width. Popover = anchored under the control; **never inside a component master** — later steps paint over it and it clips.
- "Open" variants of a control (Select-open, menu-open) are demo artboards, not variants on the SET — they need the popover, and the popover needs the wrapper.

## 5. Icons on buttons — the one sanctioned override

`swapComponent` on a button's icon slot drops the master's stroke paint (the swapped-in icon keeps its own colour). Restore it by copying the stroke from the **host button's master variant** (not from the old icon — a rerun after a half-done swap would copy the wrong colour). Declare it as a law-13 carve-out in the report; verify with a paint diff = 0 against the master.

## 6. Helper-library contract (the block every build script pastes)

- `comp(name)` resolves by NAME, **design-system page first**, and THROWS when the name is ambiguous — the file can hold two live sets with the same name (a legacy and a rebuilt one); a silent first-match builds on the wrong one.
- `setP(inst, kv)` sets VARIANT props before TEXT props (text props on a not-yet-switched variant vanish).
- `getMainComponentAsync` only (sync getter throws under dynamic-page loading). `componentProperties` throws on sets with errors — wrap in try/catch for READ-ONLY scans only, never for writes.
- `findAll` returns hidden nodes — when the PNG contradicts the data, suspect `visible=false` before suspecting the script.
- Every helper fails loud (`must(x, what)`); the returned `{}` of a build script lists created ids + asserts so the controller can verify without re-reading the canvas.
- Instance children accept only visible / sizing / text; `x`/`y` THROW; `resize` + min/maxWidth are silent no-ops.

## 7. Hero / family header inside a section

Section header composite (family name + description + app tags) sits at a fixed y; screens start below it at `header.y + header.height + gap`. **Inspect the header's live height once per session** — it is HUG and grows with text; a memorised number (225 → 512 in one file) is how screens end up overlapping the header.
