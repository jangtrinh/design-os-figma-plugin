// The skill's own prose — everything in skills/figma-agent/SKILL.md that is
// NOT the command reference (that section is rendered separately from
// command-catalog.ts by skill-emitter.ts). Pure data, no fs, no catalog import.

export const SKILL_DESCRIPTION =
  'figma-agent — the CLI bridge between an agent and a live Figma file, over a local '
  + 'WebSocket broker. Use it to read connection state at session start, then read/write '
  + 'the open Figma document without the paid official write MCP.';

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
3. \`status\`'s \`versionMatch\`/\`protocolMatch\` fields tell you whether the connected
   plugin build matches this CLI. \`null\` means the plugin didn't report a version (an
   older bundle) — treat that as unknown, not as a mismatch.
4. If nothing is connected, the human's remaining step is opening the plugin panel in
   Figma desktop — this CLI cannot do that for them.`;

export const SKILL_WORKFLOW = `## Typical workflow

1. \`figma-agent status --peek\` — is anything alive, and does it match this CLI build.
2. \`figma-agent status\` — full detail on the active connection (spawns a broker if idle).
3. Read before you write: \`get-selection\`, \`inspect\`, \`scan-design-system\`.
4. Mutate with the typed commands (\`create-frame\`, \`set-text\`, \`clone-traits\`, ...)
   before falling back to \`exec-js\` for anything they don't cover.
5. \`changes\`/\`errors\`/\`contention\` read durable local logs — they work even with the
   plugin closed, useful for catching up after a session gap.`;

export const SKILL_ERROR_HINTS = `## Error hints

- \`E_NO_BROKER\` — no broker answered; the plugin almost certainly isn't open. Peek first
  next time, don't assume.
- \`E_NO_PLUGIN\` — the broker is alive but no Figma file is connected right now.
- \`E_WRONG_FILE\` — a command named \`--file\`/\`--instance\` and the plugin currently
  answering doesn't match; open the right file, or drop the filter to see what IS live.
- \`E_TIMEOUT\` (with a \`jobId\`) — the command is still running as a background job; poll
  it with \`figma-agent job <jobId> --wait\` instead of re-issuing the same command.
- \`E_VERSION_MISMATCH\` — the broker speaks a different protocol version than this CLI;
  rebuild/reinstall one side.`;
