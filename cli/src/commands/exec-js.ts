// `figma-agent exec-js <file|->` — run arbitrary Plugin-API JS on the plugin
// main thread. --timeout (ms) raises the default, hard-capped at 120s.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  COMMAND_TIMEOUTS,
  EXEC_JS_MAX_TIMEOUT_MS,
} from '../../../shared/protocol.ts';
import type { CommandArgs } from '../figma-agent.ts';
import { CliError } from '../transport/protocol-helpers.ts';
import { runCommand } from '../transport/broker-client.ts';
import { readStdin } from '../util/read-stdin.ts';
import { lintExecJs } from './exec-js-lint.ts';

const WIRE_MARGIN_MS = 2_000; // socket timeout slightly above plugin-side timeout

export async function run(args: CommandArgs): Promise<unknown> {
  const noLintValue = args.str('no-lint');
  if (noLintValue !== undefined && noLintValue !== 'true' && noLintValue !== 'false') {
    throw new CliError(
      'E_INVALID_ARGS',
      '--no-lint does not take a file value; place --no-lint after the script file',
    );
  }
  const fileArg = args.positionals[0];
  let code: string;
  if (!fileArg || fileArg === '-') {
    code = await readStdin();
  } else {
    try {
      code = readFileSync(resolve(fileArg), 'utf8');
    } catch (err) {
      throw new CliError('E_INVALID_ARGS', `cannot read script file "${fileArg}": ${(err as Error).message}`);
    }
  }
  if (!code.trim()) throw new CliError('E_INVALID_ARGS', 'script input is empty');

  if (!args.bool('no-lint')) {
    const findings = lintExecJs(code);
    // --strict promotes every warning to a refusal — a gate for scripts that must be
    // clean (a verify/assert script), never the default: a heuristic can be wrong.
    const strict = args.bool('strict');
    const blocking = findings.filter((item) => item.severity === 'error' || strict);
    for (const finding of findings.filter((item) => item.severity === 'warning' && !strict)) {
      process.stderr.write(
        `warning: [${finding.id}] line ${finding.line}: ${finding.message}; fix: ${finding.fix}\n`,
      );
    }
    if (blocking.length > 0) {
      const detail = blocking
        .map((finding) => `[${finding.id}] line ${finding.line}: ${finding.message}; fix: ${finding.fix}`)
        .join('\n');
      throw new CliError('E_INVALID_ARGS', `exec-js preflight failed${strict ? ' (--strict)' : ''}:\n${detail}`);
    }
  }

  const requested = args.num('timeout') ?? COMMAND_TIMEOUTS.EXEC_JS ?? 30_000;
  const timeoutMs = Math.min(requested, EXEC_JS_MAX_TIMEOUT_MS);
  // Generic fallback: an ad-hoc script has no intent we can read off it. Named
  // scan/mirror-verify/build runs label themselves and never reach this line.
  const activity = !fileArg || fileArg === '-' ? 'Run script' : `Run script · ${fileArg}`;
  const undoGroup = args.bool('undo-group');
  // Additive-wire rule: send `undoGroup` only when true, exactly like `activity`/`expectedFile`
  // — an unset flag must serialize byte-identically to what a pre-flag CLI sent.
  const out = await runCommand(
    'EXEC_JS',
    { code, timeoutMs, ...(undoGroup ? { undoGroup: true } : {}) },
    { timeoutMs: timeoutMs + WIRE_MARGIN_MS, activity },
  );
  // stdout stays exactly one JSON object (the CLI contract); the human warning goes to stderr.
  const warning = (out as { warning?: unknown } | null)?.warning;
  if (typeof warning === 'string') process.stderr.write(`warning: ${warning}\n`);
  return out;
}
