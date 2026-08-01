# CLAUDE.md — design-os-figma-plugin

Guidance for agents working in this repository (the Figma plugin + agent bridge of DESIGN:OS,
extracted from jangtrinh/design-os).

## Task workflow (GitHub Projects driven)

Work is planned on the project board: https://github.com/users/jangtrinh/projects/2 — one
GitHub issue = one Sonnet-ready task. The standard lifecycle, using installed ak-* skills:

1. **Pick up**: claim an issue from the board (Status → In Progress).
2. **Plan**: `/ak:issue-to-plan <issue-url>` — reads the issue, scouts this codebase, runs the
   brainstorm gate + red-team, produces the validated plan branch. Specs referenced by issues
   may live in the monorepo's `plans/` (paths are cited in the issue body).
3. **Implement**: test-first, in an isolated worktree for parallel work (`/ak:worktree`).
   Deviations from the plan get reported up, never improvised.
4. **Ship**: `/ak:ship` from the feature branch — merge-main, test, review, commit, push, PR.
5. **Review**: `/ak:review-pr <pr> --reply` — the stage-4 adversarial review posts back to
   GitHub as a formal PR review. REQUEST_CHANGES loops back to step 3; findings are fixed
   test-first (each fix's test must fail against the pre-fix code).
6. **Audit + merge**: final audit gate confirms direction + gates, then merge. Issue → Done.

## Gates (all must pass before any PR)

- `npm run typecheck` · `npm run build` · `npm test` (includes the panel gate,
  `tests/figma-plugin-panel.test.ts`, which needs `git submodule update --init --depth 1`).
- `npm run lint:comments` — fails on a NEW ephemeral work-tracking ref (a GH issue/PR
  number, a dated plan-dir slug, or a bare finding/audit label) in a tracked comment or
  test name under `plugin/src`, `cli/src`, `shared`, `tests`. It deliberately ALLOWS this
  repo's durable design-doc narrative — a committed `spec-NNN` citation, a roadmap
  wave/backlog section, a review round, a phase name — since those point at documents
  that live in the repo's own history, not an external tracker. Pre-existing ephemeral
  refs are grandfathered in `scripts/comment-hygiene-baseline.json` (content-keyed, not
  line-keyed, so unrelated edits never invalidate it); a genuinely new citation anywhere
  — including one added right next to an existing one — still fails. Run
  `npm run lint:comments:update-baseline` only when deliberately retiring an old citation by
  restating its invariant directly (never to launder a new one through).
- The panel gate runs the kernel's own linters from the pinned `kernel/design-os` submodule —
  a bridge until `ease-design/lint` is published (issue #9). Bump the pin deliberately.

## House rules (carried from the design-os studio)

- **Nothing vanishes silently.** Every eviction, prune, rotation, or drop leaves a counter,
  an archive, or an audit record. A wrong fact is worse than an absent one.
- **Honest reporting.** Panel/CLI output never fabricates — a name appears only when the
  reply carried one, a count only when one parsed.
- **One mutation per file.** Mutations are jobs in a per-file FIFO; read-only traffic
  declares itself and bypasses. Every mutating command states its undo-bracket behavior.
- **Respect the project's own artifacts.** Never overwrite a file the target project
  generates itself (see the foreign-registry yield pattern).
- **Test-first for behavior changes**; a mock must encode the external API's refusals, not
  just its happy path (Figma's dynamic-page getters throw; permissive mocks are green lights
  that mean nothing).
- **Count before you target** — a headline number in an issue is a hypothesis; measure on
  real data before optimizing or capping.
- Conventional commits, no AI references in commit messages or PR bodies.
- The deterministic broker/CLI stays model-free: pure transforms, no network beyond the
  loopback WS, no LLM calls.

## Layout

- `cli/` — figma-agent CLI + broker (job table, per-file queues, binding index, feeds).
- `plugin/` — Figma plugin (main-thread executors + panel UI). `plugin/code.js` and
  `plugin/ui.html` are committed build outputs the manifest loads.
- `shared/` — protocol, edit-feed schema, mutating-command classification.
- `tests/` — the full suite (900+); daemon-harness tests cover the broker seams pure unit
  tests cannot see.
- `kernel/design-os` — pinned submodule (panel-gate linters only; see issue #9).

The studio this belongs to: https://github.com/jangtrinh/design-os
