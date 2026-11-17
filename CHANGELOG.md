# Changelog (`design-os-figma-plugin`)

All notable changes to `design-os-figma-plugin` are documented in this file.

## [Unreleased]

## [0.3.0] - 2026-11-16

### Added
- Extended `figma-agent scan-design-system` with additive component and screen-frame sensing (`boundVariables`, direct `instances` counts, `unresolvedInstances`, page/section `frames[]`, and `sensing` status) under an isolated time budget that never fails the base scan.
- Added the DESIGN:OS repository logo and multi-resolution site favicons across `docs/`.

### Security
- Isolated HTML extraction inside an opaque `sandbox="allow-scripts"` child iframe, enforcing parent message sources, active-child request correlation, and schema validation before scene import.
- Isolated ShaderGradient rendering inside an opaque `sandbox="allow-scripts"` child iframe and validated PNG dimensions, byte bounds, canonical base64, and PNG signature prior to scene admission.

## [0.2.2] - 2026-11-16

### Added
- Subscribed `documentchange` immediately after `loadAllPagesAsync` before the boot gap-fill walk, deduplicating live-captured node IDs against the post-walk diff with an explicit `gapfill.dedupedLiveEdits` counter and surfacing `gapfill.pagesWalked` and `gapfill.bootPaused` in `status`.
- Added durable process-identity reconcile leases (`reconcile-lease.ts`) to prevent surviving `reconcile --apply` children from overlapping across broker restarts, with graceful shutdown cancellation and evidence-based dry-run recovery.
- Forwarded CLI `SIGINT`/`SIGTERM` cancellations for queued `exec-js` jobs over the broker socket and exposed advertised plugin capabilities (`plugins[].caps`) in `figma-agent status`.

### Fixed
- Bounded `scan-node` child processes in mirror capture (`MIRROR_SCAN_CHILD_BOUNDS`), capped disconnect-log job/queue snapshots with omission counters, hardened log rotation against symlinks, and validated `exec-js --timeout` values before dispatch.
- Updated the plugin relaunch label to `"Reconnect DESIGN:OS Bridge"`, rejected empty `concealed.reasons` arrays in payload validation, aligned `docs/deep-dive.md` with current CLI/safety contracts, and hardened test-suite live-broker isolation and child/daemon timing fixtures.

## [0.2.1] - 2026-11-16

### Changed
- Enabled `exactOptionalPropertyTypes` across the entire repository and `noUncheckedIndexedAccess` across all production targets (`shared/`, `cli/`, `plugin/`), eliminating implicit `undefined` key serialization on wire payloads and unguarded array/dictionary accesses in the Figma sandbox and CLI.
- Consolidated CLI and Figma plugin version strings into a single shared constant (`shared/version.ts`), added a parallel Go-native compiler runner (`scripts/typecheck.mjs`), normalized all relative `.ts` import specifiers for native Node TypeScript compatibility, and shrank retired entries from the comment-hygiene baseline.

## [0.2.0] - 2026-11-16

### Changed
- Renamed the bundled skills with the `design-os-` prefix: `skills/figma-agent` is now `skills/design-os-figma-agent` and `skills/es-figma-craft` (`es:figma-craft`) is now `skills/design-os-figma-craft`. The `figma-agent` CLI binary keeps its name. `figma-agent install-skill` now writes to `design-os-figma-agent/`; an older `figma-agent/` folder from a previous install is left in place and can be deleted by hand.
- Upgraded the TypeScript toolchain to TypeScript 7 (`^7.0.2` native Go compiler) with shared strictness defaults (`verbatimModuleSyntax`, `erasableSyntaxOnly`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `noUncheckedSideEffectImports`), isolated `DOM` vs Figma sandbox configs across `plugin/` and `tests/`, and full test-suite typechecking.

## [1.0.0] - 2026-10-14

### Added
- Standardized **AI-Ready Repository Delivery Package** (`.claude-plugin`, `.codex-plugin`, `.agents/plugins`, `.factory-plugin`).
- Added `/doctor` diagnostic command (`commands/doctor.md`, `prompts/doctor.md`) and offline `scripts/self_check.py`.
- Added 12-Section Editorial `README.md`, `PRIVACY.md`, `docs/cookbook.md`, and 13-engine `DESIGN:OS` ecosystem cross-links.
