# Component sets — build from a matrix, analyse an existing one

Two recipes (absorption phase-01, Basket B): `ui.componentSet(...)` builds a
COMPONENT_SET from a variant matrix or from existing components; the analysis recipe
below composes tools this repo already has (`figma-agent scan-node`, `ui.q`,
`ui.componentSet`'s own `propertyDefinitions`) to answer the same question the fork's
`figma_analyze_component_set` does — **without** its case-sensitivity bug or its
"guess the main interactive child" heuristic (both explained below, so neither comes
back by accident).

All snippets are `figma-agent exec-js` ready (async body, `ui`/`figma` globals, `return`
a JSON-safe value). Companion: `knowledge/figma-craft/components-variables-styles.md`
§1.3 (the `combineAsVariants` naming contract this builds on).

---

## 1. Build a set from a variant matrix

```js
// Mode 1 — generate from a base COMPONENT + axes (cartesian product):
return await ui.componentSet({
  base: '12:34',
  axes: { State: ['default', 'hover', 'disabled'], Size: ['sm', 'lg'] },
});
// → 6 variants. The BASE keeps its node id (variants[0].id === '12:34'), so any
//   existing instance of the base survives as an instance of that first variant.

// Mode 2 — combine existing COMPONENT nodes, naming them via variantProps:
return await ui.componentSet({
  components: ['1:1', '1:2', '1:3'],
  variantProps: [{ State: 'default' }, { State: 'hover' }, { State: 'disabled' }],
});
```

- **Run this behind `--undo-group`.** `ui.componentSet` cleans up its OWN mutations —
  and ONLY those — if one of ITS OWN later steps throws (a size mismatch, a name that
  didn't parse back to the intended axes, `combineAsVariants` itself rejecting the
  call). Say precisely what that means, because "cleans up" understates it:
  - **IS restored**: the base's original name (mode 1), and each combined component's
    original name (mode 2) — whatever `buildModeA`/`buildModeB` renamed gets renamed
    back. A clone `buildModeA` created for the matrix is removed.
  - **IS NOT restored**: if `combineAsVariants` already ran before the failure (i.e. the
    throw came from the post-combine verification, not from `combineAsVariants` itself),
    the COMPONENT_SET it created stays on the canvas — cleanup renames/removes the
    build's own nodes, it does not un-combine Figma's structure or delete the set.
    Concretely: a verify-mismatch after a successful `combineAsVariants` leaves the
    combined set standing. In mode 1, the base (renamed back to its original name)
    remains as the set's only child once the clone(s) built for the matrix are removed.
    In mode 2, every original component stays parented inside the set — each renamed
    back to its own original name, but the set itself and its full membership persist.
  - This is a narrow, self-scoped safety net for build's OWN pre-combine mutations, not
    a substitute for the real undo bracket. If a DIFFERENT step in the same script fails
    (including this leftover COMPONENT_SET case above), `--undo-group` is what rolls the
    whole script back; without it, a successfully-built set — or the orphaned one left
    by a verify-mismatch — stays on the canvas. Always wrap a script that calls this in
    `exec-js --undo-group` unless you specifically want partial results to survive.
- **Exactly one of `base`+`axes` or `components`** — both or neither throws, naming the
  two valid shapes.
- **Axis and value names must not contain `=` or `,`** — Figma parses variant properties
  by splitting the name on those characters, so a stray comma silently creates a bogus
  extra axis. Rejected before anything is created.
- **Deterministic order**: axis insertion order, then values in the order given — the
  variant list is reproducible, never shuffled.
- **Hard cap: 100 combinations** — throws naming the computed count and advising a split
  by one axis. **Above 40**, the reply carries `sizeWarning` (not a rejection) — large
  matrices are slow to build; split by Size or another axis if it matters.
  `[re-verify]` both thresholds against a real build; they're the fork's own numbers,
  not independently measured here.
- **Mode 2, no `variantProps`**: existing names are kept as-is. A name lacking `=`
  triggers a `warnings` entry — Figma will file it under `Property 1=<name>`
  `[re-verify]` — pass `variantProps` if you want to choose the axis explicitly.
- **A component already inside a COMPONENT_SET is rejected** in both modes, naming the
  set it's already in.
- **Instances come from a variant's own `key`/`id`, never the set's** — the reply's
  `variants[]` carries both per variant.
- **A big matrix can outrun `exec-js`'s default 30s timeout.** Raise `--timeout` (cap
  120s) and, if it still times out, the build **keeps running** server-side — split
  large matrices across multiple `ui.componentSet` calls (one per Size, say) rather than
  one call for everything.
- Not ported from the fork: automatic grid layout (`autoArrange`). This is a knowledge
  recipe only, built when a task actually asks for it — see
  `components-variables-styles.md` §1.3's post-combine geometry recipe for how to lay
  variants out by hand (walk child bounds, resize the set, let auto-layout space them).

## 2. Analyse an existing set

No dedicated command — compose what already exists:

```js
const set = await ui.q('12:34', { depth: 2 });          // figma-agent scan-node's shape
// set.propertyDefinitions came back from ui.componentSet when YOU built it; for a set
// you didn't build, read componentPropertyDefinitions directly:
const defs = await ui.q('12:34', { fields: ['componentPropertyDefinitions', 'children'] });
```

Then, per variant child (`figma-agent scan-node` or `ui.q(childId, {depth:N})`):

1. **Parse the variant's name** into an axis map the same way `ui.componentSet` does
   (`Prop=Value, Prop2=Value2`) — case-SENSITIVE splitting on `=`/`,`, but axis-value
   **matching** below must be case-insensitive (see the headline warning).
2. **Diff every variant against the default** by comparing the full serialized subtrees
   (`ui.q(id, {depth:N})`), not a single "main interactive child" guess. Report the
   changed paths — whatever they are, structural or visual.
3. **Map to CSS pseudo-classes / ARIA attributes** for the state axis (rewritten in our
   own words from the observed convention, not copied verbatim):

   | State value | Selector |
   |---|---|
   | default | *(none)* |
   | hover | `:hover` |
   | focus / focus-visible / focused | `:focus-visible` |
   | active / pressed | `:active` |
   | disabled | `:disabled, [aria-disabled="true"]` |
   | error / invalid | `[aria-invalid="true"]` |
   | filled | `.has-value` |
   | selected | `[aria-selected="true"]` |
   | checked | `:checked` |
   | loading | `[aria-busy="true"]` |
   | readonly | `[readonly]` |
   | open | `[aria-expanded="true"]` |
   | closed | `[aria-expanded="false"]` |

4. **Map property types to code props**: `BOOLEAN` → boolean prop, `TEXT` → string prop,
   `INSTANCE_SWAP` → a slot/`ReactNode` prop, `VARIANT` → a union of the axis's
   `variantOptions`. `SLOT` (Figma's named-slot property) maps to a named
   slot/`children` prop — forward-reference to phase-02's slots/annotations work; not
   built here.

### Headline warning: match axis values case-insensitively

**A conventionally-named set (`State=Default`, `State=Hover`, …) must still find its
default variant.** A known prior implementation of this analysis (the fork this recipe
studies) compares the RAW variant name against the literal lowercase string
`'state=default'` — so a set authored `State=Default` (capitalized, the natural way to
name a Figma variant) never matches, `defaultVariant` comes back null, and every diff
silently comes back empty. Lower-case BOTH sides before comparing the axis name and its
value; never compare a variant name against a literal-cased template.

### No invented default, no invented "main interactive element"

- If no axis value normalizes to `default` (case-insensitively), report
  `defaultVariant: null` **plus the axis values actually found** — never guess a
  stand-in. A caller with `defaultVariant: null` knows to look closer, not to trust a
  silently-wrong pick.
- A prior implementation studied here also picks one "main interactive" child per
  variant (first child with strokes, else first FRAME child) to diff against. That
  heuristic answers differently per component shape and can't be validated generically —
  it was rejected here in favor of a full-subtree diff (§2 step 2) specifically so this
  mistake doesn't get re-added later.
