// Pre-dispatch plugin admission — the CLI's own bounded wait for a plugin to register
// before it sends a command the broker would otherwise refuse while disconnected.
//
// Why the CLI, not the broker: a disconnected MUTATION cannot be parked on a filename
// (broker-daemon.ts's admitRequest answers E_FILE_KEY_UNAVAILABLE — only an explicit raw
// `--target-file-key` is durable identity), so after an idle flap the first agent call
// used to fail while the plugin was one reconnect tick away. Projects patched this by
// prepending `status --wait --timeout 60 &&` to every mutating call; this module is that
// step built in. Same poll loop as `status --wait` (plugin-wait.ts), same 60s default.
import { fileMatches } from '../../../shared/file-match.ts';
import { isBrokerSafeRead } from '../../../shared/mutating-commands.ts';
import { isBrokerTerminalCommand } from '../../../shared/protocol.ts';
import { waitForPlugin, type WaitOptions, type WaitResult } from './plugin-wait.ts';
import { CliError } from './protocol-helpers.ts';

/** Matches the `status --wait --timeout 60` the project hook used — the bound a human
 *  already tolerated, not a new guess. */
export const PLUGIN_ADMISSION_WAIT_SECONDS = 60;

export interface AdmissionDecision {
  cmd: string;
  /** Global `--no-wait`: dispatch at once and let the broker answer honestly. */
  noWait: boolean;
  /** Global `--target-file-key`: the broker parks such a mutation durably itself. */
  targetFileKey?: string;
}

/**
 * Whether a request should wait for a registered plugin before it is sent. Uses the
 * broker's OWN classification (`isBrokerSafeRead`, the same call admitRequest makes) so
 * "mutating" here means exactly the set the broker refuses while disconnected — EXEC_JS,
 * BATCH and AUDIT_DS included. Safe reads are parked by the broker already; terminal
 * commands never reach a plugin at all.
 */
export function needsPluginAdmission(decision: AdmissionDecision): boolean {
  if (decision.noWait) return false;
  if (decision.targetFileKey !== undefined) return false;
  if (isBrokerSafeRead(decision.cmd)) return false;
  if (isBrokerTerminalCommand(decision.cmd)) return false;
  return true;
}

function describeTarget(opts: WaitOptions): string {
  if (opts.instanceFilter) return `instance ${opts.instanceFilter}`;
  if (opts.fileFilter) return `file "${opts.fileFilter}"`;
  return 'any file';
}

/**
 * Wait (bounded) for a plugin matching the route filter to register. Resolves with the
 * wait result on success; throws E_NO_PLUGIN naming the bound and the opt-out when the
 * plugin never comes — never a silent fall-through to the broker's less specific refusal.
 */
export async function awaitPluginAdmission(opts: WaitOptions): Promise<WaitResult> {
  // ONE predicate for "will the broker route --file to this plugin": the broker's own
  // exact comparison (route-filter.ts → shared/file-match.ts). A looser match here would
  // pass the wait and still collect E_FILE_KEY_UNAVAILABLE at dispatch.
  const result = await waitForPlugin({ matchFile: (actual, filter) => fileMatches(actual, filter, true), ...opts });
  if (result.registered) return result;
  const seconds = Math.round(opts.timeoutMs / 1_000);
  throw new CliError(
    'E_NO_PLUGIN',
    `no plugin for ${describeTarget(opts)} registered within ${seconds}s — open Plugins > figma-agent `
      + 'in the target file and retry, or pass --no-wait to dispatch immediately (the broker then '
      + 'refuses a disconnected mutation with E_FILE_KEY_UNAVAILABLE)',
  );
}
