# Slots — named content holes on a component

`ui.slot.*` (absorption phase-02). Slots are Figma's GA (June 2026) named-content
mechanism: a component exposes a `SLOT` node that an instance can fill with its own
content, distinct from swapping a nested instance. Plugin-API-only — there is no
REST equivalent.

All snippets are `figma-agent exec-js` ready (async body, `ui`/`figma` globals,
`return` a JSON-safe value).

**Maturity gap, verified 2026-07-31 via `npx tsc -p plugin --noEmit`:** the installed
`@figma/plugin-typings` types `SlotNode`, `ComponentNode.createSlot()`, and
`SlotNode.resetSlot()` correctly, but does **not** type
`ComponentPropertyReferences.slotContentId` (only `characters`/`visible`/
`mainComponent` are typed there). This is the exact "Slots maturity conflict" this
phase was scoped around — every read of `slotContentId` in this repo goes through an
explicit untyped cast, commented at the cast site, never assumed to typecheck cleanly
on a future typings bump without re-checking.

---

## 1. Create a slot on a component

```js
return await ui.slot.create('12:34', { name: 'Content', width: 200, height: 80 });
// → { id, name: 'Content', type: 'SLOT', propertyKey, width, height, layoutMode }
```

- `componentId` must be a standalone `COMPONENT`, or a variant **inside** a
  `COMPONENT_SET` — call once per variant, never on the set itself.
- **`createSlot()` takes no name argument** — renaming the returned node IS the
  naming API; a name passed to `ui.slot.create` is applied as a rename immediately
  after. `[re-verify]` — this is the fork's own claim (their code.js:2853-2857,
  live-validated by THEM on 2026-07-09), not independently confirmed on our canvas.
- `layoutMode: 'GRID'` is refused **before** anything is created — no stray SLOT is
  left on the canvas.
- If the open Figma Desktop build predates Slots, `createSlot` is absent as a method
  and the call refuses naming "update Figma Desktop" — kept even though Slots is GA,
  because an old Desktop build is a real user state, not a hypothetical.
- The reply's `propertyKey` is read back from the created node's own
  `componentPropertyReferences.slotContentId` — never synthesised. `null` means the
  link genuinely isn't there yet, not a tool bug.

## 2. List slots on a component, instance, or component set

```js
return await ui.slot.list('12:34');
// → { nodeId, nodeType, slots: [{id, name, propertyKey, ...}], count }
```

- Works on `COMPONENT`, `INSTANCE`, or `COMPONENT_SET`.
- On a `COMPONENT_SET`: **one SLOT node exists per variant**, all pointing at the
  same underlying property. The reply groups them, tagging each with `variantId` +
  `variantName` so a caller can tell which physical node belongs to which variant —
  never a single ambiguous entry standing in for all of them.
- `componentPropertyDefinitions` throws when read directly on a variant `COMPONENT`
  (only a non-variant `COMPONENT` or a `COMPONENT_SET` exposes it) — `list` applies
  that as a real type predicate rather than swallowing the throw, because a
  swallowed throw and "genuinely no slots" would otherwise look identical.

## 3. Fill a slot

```js
// Clone an existing node in (default):
return await ui.slot.append({ slotId: 'S:1' }, { sourceNodeId: '5:6' });
// Move instead of clone:
await ui.slot.append({ slotId: 'S:1' }, { sourceNodeId: '5:6', clone: false });
// Create new content directly (RECTANGLE / FRAME / TEXT only — see below):
await ui.slot.append({ slotId: 'S:1' }, { nodeType: 'TEXT', props: { text: 'Hello' } });
```

- **A raw `COMPONENT` cannot be appended** — cloning a `ComponentNode` produces
  another `ComponentNode`, so the refusal fires *before* any clone happens; no
  orphan main component is ever left behind. Create an `INSTANCE` first, or clone
  an existing instance, and append that instead.
- `content.nodeType` supports **RECTANGLE, FRAME, TEXT only** — reduced scope versus
  the fork's full eight-type set (also ELLIPSE/LINE/POLYGON/STAR/VECTOR).
  Deliberate, reported: the common case and this repo's mock both cover these
  three; the rest are a mechanical follow-up if a real task needs them.
- `opts.clearExisting` runs **only after** the content resolves — a bad
  `sourceNodeId` leaves existing children untouched and errors, rather than
  emptying the slot first and then failing (the fork's earlier version did the
  latter).
- A cloned node keeps its old `x`/`y`; in a `NONE`-layout slot this can render it
  invisible outside the visible frame, so it is snapped to `0,0`. An auto-layout
  slot is left to Figma's own positioning. `[re-verify]` — ours; the fork's fix was
  live-validated by them only.

## 4. Resolve a slot by instance + name

```js
return await ui.slot.reset({ instanceId: '7:8', slotName: 'Content' });
```

Both `append` and `reset` accept either `{ slotId }` directly or
`{ instanceId, slotName }`. The name-resolution walk is **stricter than the fork**:

- Prefer a **direct** child SLOT of the instance matching the name.
- **Two or more direct matches throw as ambiguous**, listing the ids — this repo
  never silently takes the first match. (The fork's own
  `findAllWithCriteria({types:['SLOT']})` walk also finds slots nested inside child
  instances and, on a name collision, would pick `[0]`; `byPath`'s existing
  ambiguous-sibling rule is the precedent this deliberately matches instead.)
- No match at all names the available slot names found, so the caller can correct
  the name without a second round trip.

## 5. Reset a slot to its default content

```js
return await ui.slot.reset({ slotId: 'S:1' });
// → { slot: { id, name, childCount: 0 } }
```

Checks `typeof node.resetSlot === 'function'` first and refuses naming "update
Figma Desktop" if absent — same host-version defensiveness as `create`.

## 6. Bind an existing frame as slot content manually

```js
return await ui.slot.addProperty('12:34', 'Content', '5:9', { description: 'Main content' });
// → { propertyKey, frameId, frameName }
```

Alternative to `create` + `append` for wiring an **already-existing** frame as a
component's slot content, adapted from the fork's manual SLOT-property path.

- `frameNodeId` must be a `FRAME` that is a **direct child** of the component, or of
  one of a `COMPONENT_SET`'s variant components.
- `frame.componentPropertyReferences` is **merged, never assigned** — a fresh object
  would wipe an existing binding on the same frame (e.g. a `BOOLEAN` property
  already driving `visible`).
- GRID-layout frames are refused.
- A frame **nested inside another slot** is refused with that specific diagnosis —
  the fork's own tool description claims this check exists, but its code never
  implements it. This repo enforces it for real, walking the frame's ancestors up
  to (not including) the component/set looking for a `SLOT` type. This check runs
  **before** the generic "must be a direct child" check, since a frame nested
  inside a slot is technically also "not a direct child" — the specific diagnosis
  is more actionable than the generic one.

## Open questions — `[re-verify]` on a live canvas

- Whether `ui.setProps` (instance-property writer) can detect that a caller is
  trying to set a `SLOT`-typed property key and say so explicitly, rather than just
  failing the generic "property not found" path. Not yet probed.
- Whether `SlotNode.resize()` behaves the same before vs. after the slot node is
  parented, across Desktop versions — assumed yes, not independently measured.
