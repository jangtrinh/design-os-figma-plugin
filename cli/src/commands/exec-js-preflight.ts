// The ONE pre-dispatch preflight for any script the CLI ships to EXEC_JS — `exec-js`
// itself and `export-png --assert` share it, so an assert script is held to the same
// dynamic-page rules as an ad-hoc one. Reads the file (or stdin via the caller), lints,
// prints warnings to stderr, and refuses on hard findings (or on any finding under
// `strict`). Pure over its inputs apart from the stderr write.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CliError } from '../transport/protocol-helpers.ts';
import { lintExecJs } from './exec-js-lint.ts';

/** Read a script file for EXEC_JS; an unreadable or empty file is E_INVALID_ARGS. */
export function readScriptFile(fileArg: string, label = 'script file'): string {
  let code: string;
  try {
    code = readFileSync(resolve(fileArg), 'utf8');
  } catch (err) {
    throw new CliError('E_INVALID_ARGS', `cannot read ${label} "${fileArg}": ${(err as Error).message}`);
  }
  if (!code.trim()) throw new CliError('E_INVALID_ARGS', `${label} "${fileArg}" is empty`);
  return code;
}

export interface PreflightOptions {
  /** `--no-lint`: skip the preflight entirely. */
  noLint?: boolean;
  /** `--strict`: every warning refuses, not only hard findings — a heuristic can be
   *  wrong, so this is a gate for scripts that must be clean, never the default. */
  strict?: boolean;
}

/** Lint `code`; warnings to stderr, hard findings (or all findings under strict) refuse. */
export function preflightExecJs(code: string, opts: PreflightOptions = {}): void {
  if (opts.noLint) return;
  const findings = lintExecJs(code);
  const strict = opts.strict === true;
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
