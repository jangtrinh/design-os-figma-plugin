// `figma-agent install-hook` — adds a Claude Code SessionStart hook that runs
// `status --peek` at the start of every session. Order of operations is
// non-negotiable: read → parse (abort untouched on invalid JSON, no backup) →
// idempotency check → --dry-run preview → consent (refuse on non-TTY without
// --yes) → backup → write. This is a user's own config file: every step exists
// to make the write safe to reverse and impossible to trigger by accident.
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

/** Best-effort match of the existing file's own indentation (tabs or spaces) — a
 *  fresh file gets 2 spaces. Feeds JSON.stringify's own indent param directly:
 *  a number for N spaces, or the literal tab character for a tab-indented file. */
function detectIndent(raw: string | null): string | number {
  if (raw === null) return 2;
  if (/\n\t/.test(raw)) return '\t';
  const match = raw.match(/\n( +)"/);
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

interface ReadSettings {
  existed: boolean;
  raw: string | null;
  settings: Record<string, unknown>;
}

/** Read + parse + validate settingsPath. Shared by the pre-prompt read and the
 *  post-prompt re-read so both apply the identical invalid-JSON/non-object rules. */
function readSettings(settingsPath: string): ReadSettings {
  const existed = existsSync(settingsPath);
  const raw = existed ? readFileSync(settingsPath, 'utf8') : null;
  if (raw === null) return { existed, raw, settings: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError('E_INVALID_ARGS', `${settingsPath} is not valid JSON — refusing to touch it (no backup, no write)`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliError('E_INVALID_ARGS', `${settingsPath}'s root is not a JSON object — refusing to touch it`);
  }
  return { existed, raw, settings: parsed as Record<string, unknown> };
}

export async function run(args: CommandArgs): Promise<InstallHookResult> {
  const settingsPath = args.str('settings') ?? join(homedir(), '.claude', 'settings.json');
  const dryRun = args.bool('dry-run');
  const yes = args.bool('yes');
  const hookEntry: HookEntry = { type: 'command', command: HOOK_COMMAND };

  const initial = readSettings(settingsPath);
  if (hasHook(initial.settings)) {
    return { settingsPath, backupPath: null, hook: hookEntry, status: 'unchanged' };
  }

  if (dryRun) {
    const preview = `${JSON.stringify(addHook(initial.settings), null, detectIndent(initial.raw))}\n`;
    return { settingsPath, backupPath: null, hook: hookEntry, status: 'dry-run', preview };
  }

  if (!yes) {
    if (!process.stdin.isTTY) {
      throw new CliError('E_INVALID_ARGS', `${settingsPath} is yours — re-run with --yes or --dry-run`);
    }
    // This prompt can sit for minutes waiting on the user — everything computed
    // from `initial` above is now potentially stale, so it must never reach the
    // write below. Re-read happens after this returns, not before.
    const ok = await confirm(`add a SessionStart hook to ${settingsPath}?`);
    if (!ok) throw new CliError('E_INVALID_ARGS', 'declined — settings.json left untouched');
  }

  // Re-read right before writing — a concurrent writer's edits made during the
  // confirm wait above must never be silently discarded by a write computed
  // from the stale pre-prompt content. Byte-for-byte compare (not a semantic
  // diff): any change at all means the write below would be answering a
  // question the user didn't actually ask.
  const fresh = readSettings(settingsPath);
  if (fresh.raw !== initial.raw) {
    throw new CliError(
      'E_INVALID_ARGS',
      `${settingsPath} changed on disk while waiting for confirmation — re-run install-hook to pick up the new content`,
    );
  }

  const serialized = `${JSON.stringify(addHook(fresh.settings), null, detectIndent(fresh.raw))}\n`;

  let backupPath: string | null = null;
  if (fresh.existed) {
    // Backs up exactly what is about to be overwritten (`fresh.raw`, not the
    // earlier `initial.raw`) — the one job a backup has.
    backupPath = `${settingsPath}.bak-${Date.now()}`;
    writeFileSync(backupPath, fresh.raw as string);
  }
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, serialized);

  return { settingsPath, backupPath, hook: hookEntry, status: 'installed' };
}
