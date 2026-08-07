# Quality-gate system — executable gates + "no defect escapes twice"

Proven on a real campaign: owner-caught defects went **7 → 0** across 4 waves once this system ran.
The one health metric: **defects the OWNER had to catch. Target → 0.** Owner pointing once = information; twice for the same class = **the process is broken, not the agent.**

## The 4 catch layers (a defect counts against whoever caught it FIRST)

1. **Machine gates** — executable scripts run over a scope (section/page/file), emitting a pass/fail JSON attached to the task report. Missing gates.json = task NOT done.
2. **Agent self-verify** — the 3-layer protocol (verification-protocol.md) during the build itself.
3. **Curator LOOK layer** — a separate reviewer samples PNGs for content-layer defects machines miss (leaked placeholder strings `{Component name}`, error strings in copy, incoherent counts, unreadable chart legends). Every curator catch becomes a new machine gate.
4. **Owner** — the layer that should catch NOTHING twice.

## Gate evolution law (mandatory loop)

A defect that slips past the gates and is caught downstream (curator/owner) triggers ALL of:
1. Fix the defect on canvas.
2. Extend an existing gate or add a new one so the machine catches that class.
3. **Add a NEGATIVE test-case** proving the gate FAILS on that exact defect (a gate without a failing self-test is unproven).
4. Changelog entry + gate-suite version bump.

Build agents that hit an ungated defect class mid-build: **record it in the gate backlog + report — do NOT fix the gate mid-task** (one-agent-one-job). The orchestrator dispatches gate-work before the next build batch.

## Gate honesty rules (gates can lie too)

- **N/A ≠ PASS.** A gate that measured 0 nodes proves nothing — fail-loud, report "not measured".
- **Self-test every suite version** — inject synthetic defects, require the gate to fail on each (e.g. self-test 36/36). A green gate that is blind is worse than red.
- **Scope semantics matter**: a "suite" scope that only reaches ~1% of the file's bound paints proves ~nothing — provide and use a whole-file sweep scope for file-integrity gates; record % coverage.
- **Distinguish gate-gaps from build defects** in the ledger — "the gate lied" is its own defect class with its own fix loop.
- **Read results without flattering the suite**: log what the numbers do NOT prove (unreached scopes, missing negatives, symptom-vs-cause gates).

## Gate classes proven worth building (adapt names per project)

| Gate | Catches |
|---|---|
| Chrome legitimacy | Shell/sidebar/rail lookalikes: verify `mainComponent` set-id (swapComponent keeps node name!), correct VARIANT vs manual override, effective-visibility of convention elements (a `visible=false` inherited from a donor chain is the 2nd failure shape), resolved active/non-active colors |
| Table contract | Cells/heads are instances of the kit table system (any table, incl. mini-tables in cards — no "small table" exemption); styling contract props |
| Literal drift | Bound paints whose stored literal ≠ resolved variable (renderer uses the literal; hex-lints are blind) — whole-file sweep scope |
| Content sanity | Leaked `{placeholder}` tokens, error strings, TODO copy in rendered text |
| Count coherence | Numbers that must agree across a screen (list pill == detail count, All == sum of tabs) |
| Reuse audit | A block repeated in ≥2 page-contents that is not componentized; every create-new declared + justified |
| Construction lints | Spacer frames, raw frames vs auto-layout, detached styles, off-grid spacing/radius |

## Error-harvest loop — runtime errors are FREE defect reports

The bridge logs every script runtime error (design:os: `design/figma-errors.jsonl` — ts, cmd, offending script path, full message). Each entry is a defect report that cost nothing to file. Harvest it:

1. **At wave close (and whenever a session hits ≥2 runtime errors):** read entries since the last harvest cursor; group by error message class.
2. **Classify each class:**
   - **Already documented as a rule but still occurring** → prose failed; add/strengthen a SAFE WRAPPER in script-helpers.md that makes the error *impossible* (e.g. `combineVariantsSafe` appends-then-combines; `setFont` loads-then-sets; `sizing` asserts auto-layout parent before FILL). A rule that keeps firing as a runtime error is an enforcement gap, not a knowledge gap.
   - **New class** → new gotcha entry (right class A–F) + decide: wrapper, checklist item, or gate.
3. **Apply "no defect escapes twice" to the log itself:** the same error class recurring AFTER its wrapper/rule shipped = the wrapper isn't being used — fix the skeleton/checklist so scripts can't skip it, don't re-explain the rule.
4. Record the harvest (classes seen, wrappers added) in the wave report — the log is also the honest measure of how often scripts fail on first run (target: trending to 0 per wave).

Trade-off to keep: a thrown runtime error is STILL better than a silent no-op — never wrap these in try-catch to "reduce errors"; reduce them by construction.

## Convention-DNA extraction (measure the house style — don't dump the file)

Periodically extract the project's *applied* grammar from real built screens: % auto-layout, % token-bound fills, spacing-grid adherence, radius-scale usage, font strays, deprecated-component usage, most-used components per domain. Output = a measured DO/DON'T conventions doc (a per-domain "% bound" table shames the weak areas into priority).

**Plugin-distill-not-MCP-dump discipline:** never dump whole sections via metadata/design-context (one page ≈ 200k+ tokens). Walk-and-aggregate INSIDE the plugin (exec-js) and return only the distilled aggregate (~700 tokens for 9k nodes, ~85× cheaper). The heavy node tree stays in Figma.
