# Annotations — dev-mode notes pinned to nodes

`ui.annotate.*` (absorption phase-02). Figma Annotations attach a label plus
optional property callouts (e.g. "this fill is bound to `color/brand`") to a node,
visible in Dev Mode. Read/write via `node.annotations`; categories come from
`figma.annotations.getAnnotationCategoriesAsync()`.

All snippets are `figma-agent exec-js` ready (async body, `ui`/`figma` globals,
`return` a JSON-safe value).

---

## 1. Read a node's annotations

```js
return await ui.annotate.get('12:34');
// → { nodeId, nodeName, nodeType, annotations: [...], annotationCount,
//     availableCategories: [{id,name}] }
```

- `'annotations' in node` **is** the capability test — a node type that doesn't
  expose the field (e.g. a `PAGE`) is refused naming its type, rather than
  returning an empty list that looks identical to "checked, found none".
- Each annotation entry reports `categoryName` resolved from `categoryId` via
  `availableCategories`; a `categoryId` with no matching category reports
  `categoryName: null` — **never** the raw id echoed back as if it were a name.

## 2. Walk children too

```js
return await ui.annotate.get('12:34', { includeChildren: true, depth: 2 });
// → adds children: [{nodeId,nodeName,nodeType,annotations}], childAnnotationCount,
//   skippedChildren
```

- `depth` bounds how far the walk descends (default `1`).
- Some descendants (slot sublayers, table cells) **throw** on property access.
  These are skipped, but the skip is **counted** in `skippedChildren` — a silent
  skip is exactly how "no annotations found" becomes a lie about a node the tool
  never actually managed to read. This counting is this repo's own addition, not
  the fork's.

## 3. List annotation categories

```js
return await ui.annotate.categories();
// → { categories: [{id, name}] }
```

Wraps `figma.annotations.getAnnotationCategoriesAsync()`. The host's field is
`.label`; this repo's own output shape calls it `.name` for consistency with every
other `{id,name}` pair elsewhere in this stdlib (this is a repo naming choice, not
a claim about the ambient type — the raw `AnnotationCategory` type itself exposes
`.label`, confirmed via `npx tsc -p plugin --noEmit`, correcting an assumption this
file's own first draft made based on reading the fork's code).

## 4. Set annotations

```js
await ui.annotate.set('12:34', [
  { label: 'Bound to design token', properties: [{ type: 'fills' }] },
], { mode: 'replace' });      // default
await ui.annotate.set('12:34', [{ label: 'Extra note' }], { mode: 'append' });
```

- **Property types are a closed, 32-value vocabulary** (`width` … `gridColumnSpan`,
  from `@figma/plugin-typings`'s `AnnotationProperty`). An invalid value throws
  naming it plus the nearest valid ones by edit distance — never a silent drop of
  the bad entry.
- **`replace` mode** (default) overwrites whatever annotations existed.
- **`append` mode** keeps existing annotations and adds the new ones — but Figma
  auto-populates **both** `label` and `labelMarkdown` on read while rejecting a
  write that sets both. An append that copies an existing annotation forward must
  therefore prefer `labelMarkdown` and drop `label` when the stored entry carries
  both, or the write itself fails. This is the single fact most likely to make a
  naive append implementation break, and it has its own dedicated test
  (`tests/exec-stdlib-annotate.test.ts`) using a fake node whose stored annotation
  carries both fields.
- **Clearing all annotations is `set(nodeId, [])`** — there is no separate "clear"
  call; this is not obvious from the signature alone, so it's stated here
  explicitly.
- The reply's `annotations` and `annotationCount` are the **read-back** result, not
  an echo of the input — a write that silently drops or reorders would otherwise be
  invisible to the caller. A read-back count mismatch throws `E_EVAL` naming both
  numbers.

## Open questions — `[re-verify]` on a live canvas

- None specific to annotations beyond the general "does this repo's mock match live
  Figma" caveat that applies to every recipe here — annotations facts 1-6 above are
  all either enforced in code with a direct fork-line citation, or (fact 2, the
  label/labelMarkdown merge) implemented from the fork's own comment without an
  independent live confirmation of the *rejects-both* claim.
