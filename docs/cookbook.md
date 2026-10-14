# `design-os-figma-plugin` Prompt & CLI Cookbook

Copy-paste recipes for **DESIGN:OS Figma Plugin & CLI** (`skills/es-figma-craft/SKILL.md`).

---

## 1. Generate & Scaffold

> "Inspect the currently selected Figma frame, extract its auto-layout and variable tokens, and build the matching React component."

## 2. Audit & Verify

> "Scan the active Figma file's design system tokens and create a new 1440x900 pricing section frame using our DLS components."

## 3. Export & Automate

> "Update the copy and spacing on the selected hero frame in Figma and export a 2x PNG snapshot to verify visual parity."

---

## 4. CLI & Diagnostic Commands

```bash
# Run deterministic offline self-check
python3 scripts/self_check.py

# Run primary domain verification / workflow
node bin/figma-agent.mjs status --peek

# Run primary CLI command
node bin/figma-agent.mjs status --peek
```
