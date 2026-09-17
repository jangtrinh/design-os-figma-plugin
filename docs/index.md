---
title: Figma plugin + CLI for AI agents (Claude Code, Codex, any shell agent)
description: Free Figma plugin + CLI so Claude Code, Codex or any shell agent can read and edit the Figma file you have open. Local WebSocket, one undo step per mutation, no seat.
---

# design-os-figma-plugin

Let your AI agent inspect and edit Figma while you keep designing.

A free Figma plugin and a `figma-agent` CLI for Claude Code, Codex, Cursor, or any agent that can run a shell command. It uses the Public Plugin API on Figma Free: no paid seat, no access token, no cloud service. A local broker on `127.0.0.1` routes CLI requests to the plugin imported in Figma Desktop; the CLI and broker never call a model.

<p align="center">
  <img src="images/agent-rail-single-row.gif" width="560" alt="The figma-agent panel showing current activity, pending-sync badge, and sync result">
</p>

## What you get

- **Write to the canvas on Figma Free**, without the Full seat that write-to-canvas through Figma's official MCP server requires.
- **One undo step per mutation**, and every mutation is a job in a per-file queue with an id: a timeout gives you something to poll, never a blind retry.
- **Your own edits come back** as one reviewable sync, including edits made while the panel was closed.
- **A per-file kill switch** that pauses agent writes while reads and your own editing continue.
- **Measured on a 21-page, 418k-node production file**: 44 ms worst stall at open, idle re-index in 0.75 s slices.

## Read next

- [README: install, first safe use, and the comparison with Figma's MCP and community bridges](https://github.com/jangtrinh/design-os-figma-plugin#readme)
- [Deep dive: the evidence behind each promise](deep-dive.md)
- [Operations and troubleshooting](operations.md)
- [Working from more than one computer](multi-machine-setup.md)
- [Live-canvas verification checklist](live-canvas-checklist.md)
- [Full command reference](https://github.com/jangtrinh/design-os-figma-plugin/blob/main/skills/figma-agent/SKILL.md)

```bash
git clone https://github.com/jangtrinh/design-os-figma-plugin.git
cd design-os-figma-plugin
npm ci
npm run build
```

Then in Figma Desktop: **Plugins → Development → Import plugin from manifest…** and pick `plugin/manifest.json`.

MIT licensed. Part of [DESIGN:OS](https://github.com/jangtrinh/design-os).
