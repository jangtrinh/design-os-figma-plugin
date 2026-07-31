// Figma live-sync config (spec 004 P4) — the idle window the broker passes to the
// plugin. One line in the project: `design/figma-sync.json` {"idleMs": 300000}. The
// broker reads it once at connect and sends it as SYNC_CONFIG; the plugin's idle
// timer uses it (clamped to a floor). Kept tiny + pure-ish (fs read only, no network).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_IDLE_MS, MIN_IDLE_MS } from '../../../shared/protocol.ts';
import { changeLogDir } from './change-log.ts';

export const SYNC_CONFIG_FILENAME = 'figma-sync.json';

/** Absolute path to `<broker-cwd-or-env-override>/figma-sync.json` — the GLOBAL
 *  fallback used only while a file has no resolved project binding yet (see
 *  `readIdleMs()` below). A BOUND file must use `syncConfigPathFor()` instead. */
export function syncConfigPath(): string {
  return join(changeLogDir(), SYNC_CONFIG_FILENAME);
}

/**
 * Resolve the idle window in ms for a file with NO resolved project binding (broker
 * startup default, and the transient window before a PROJECT_BIND lands). Order:
 * `FIGMA_AGENT_IDLE_MS` env (fast test override) → the broker's own cwd-relative
 * `figma-sync.json` {"idleMs"} → DEFAULT_IDLE_MS. Any malformed/too-small value floors
 * to MIN_IDLE_MS so a typo can never spin the timer.
 *
 * Issue #20 audit: this is deliberately NOT the only idle-window resolver. The broker
 * is a multi-project daemon (`project-bind.ts`'s `bindIndex` routes many bound
 * projects through one process) — once a file's identity resolves to a project via
 * the binding, its idle window must come from THAT project's own
 * `design/figma-sync.json` (`readIdleMsFor()`), never this cwd-relative default, or a
 * broker spawned from project A's cwd would hand project B's plugin project A's idle
 * window. Callers: `broker-daemon.ts`'s PLUGIN_HELLO handler resolves the binding
 * first and only falls back to this function when the file is genuinely unbound.
 */
export function readIdleMs(): number {
  const env = process.env['FIGMA_AGENT_IDLE_MS'];
  if (env !== undefined) return clampIdle(Number(env));
  return readIdleMsFromPath(syncConfigPath());
}

/** Absolute path to `<projectDir>/design/figma-sync.json` — the per-project idle
 *  config, same shape as `change-log.ts`'s `changeLogPathFor()`. */
export function syncConfigPathFor(projectDir: string): string {
  return join(projectDir, 'design', SYNC_CONFIG_FILENAME);
}

/**
 * Resolve the idle window in ms for a file that IS bound to `projectDir` (issue #20).
 * Same precedence as `readIdleMs()` — the env override still wins globally (an
 * operator's fast-test override must not require per-project files) — but the file
 * fallback reads `<projectDir>/design/figma-sync.json`, never the broker's own cwd.
 */
export function readIdleMsFor(projectDir: string): number {
  const env = process.env['FIGMA_AGENT_IDLE_MS'];
  if (env !== undefined) return clampIdle(Number(env));
  return readIdleMsFromPath(syncConfigPathFor(projectDir));
}

function readIdleMsFromPath(path: string): number {
  if (!existsSync(path)) return DEFAULT_IDLE_MS;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { idleMs?: unknown };
    const raw = parsed?.idleMs;
    return typeof raw === 'number' ? clampIdle(raw) : DEFAULT_IDLE_MS;
  } catch {
    return DEFAULT_IDLE_MS; // a broken config never disables the loop — fall back to default
  }
}

function clampIdle(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_IDLE_MS;
  return Math.max(MIN_IDLE_MS, Math.floor(n));
}
