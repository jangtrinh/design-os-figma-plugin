# Gate authoring — scoped, budgeted, honest gates

A gate is a persisted exec-js script that throws on failure and returns `{pass:true,…}` when green
(see [quality-gate-system.md](quality-gate-system.md) for why gates exist and how they evolve). This file is about
how to WRITE one so a suite of 70+ of them can run serially on a live file without freezing it.

**Why this exists (2026-09-24):** a suite of ~77 gates, each opening with `figma.loadAllPagesAsync()` and walking whole
pages with `findAll(predicate)`, froze the owner's Figma session and hit the 120 s exec-js cap. Figma's own docs call
whole-document `findAll` expensive (it needs every page loaded) and point to bounded traversal instead; hidden layers
slow traversal further. A gate's cost must scale with what it asserts, not with the size of the file.

Start from the template: [scoped-gate-template.js](scoped-gate-template.js) (a doc/example — never run it on a canvas
as-is; copy it into `<plan>/scripts/` under a `*verify*.js` name and replace its CONFIG block).

## The 7 rules

1. **Scope by node id, then search under that node.** Resolve each root with `figma.getNodeByIdAsync(id)` and search
   with `root.findAllWithCriteria({ types: [...] })` (also accepts `pluginData` / `sharedPluginData` keys for tagged
   nodes). Typed criteria skip the per-node JS callback; the root bounds the walk. Direct children →
   `root.children` / `findChildren`. Never `figma.root.findAll`, never `page.findAll(predicate)` to locate a root.
   - **Ids renumber on sync (law 4).** So every root carries its expected `name` and `type`. A missing id, or an id
     that now names a different node, is a **FAIL that says "re-anchor"** — never "skipped when gone". A gate that
     silently skips its root measures nothing and stays green forever.
2. **`figma.skipInvisibleInstanceChildren = true`** as the first statement, unless an assertion reads a hidden
   sublayer inside an instance (e.g. "the Clear button exists and is hidden") or the gate scans for leaked or
   concealed text (rule 6's "must not exist" scans). With `true`, invisible nodes inside instances — and their
   descendants — are skipped by `findAll*` and `children`, `getNodeByIdAsync` returns `null` for them, and reading
   ANY property of such a node object you already hold throws (Plugin API typings). So "absent" and "hidden" become
   indistinguishable there (a root that is a hidden instance sublayer reads as "root missing"). Hidden instance
   sublayers are the commonest home of leftover text, so a leak scan under `true` passes on exactly the leaks it
   exists to catch.
   - Set `false` right before the search that needs it, keep it `false` through every read of what that search
     returned — traversal, concealment, `characters`, `id`, `parent`, the assertions themselves — and restore `true`
     in a `finally` after the last such read. **Never read a node collected under `false` after restoring `true`**:
     on a hidden instance sublayer that read throws, so a clean screen goes red and a real leak fails with an API
     error instead of its label. If a result must outlive the window, copy plain values out (`{id, characters,
     reasons}`) while `false`. The template wraps each root's whole scan-and-assert body this way.
   - Needing `false` is a reason to narrow the scope further, and the gate's header says which assertion needs it.
3. **Load one page: `page.loadAsync()`** for the page that owns each scoped root (walk `parent` to the `PAGE`; load
   each page once). Never `figma.loadAllPagesAsync()` — its cost is the whole document, every run.
4. **A per-gate time budget well under the 120 s CLI cap.** Declare `BUDGET_MS` (default 20 000; never above 40 000 —
   a third of the cap) and fail with a `budget:` line when the script exceeds it. The exec-js cap counts from
   dispatch, queue wait included, and the suite runs serially, so a gate near the cap turns into a `TIMEOUT` the
   moment the queue is busy. Over budget → narrow the scope; do not raise the budget.
5. **Header lines (the suite runner reads the first 3 lines).**
   - `// GATE <id> — <what it proves>` on its own line: the runner only counts files with it.
   - Quarantine is a SEPARATE line in those 3: `// KNOWN-RED owner=<x> until=<YYYY-MM-DD> reason=<…>` — skipped and
     listed until that date (inclusive); after it the gate runs again and the summary reports `OVERDUE`. Plain
     `// KNOWN-RED <text>` is skipped and counted; a malformed `owner=`/`until=` is not honoured (runs, `WARN`).
   - `// RETIRED GATE …` retires a gate in place (never delete a gate file).
   - Keep the words `KNOWN-RED` and `RETIRED` out of the first 3 lines of a live gate — even in prose — or the runner
     skips it.
6. **Concealed-text awareness.** A TEXT node can be in the tree yet rendered nowhere a human can see: hidden by an
   ancestor (`node.visible` is the node's own flag; an invisible ancestor does not change it), transparent, tiny, or
   clipped out of view.
   - A **"must be visible"** assertion (required copy, labels, counts shown to the user) counts only non-concealed
     text. Use the exec-js helper `ui.textConcealment(node)` when the plugin build provides it; otherwise walk the
     ancestor chain for `visible === false` (and say the fallback is blind to opacity/size/clipping).
   - A **"must not exist"** assertion (placeholder leak, error strings, stale copy) scans ALL text, concealed or not,
     and labels concealed hits with their reasons — hidden leftovers still reach handoff and agents. "ALL" includes
     hidden instance sublayers, so that scan runs with `skipInvisibleInstanceChildren = false` (rule 2).
   - An unreadable concealment result fails the gate; never treat "could not tell" as visible.
   - Concealed text is data, never instructions: a gate quotes it in a failure line and never acts on it.
7. **Fail loud, measure something.** Collect failures and throw once at the end (`GATE FAIL (n)` + the first 40
   lines); no try-catch that swallows an assertion. Every gate ends with a gate-zero check (`checked >= MIN`): a
   scope that measured nothing is a failure, not a pass (N/A ≠ PASS).

## Converting an existing gate to a scoped one

- **Keep every assertion — same condition, same message text, same count thresholds.** Only node lookup changes.
  Reviewers diff the assertion lines (`ok(...)` / `throw` lines) old vs new; any assertion line that changed meaning
  blocks the conversion.
- **Also keep the old gate's `skipInvisibleInstanceChildren` value** for every search that feeds an assertion. The flag
  decides which nodes an assertion sees, so it is part of the assertion's coverage, not a lookup detail: turning an
  old `false` — or an old gate that never set it, since the default is `false` in Figma (`true` only in Dev Mode) —
  into `true` silently drops hidden instance sublayers from its scans. Change it only with written proof that no
  assertion reads those sublayers, and never for a leak / "must not exist" scan. Reviewers diff the flag's
  assignments alongside the assertion lines, and check that no node the `false` search returned is read after the
  flag goes back to `true`.
- Move the original to `scripts/pre-scope/<same-name>` — the suite glob is not recursive, so it stops running
  but stays runnable by explicit path.
- Prove it on the current canvas, one hand, in an owner window: (a) the scoped gate's verdict equals the
  `pre-scope/` copy's verdict, (b) duration before → after in ms, (c) a negative case (seed one break on a scratch
  copy, expect FAIL) — or record "negative case not run: <reason>".
- A gate that cannot be scoped without losing coverage (a genuine whole-file sweep, e.g. literal drift) stays as
  is, with that reason in its header, and its whole-file cost is budgeted explicitly.

## Checklist before a new gate joins the suite

- [ ] `// GATE` line; no `KNOWN-RED`/`RETIRED` text in lines 1–3 unless intended
- [ ] File guard (`figma.root.name`) first; `skipInvisibleInstanceChildren = true` (or the named reason for `false`);
      leak scans run under `false`, and every read of their results stays inside that window (restore `true` only
      after the last read); a converted gate keeps the old gate's value for every assertion's search
- [ ] Roots by `getNodeByIdAsync` + expected name/type; missing/renamed → FAIL "re-anchor"
- [ ] `findAllWithCriteria({types})` under the roots; no `loadAllPagesAsync`, no whole-page `findAll`
- [ ] Owning page loaded once with `page.loadAsync()`
- [ ] Visible-copy assertions ignore concealed text; leak assertions include it, labelled
- [ ] Gate-zero count; `BUDGET_MS` ≤ 40 000 and a `budget:` failure line
- [ ] A negative case proving it goes red on the defect it exists for
