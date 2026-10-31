# Contributing to `design-os-figma-plugin`

Thank you for contributing to **DESIGN:OS Figma Plugin & CLI** (`DESIGN:OS`).

## Verification Gate Before Submitting a PR

Every pull request must pass the local self-check and repository test suite before merge:

```bash
python3 scripts/self_check.py
node bin/figma-agent.mjs status --peek
```

## Guidelines

1. **Zero Telemetry**: Never introduce external network calls, analytics, or unpinned runtime dependencies.
2. **Progressive Context Disclosure**: Keep `skills/design-os-figma-craft/SKILL.md` concise (~150 lines) and place detailed recipes in `docs/cookbook.md`.
3. **Conventional Commits**: Use `feat:`, `fix:`, `docs:`, or `chore:` commit prefixes.
