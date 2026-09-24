// `figma-agent exec-js <file|->` — run arbitrary Plugin-API JS on the plugin
// main thread. --timeout (ms) raises the default, hard-capped at 120s; it counts from the
// moment the broker dispatches the script. --queue-timeout (ms) bounds the wait behind
// other scripts on the same file; a script still queued then is cancelled, never run.
import {
  COMMAND_TIMEOUTS,
  EXEC_JS_MAX_TIMEOUT_MS,
} from '../../../shared/protocol.ts';
import type { CommandArgs } from '../figma-agent.ts';
import { CliError } from '../transport/protocol-helpers.ts';
import { runCommand } from '../transport/broker-client.ts';
import { readStdin } from '../util/read-stdin.ts';
import { readTimeoutFlag, resolveTimeoutFlag } from '../util/timeout-flag.ts';
import { preflightExecJs, readScriptFile } from './exec-js-preflight.ts';

const WIRE_MARGIN_MS = 2_000; // socket timeout slightly above plugin-side timeout
const DEFAULT_QUEUE_TIMEOUT_MS = 600_000;

export async function run(args: CommandArgs): Promise<unknown> {
  const noLintValue = args.str('no-lint');
  if (noLintValue !== undefined && noLintValue !== 'true' && noLintValue !== 'false') {
    throw new CliError(
      'E_INVALID_ARGS',
      '--no-lint does not take a file value; place --no-lint after the script file',
    );
  }
  const queueTimeoutMs = readTimeoutFlag(args, 'queue-timeout') ?? DEFAULT_QUEUE_TIMEOUT_MS;
  const fileArg = args.positionals[0];
  let code: string;
  if (!fileArg || fileArg === '-') {
    code = await readStdin();
    if (!code.trim()) throw new CliError('E_INVALID_ARGS', 'script input is empty');
  } else {
    code = readScriptFile(fileArg);
  }

  preflightExecJs(code, { noLint: args.bool('no-lint'), strict: args.bool('strict') });

  const requested = args.num('timeout') ?? COMMAND_TIMEOUTS.EXEC_JS ?? 30_000;
  const { effective: timeoutMs, notice } = resolveTimeoutFlag(requested, EXEC_JS_MAX_TIMEOUT_MS, '--timeout');
  if (notice) process.stderr.write(notice);
  // Generic fallback: an ad-hoc script has no intent we can read off it. Named
  // scan/mirror-verify/build runs label themselves and never reach this line.
  const activity = !fileArg || fileArg === '-' ? 'Run script' : `Run script · ${fileArg}`;
  const undoGroup = args.bool('undo-group');
  // Additive-wire rule: send `undoGroup` only when true, exactly like `activity`/`expectedFile`
  // — an unset flag must serialize byte-identically to what a pre-flag CLI sent.
  const out = await runCommand(
    'EXEC_JS',
    { code, timeoutMs, ...(undoGroup ? { undoGroup: true } : {}) },
    { timeoutMs: timeoutMs + WIRE_MARGIN_MS, activity, queueTimeoutMs },
  );
  // stdout stays exactly one JSON object (the CLI contract); the human warning goes to stderr.
  const warning = (out as { warning?: unknown } | null)?.warning;
  if (typeof warning === 'string') process.stderr.write(`warning: ${warning}\n`);
  return out;
}
