// `figma-agent export-png` — plugin exportAsync returns {base64,w,h};
// the CLI writes --out and prints {path,w,h} so Claude can Read the file.
//
// `--assert <script.js>` (craft gate 9, "structure is the gate; the PNG is the arbiter"):
// the script runs FIRST as a plugin-enforced read-only EXEC_JS — the plugin's own
// read-only guard refuses a script that writes — and the PNG is exported only when it
// passes. A failing assert exits 1 with E_ASSERT_FAILED carrying the script's result;
// nothing is written, so a PNG on disk always means the structure check held.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { COMMAND_TIMEOUTS, EXEC_JS_MAX_TIMEOUT_MS } from '../../../shared/protocol.ts';
import type { CommandArgs } from '../figma-agent.ts';
import { CliError } from '../transport/protocol-helpers.ts';
import { runCommand } from '../transport/broker-client.ts';
import { preflightExecJs, readScriptFile } from './exec-js-preflight.ts';

const WIRE_MARGIN_MS = 2_000;

/** A reply passes when its `result` is `{ok: true}`-shaped, or otherwise truthy; an
 *  `{ok: false, ...}` object fails even though it is truthy — the shape the craft
 *  audit scripts already return. */
export function assertPasses(reply: unknown): boolean {
  const value = (reply as { result?: unknown } | null | undefined)?.result;
  if (value !== null && typeof value === 'object' && 'ok' in value) return (value as { ok: unknown }).ok === true;
  return Boolean(value);
}

function summarize(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
}

async function runAssert(scriptPath: string, args: CommandArgs): Promise<unknown> {
  const code = readScriptFile(scriptPath, 'assert script');
  preflightExecJs(code, { noLint: args.bool('no-lint'), strict: args.bool('strict') });
  const requested = args.num('assert-timeout') ?? COMMAND_TIMEOUTS.EXEC_JS ?? 30_000;
  const timeoutMs = Math.min(requested, EXEC_JS_MAX_TIMEOUT_MS);
  let reply: unknown;
  try {
    reply = await runCommand('EXEC_JS', { code, timeoutMs }, {
      timeoutMs: timeoutMs + WIRE_MARGIN_MS, activity: `Assert · ${scriptPath}`, pluginEnforcedReadOnly: true,
    });
  } catch (err) {
    if (err instanceof CliError) {
      throw new CliError(err.code, `assert script "${scriptPath}" failed before export (PNG not written): ${err.message}`, {
        rolledBack: err.rolledBack, jobId: err.jobId, recovery: err.recovery,
      });
    }
    throw err;
  }
  if (!assertPasses(reply)) {
    const result = (reply as { result?: unknown } | null | undefined)?.result;
    throw new CliError('E_ASSERT_FAILED', `assert script "${scriptPath}" returned ${summarize(result)} — PNG not written`);
  }
  return (reply as { result?: unknown }).result;
}

export async function run(args: CommandArgs): Promise<unknown> {
  const target = args.req('node'); // node id, or the literal "selection"
  const outPath = resolve(args.req('out'));
  const scale = args.num('scale') ?? 2;
  const assertPath = args.str('assert');
  if (args.bool('assert') && assertPath === undefined) {
    throw new CliError('E_INVALID_ARGS', '--assert needs a script path, e.g. --assert verify/screen.js');
  }
  const assertResult = assertPath !== undefined ? await runAssert(assertPath, args) : undefined;

  const result = (await runCommand('EXPORT_PNG', {
    nodeId: target === 'selection' ? undefined : target,
    useSelection: target === 'selection',
    scale,
  })) as { base64?: string; w?: number; h?: number };

  if (!result || typeof result.base64 !== 'string') {
    throw new CliError('E_PLUGIN_ERROR', 'EXPORT_PNG reply missing base64 image data');
  }
  writeFileSync(outPath, Buffer.from(result.base64, 'base64'));
  return {
    path: outPath, w: result.w, h: result.h,
    ...(assertPath !== undefined && { assert: { script: assertPath, result: assertResult } }),
  };
}
