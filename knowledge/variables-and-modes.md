# Variables & modes — lifecycle over exec-js

`ui.vars.*` (absorption phase-01, Basket B) covers the variable/mode operations the
typed wire commands don't: rename, remove, describe, and per-mode add/rename/remove/set.
Every helper here is **verified** — it re-reads what it wrote and throws `E_EVAL` if the
canvas disagrees, never a "success" that didn't actually take.

All snippets are `figma-agent exec-js` ready (async body, `ui` global, `return` a
JSON-safe value). Companion: `knowledge/figma-craft/components-variables-styles.md`
§3 (creation, tiers, binding) — this file is the lifecycle/mode side, not a duplicate.

---

## 1. Rename, describe, remove

```js
// Rename — ref is a VariableID: or an exact name.
return await ui.vars.rename('color/old-name', 'color/new-name');
// → { id, name: 'color/new-name', oldName: 'color/old-name' }

// Describe — documents intent inline; shows in the Figma variables panel.
return await ui.vars.describe('color/brand', 'Primary brand color, WCAG AA on white');
// → { id, name, description }

// Remove.
return await ui.vars.remove('color/dead-token');
// → { id, name, boundReferencesChecked: false }
```

- **`remove` never claims a bound-reference count it cannot back.** `figma.currentPage
  .findAll` is page-scoped — a file-wide total built from it would silently under-report
  on a multi-page file. Rather than lie with a number, `boundReferencesChecked` stays
  `false` and no count is returned at all. `es-debt: page-scoped reference counting
  omitted, not faked. Upgrade trigger: a real task needs the count, or a file-wide
  bound-reference reader lands.`
- `[re-verify]`: whether `Variable.remove()` leaves dangling `boundVariables` entries on
  nodes that referenced it. Figma's own docs don't say; confirm on a real canvas before
  relying on "removing a variable also clears every bind" as a fact.
- Provenance: https://developers.figma.com/docs/plugins/api/figma-variables/

## 2. Modes — add, rename, remove, set a value

```js
const col = (await figma.variables.getLocalVariableCollectionsAsync())
  .find(c => c.name === 'Tokens');

return await ui.vars.addMode(col.id, 'Dark');
// → { collectionId, name, modes: [{modeId, name}, ...] }  — the FULL list read back,
//   never just the caller's echoed name.

return await ui.vars.renameMode(col.id, col.modes[0].modeId, 'Light');
// → { collectionId, modes, oldName: 'Mode 1' }

return await ui.vars.removeMode(col.id, darkModeId);
// → { collectionId, modes }  — throws if that would remove the LAST mode (Figma
//   itself refuses that); the message names the modes that remain.

return await ui.vars.setModeValue('color/bg/surface', 'Dark', { r: 0.1, g: 0.1, b: 0.1, a: 1 });
// → { id, name, mode: {modeId, name}, value }
```

- **`setModeValue` throws on an unknown mode name**, naming the modes that do exist —
  the deliberate opposite of a bug this same phase fixed in the typed
  `CREATE_VARIABLE --mode` command: that command used to silently set nothing and
  report success when the mode name didn't match. Both now agree: a bad mode name is
  always an error, never a quiet no-op.
- **Free-plan mode caps are a thrown Figma error, not a warning** — `addMode` lets it
  through (`in addMode: Limited to N modes only`) rather than swallowing it. That
  swallow is correct for *token import* (`createVariablesFromTokens` in
  `executor-variables.ts` intentionally does this so one blocked variable doesn't abort
  a whole import) and wrong here, where the caller asked for this exact mode and needs
  to know it didn't happen.
- Mode limits, current as of Schema 2025: Starter 1 · Professional 10 · Organization 20
  · Enterprise 40. Treat the exact number as plan- **and** date-dependent — the
  authoritative check is the thrown message, not a memorized constant (see
  `components-variables-styles.md` §3.1 for the full citation).

## 3. The `--undo-group` caveat

Every `ui.vars.*` call runs inside `exec-js`, which is a mutating command
(`shared/mutating-commands.ts`) — each run seals its own undo step. Wrapping a script in
`--undo-group` (`plugin/src/main/executor-exec-js.ts`) gives ONE revertible bracket over
everything the script does, but the script itself must **never call
`figma.commitUndo()`/`triggerUndo()`** — that's the bracket's own job, and a script that
does it anyway breaks the sentinel the bracket uses to detect an empty run.

```
figma-agent exec-js --code '...builds several modes and variables...' --undo-group
```

If the script throws partway through, `--undo-group` rolls back **everything** it did —
there is no need for (and `ui.componentSet`, this phase's other addition, deliberately
does not add) hand-rolled per-object rollback bookkeeping on top of that bracket.
