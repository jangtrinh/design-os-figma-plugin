# Changelog (`design-os-figma-plugin`)

All notable changes to `design-os-figma-plugin` are documented in this file.

## [Unreleased]

### Changed
- Renamed the bundled skills with the `design-os-` prefix: `skills/figma-agent` is now `skills/design-os-figma-agent` and `skills/es-figma-craft` (`es:figma-craft`) is now `skills/design-os-figma-craft`. The `figma-agent` CLI binary keeps its name. `figma-agent install-skill` now writes to `design-os-figma-agent/`; an older `figma-agent/` folder from a previous install is left in place and can be deleted by hand.

## [1.0.0] - 2026-10-14

### Added
- Standardized **AI-Ready Repository Delivery Package** (`.claude-plugin`, `.codex-plugin`, `.agents/plugins`, `.factory-plugin`).
- Added `/doctor` diagnostic command (`commands/doctor.md`, `prompts/doctor.md`) and offline `scripts/self_check.py`.
- Added 12-Section Editorial `README.md`, `PRIVACY.md`, `docs/cookbook.md`, and 13-engine `DESIGN:OS` ecosystem cross-links.
