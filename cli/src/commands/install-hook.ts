// `figma-agent install-hook` — adds a Claude Code SessionStart hook that runs
// `status --peek` at the start of every session. Order of operations is
// non-negotiable: read → parse (abort untouched on invalid JSON, no backup) →
// idempotency check → --dry-run preview → consent (refuse on non-TTY without
// --yes) → backup → write. See plans/260812-2130-auto-connect/phase-01-*.md §1d.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { CommandArgs } from '../figma-agent.ts';
import { CliError } from '../transport/protocol-helpers.ts';

// Absence of the CLI must fail silent and never block a session — `command -v`
// guards that; `|| true` guards the exit code the hook runner sees either way.
const HOOK_COMMAND = 'command -v figma-agent >/dev/null 2>&1 && figma-agent status --peek --json || true';

interface HookEntry {
  type: 'command';
  command: string;
}
interface HookGroup {
  hooks: HookEntry[];
}
interface InstallHookResult {
  settingsPath: string;
  backupPath: string | null;
  hook: HookEntry;
  status: 'installed' | 'unchanged' | 'dry-run';
  preview?: string;
}

function hasHook(settings: Record<string, unknown>): boolean {
  const hooksObj = settings.hooks;
  if (!hooksObj || typeof hooksObj !== 'object') return false;
  const sessionStart = (hooksObj as Record<string, unknown>).SessionStart;
  if (!Array.isArray(sessionStart)) return false;
  return sessionStart.some(
    (group: unknown) =>
      group !== null && typeof group === 'object' && Array.isArray((group as HookGroup).hooks)
      && (group as HookGroup).hooks.some((h) => h?.command === HOOK_COMMAND),
  );
}

function addHook(settings: Record<string, unknown>): Record<string, unknown> {
  const hooksObj = settings.hooks && typeof settings.hooks === 'object' ? { ...(settings.hooks as Record<string, unknown>) } : {};
  const sessionStart = Array.isArray(hooksObj.SessionStart) ? [...(hooksObj.SessionStart as HookGroup[])] : [];
  sessionStart.push({ hooks: [{ type: 'command', command: HOOK_COMMAND }] });
  return { ...settings, hooks: { ...hooksObj, SessionStart: sessionStart } };
}

/** Best-effort match of the existing file's own indentation — a fresh file gets 2. */
function detectIndent(raw: string | null): number {
  const match = raw?.match(/\n( +)"/);
  return match ? match[1].length : 2;
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [Y/n] `)).trim().toLowerCase();
    return answer === '' || answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

export async function run(args: CommandArgs): Promise<InstallHookResult> {
  const settingsPath = args.str('settings') ?? join(homedir(), '.claude', 'settings.json');
  const dryRun = args.bool('dry-run');
  const yes = args.bool('yes');
  const hookEntry: HookEntry = { type: 'command', command: HOOK_COMMAND };

  const existed = existsSync(settingsPath);
  const raw = existed ? readFileSync(settingsPath, 'utf8') : null;
  let settings: Record<string, unknown>;
  if (raw === null) {
    settings = {};
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new CliError('E_INVALID_ARGS', `${settingsPath} is not valid JSON — refusing to touch it (no backup, no write)`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new CliError('E_INVALID_ARGS', `${settingsPath}'s root is not a JSON object — refusing to touch it`);
    }
    settings = parsed as Record<string, unknown>;
  }

  if (hasHook(settings)) {
    return { settingsPath, backupPath: null, hook: hookEntry, status: 'unchanged' };
  }

  const updated = addHook(settings);
  const serialized = `${JSON.stringify(updated, null, detectIndent(raw))}\n`;

  if (dryRun) {
    return { settingsPath, backupPath: null, hook: hookEntry, status: 'dry-run', preview: serialized };
  }

  if (!yes) {
    if (!process.stdin.isTTY) {
      throw new CliError('E_INVALID_ARGS', `${settingsPath} is yours — re-run with --yes or --dry-run`);
    }
    const ok = await confirm(`add a SessionStart hook to ${settingsPath}?`);
    if (!ok) throw new CliError('E_INVALID_ARGS', 'declined — settings.json left untouched');
  }

  let backupPath: string | null = null;
  if (existed) {
    backupPath = `${settingsPath}.bak-${Date.now()}`;
    writeFileSync(backupPath, raw as string);
  }
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, serialized);

  return { settingsPath, backupPath, hook: hookEntry, status: 'installed' };
}
