# Changelog (`design-os-figma-plugin`)

All notable changes to `design-os-figma-plugin` are documented in this file.

## [Unreleased]

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
