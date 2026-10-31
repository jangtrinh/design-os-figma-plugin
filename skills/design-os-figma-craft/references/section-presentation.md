# Section presentation — a section is the FINAL presentation, not a build log (generic)

Owner law captured 2026-08-20 and re-confirmed through three app campaigns (2026-09). A Figma section is what stakeholders read; agents must leave it presentable after every batch, not "tidy later".

## 1. Layout grammar

- **X axis = the flow, A → Z, grouped by FAMILY** (list → detail → create → edit → overlays of that family), one column per screen.
- **Variants of a screen go RIGHT** as sub-columns under one family header that spans them; never stacked below the base screen.
- **Y** is reserved for the family header (fixed y, e.g. 200) and the screens below it (`header.y + live header height + gap`).
- Gaps: column gap ≈ 800, cluster gap ≈ 400, header note dx = 0 / gap 30 — airy, never edge-to-edge. Bind the exact numbers in the adapter; inspect the header's LIVE height every session (it is HUG).
- Overlays (dialog/drawer/toast demos) sit in the column of the screen that opens them.
- **Resize a section to fit; never move it** — position is the owner's. `resizeWithoutConstraints(maxX + pad, maxY + pad)`.

## 2. Notes — group level, not per screen

- One `Annotation / Note` per GROUP (family or state cluster), 3–6 bullets, each < 90 chars, present tense, **no history** ("was X, changed to Y" is a report, not a note).
- Every delivered screen family carries a `LOGIC · …` note: what the screen does, what is gated, what is deferred. **A screen without its logic note is not delivered.**
- Notes sit right of the first screen of the group or under the family header, never floating between columns.

## 3. Naming and tags

- Artboard name = `<NN.n> <Screen> [· <State>]`; the number is the flow order, states share the base number.
- `[REVIEW]` in the name = needs owner eyes; `[ARCHIVED]` = kept for reference. Tags live in the NAME, not in colour or notes.
- Surplus screens after an owner re-layout go to a sibling section `<Section> · Archive` at **50 % opacity**; nothing is deleted without confirmation (law 12). Ask once: "everything not in the mockup is archived — confirm?"

## 4. Data coherence gate (mock data is part of the design)

- Every mock value that names an entity elsewhere in the file (a model, a server, a role, a plan) must EXIST in that catalog screen. A list showing a model the catalog does not have is a defect, not filler.
- Status labels / tones are the DS's closed set — never coined while translating or deriving; not found → ask.
- UI copy follows the adapter's language rule (typically English chrome, local-language data, emails/paths/codes untouched).
- Numbers agree across screens (5/10 tools selected on the card = 5 switches on in the drawer).

## 5. Owner mockup → DS rebuild (when the owner hands a board/mockup)

1. Read the board as INTENT; list its screens and states as a checklist before touching the canvas.
2. Build each with DS components via the ladder (reuse → override → variant → new); the mockup's pixels never win over the DS, but its structure and order do.
3. Everything in the section not in the mockup → archive section (§3), one question to the owner.
4. Nav entries the mockup removes are removed from the MASTER (no orphan menu items); model/entity names come from the file's own catalog (§4).
5. Deferred parts stay visible as a collapsed step/placeholder with a note — hidden scope is forgotten scope.
6. Close with the section left presentable: fit, headers, notes, tags, then a full-section PNG read by eye.
