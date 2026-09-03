// The skill's own prose — everything in skills/figma-agent/SKILL.md that is
// NOT the command reference (that section is rendered separately from
// command-catalog.ts by skill-emitter.ts). Pure data, no fs, no catalog import.

export const SKILL_DESCRIPTION =
  'figma-agent — the CLI bridge to the Figma file already open in the designer\'s Figma '
  + 'desktop app, over a local WebSocket broker. SessionStart MAY have already run figma-agent '
  + 'status --peek and left its result in context (only if the optional install-hook was set '
  + 'up) — if no peek result is visible, run figma-agent status --peek first. When it reports '
  + 'a live connection, use THIS skill — not the DesignAgent MCP or any other Figma bridge — '
  + 'for every request to inspect, read, edit, or check the status of that open file: '
  + 'selection, nodes, layers, styles, components, variables, frames, screenshots, or making '
  + 'changes to the canvas. Read connection state, then read/write the open Figma document '
  + 'without the paid official write MCP.';

export const SKILL_INTRO = `# figma-agent

A thin CLI that talks to the Figma plugin "Ease Design Figma Agent" through a local
broker (127.0.0.1, ports 9410-9419). One command per invocation; every command prints
exactly one JSON object to stdout and exits 0, or \`{error:{code,message}}\` and exits 1.`;

export const SKILL_CONNECT_PROTOCOL = `## Connect protocol

1. Check state cheaply first: \`figma-agent status --peek\`. This never spawns a broker —
   it only reads the \`/tmp\` broker advertisement and, if one is live, asks it one short
   question. Idle (no broker, or the plugin not open) is a normal, non-error answer.
2. Only run a real command (\`status\`, \`connect\`, \`create-frame\`, ...) once you need to
   act — those DO start a broker on demand if none is running.
3. \`status --peek\`'s \`versionMatch\`/\`protocolMatch\` fields tell you whether the
   connected plugin build matches this CLI. \`null\` means the plugin didn't report a
   version (an older bundle) — treat that as unknown, not as a mismatch. Plain \`status\`
   does not compute these fields itself — read them from \`--peek\`.
4. If nothing is connected, the human's remaining step is opening the plugin panel in
   Figma desktop — this CLI cannot do that for them.`;

export const SKILL_WORKFLOW = `## Typical workflow

1. \`figma-agent status --peek\` — is anything alive, and does it match this CLI build.
2. \`figma-agent status\` — full detail on the active connection (spawns a broker if idle).
3. Read before you write: \`get-selection\`, \`inspect\`, \`scan-design-system\`. Resolve a
   component by name with \`resolve-component --name "<n>"\` — it returns exactly one node
   or refuses (E_AMBIGUOUS lists the duplicates; pass \`--page\` or use an id).
4. Mutate with the typed commands (\`create-frame\`, \`set-text\`, \`clone-traits\`, ...)
   before falling back to \`exec-js\` for anything they don't cover. Every mutating
   command first waits (up to 60s) for the plugin to register, so the first call after
   an idle flap no longer needs a \`status --wait &&\` prefix — \`--no-wait\` opts out.
5. \`changes\`/\`errors\`/\`contention\` read durable local logs — they work even with the
   plugin closed, useful for catching up after a session gap.`;

export const SKILL_ERROR_HINTS = `## Error hints

- \`E_NO_BROKER\` — no broker answered; the plugin almost certainly isn't open. Peek first
  next time, don't assume.
- \`E_NO_PLUGIN\` — the broker is alive but no Figma file is connected right now. A
  mutating command already waited its 60s bound for one before saying so — retrying at
  once will not help; the human must open the plugin panel in the target file.
- \`E_WRONG_FILE\` — a command named \`--file\`/\`--instance\` and the plugin currently
  answering doesn't match; open the right file, or drop the filter to see what IS live.
- \`E_TIMEOUT\` (with a \`jobId\`) — the command is still running as a background job; poll
  it with \`figma-agent job <jobId> --wait\` instead of re-issuing the same command.
- \`E_VERSION_MISMATCH\` — the broker speaks a different protocol version than this CLI;
  rebuild/reinstall one side.`;
