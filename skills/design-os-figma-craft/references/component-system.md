# Component-system rules — ladder, extraction, tables, shells, templates

## 1. Real instances only

Every element that LOOKS LIKE a library component (Button/Badge/Card/Input/…) MUST be an instance of it — never an inline-styled look-alike. The failure mode: someone edits the master, the look-alike doesn't update → drift → the design system stops being a system. The rule applies **recursively**: composites use other composites as real instances.

Icons: always real instances from the icon library — never text glyphs (`×`, `✓`, `→`) or hand-drawn vectors. (Typographic arrows inside prose are text, fine. Brand logos exempt.)

**Binding is part of the rule:** the scaffold YOU hand-build around instances must bind color → Variables, type → Text Styles (`setTextStyleIdAsync`), shadows → Effect Styles — never raw values when a token/style exists. Scope styling sweeps to nodes YOU created — never restyle a donor's own nodes or anything inside an INSTANCE. If no token fits a recurring value, propose a token; don't silently bake the raw value.

## 2. The creation ladder (MANDATORY, strict order — stop at the first rung that works)

1. **Reuse** — a component of that kind exists → instance it (resolve by NAME via the registry).
2. **Instance override** — needs different text/icon/color/visibility → override at the instance (`setProperties`, `swapComponent`, fills, `.visible`). Never add a variant for what an override covers.
3. **Add a variant / property** — lacks a recurring state/size/shape → extend the EXISTING set. Never fork a near-duplicate.
4. **Create new — last resort** — only if nothing of that kind ever existed. Build it in the proper design-system section AND add its registry row in the same change.

**Hard prohibitions:** no inline look-alikes; no second component overlapping an existing one; no "new enhanced" duplicates — enhance the original in place. Every create-new in a build report must state WHY rungs 1–3 failed.

**PRIMITIVES-THEN-VARIANT (owner mindset):** when a same-named component exists but doesn't fit the need, classify FIRST: **DEFECT** (fix the master) · **MISSING TYPE** (build/extend the family's PRIMITIVE atoms, then construct a NEW VARIANT in the existing set from those primitives) · **DIFFERENT NATURE** (rare — a declared composition, must be proven). Never dodge, never compose per-screen, never fork the family.

**BUILD-FOR-REUSE:** before building a group of screens/states, list every block appearing in ≥2 page-contents (header, meta row, summary, timeline item, list row, form…) → build the primitive → build the composite from primitives → every page-content uses instances. Different states → variants/props/hidden-blocks on ONE component, never N copies. One form component can serve 8 modal states; one list page-content can serve 4 screens via hidden rows.

**LEVERAGE-FIRST:** learn how the kit builds before building. Building blocks (cells, rows, chips, list items) live INSIDE the kit's existing component systems — a missing kind = add a variant there (backup-edit protocol); screen-scoped component names are ONLY for page-content wrappers, never for building blocks.

**Owner approval gate:** any plan that mints/changes a SHARED component (anatomy, props, rewiring) is presented to the owner BEFORE execution. Small fixes within an approved scope are fine.

## 3. Extraction heuristics (composite vs inline)

- **Extract when a pattern repeats 3+ times** in a screen OR will certainly appear on the next screen. At 2 uses: build inline twice, extract on the 3rd — unless it's inherently structural (Card/Row-like) or carries internal state.
- **Inline is legitimate** for true one-off shell chrome, and patterns internal to a composite you're already extracting.
- **Never extract:** layout containers, one-per-screen headers/eyebrows, anything an instance override already achieves, micro-elements (a 6px dot).
- Sanity check: "would this be USEFUL in a designer's Assets panel?" If it's too page-specific — inline.
- Expect the cascade: early screens surface component gaps (good — enhance, don't inline); by screen 4–5 you should be mostly reusing. Still creating 4+ components per screen = over-extracting.

## 4. Tables — COLUMN-FIRST (the standard)

Build tables by COLUMN, not by row:

```
Table card              VERTICAL, gap 0
├── Card header         title + count + search + filter
├── Columns             HORIZONTAL, gap 0 — no spacers, no row frames
│   ├── Column · A      VERTICAL, FIXED width → [Head instance, Cell instance ×N]
│   ├── Column · B      … (exactly ONE flex column: layoutSizingHorizontal='FILL')
│   └── Column · Z      FIXED
└── Table footer        count + page size + pagination
```

Why: alignment **by construction** (head + cells share one column frame — cannot drift; no alignment asserts needed); column resize = 1 frame; add/remove column = 1 frame, N rows untouched.

- Data goes through cell PROPS (prefix-matched keys), never raw text; status columns nest the real Badge component; last-cell variant controls dividers.
- Row-height change = change cell instances across ALL columns at the same index (one short cell skews the whole visual row).
- New column = clone an existing column (keeps construction) → rename → resize → flip Head text + cell variants.
- Content that doesn't fit the shared Cell set → mint a SEPARATE per-table cell set; never add an axis to the shared set (Class D gotcha).
- Mutation scripts must also think column-first — a row-based deletion script on a column-first table "succeeds" and does nothing.
- Legacy row-based tables (shared COLUMNS spec + drift assert ≤0.5px) are read-only heritage; never build new ones.
- **Present tables at NATURAL width** — never cram/fold columns to fit a pane; let width cascade up so the screen grows (the real app scrolls horizontally).
- **🚨 Audit EVERY cell/column once before declaring a table done** — walk all columns, confirm each cell is an INSTANCE of the shared cell component, not a hand-built frame. Don't wait for the owner to point at them one by one.

## 5. Shell template + page-content slot (full-screen architecture)

When a product has repeating chrome (rail/sidebar/top bar), build ONE `Shell / Template` master composing the chrome + a `Slot / Page content` placeholder. Then a screen = 2 operations:

```js
const inst = shellMaster.createInstance();
inst.findOne(n => n.type==='INSTANCE' && n.name==='Slot / Page content')
    .swapComponent(pageContentMaster);   // FILL sizing survives the swap
```

- The slot is a plain nested instance + manual swap (NOT an INSTANCE_SWAP prop — local keys rejected).
- Page-content masters are minted by **clone-convert** from a built screen's Body (`clone()` → `createComponentFromNode` preserves nested instances + overrides), then retrofit top-level auto-layout only. Cheaper and more faithful than rebuilding.
- **Sweep the source frame for ABSOLUTE overlays outside the Body before converting** (toasts/modals/scrims silently left behind); carry them into the right state variant.
- **🚨 Exactly-1-active assert for EVERY nav level (rail AND sub-sidebar) before finishing an artboard** — template defaults leak the wrong active app silently; throw on count ≠ 1, and demote with a state-name fallback (`rest` vs `default` differ across sets).
- Screen-state demos (filled/error/empty/…) = turn the page-content master into a COMPONENT_SET with a `State` axis; the demo artboard flips `State` on the slot. **Instance overrides are for DATA only, never for STATE** ("edit instance is never a good idea" — owner law).
- Overlays on a shell screen: wrapper frame around [shell instance + overlay] — shell instances reject appendChild.

## 6. Template-first

Once a pattern is standardized (table card, list page, detail, drawer…), register it as a clone-to-use TEMPLATE in the design system. Building that screen type = CLONE the template, replace content only. Structure/spacing/styles are locked — never hand-compose a layout the template already owns.

## 7. 🚨 Componentize = NORMALIZE FIRST (hard gate before any `createComponentFromNode`)

Construction debt multiplies through every future instance. Before minting from screen content:

1. **Construction lint:** zero spacer frames (empty FRAMEs existing only for spacing), zero 1px fillers. Spacing = auto-layout `itemSpacing`/padding; uneven groups → split into section frames with their own gap.
2. Legacy dirty construction is NOT inherited into a master — clone for CONTENT, normalize STRUCTURE first.
3. Every API-created frame sets `layoutMode` + explicit sizing (createFrame defaults 100×100 FIXED + clips). Sizing failures must throw loudly.
4. Post-normalize asserts: text-node count unchanged · 0 spacers at ANY depth · no container narrower than its content min-width · fresh PNG read by eye (numeric asserts alone missed a 100px clip).

## 8. Consistency habits

- If sibling entities elsewhere in the file follow a convention pair (e.g. Name+Code fields), new detail views MUST carry the full pair — check proactively, don't wait for the owner.
- New key-value data goes into the established KV-grid pattern, not a loose label+value below it (that's design debt).
- Restructure a variant WITHOUT breaking instances: don't delete+recreate — change the variant's own layoutMode, push old children into an inner frame, append the new sibling; `componentId` survives. Paint arrays carry their bindings on copy; numeric bound variables must be re-fetched and re-bound explicitly.
- Every new component/template gets its machine-readable tag (status/section/note plugin-data) if the file uses a manifest system — an untagged node is invisible to the next agent's safety checks.
