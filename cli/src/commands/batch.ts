// `figma-agent batch <file.json>` — send a JSON array of {cmd,params} as ONE
// BATCH request (single round-trip; plugin executes sequentially).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { COMMAND_TIMEOUTS, COMMANDS, DEFAULT_TIMEOUT_MS, type CommandName } from '../../../shared/protocol.ts';
import type { CommandArgs } from '../figma-agent.ts';
import { CliError } from '../transport/protocol-helpers.ts';
import { runCommand } from '../transport/broker-client.ts';

interface BatchOp {
  cmd: CommandName;
  params: unknown;
}

function loadOps(filePath: string): BatchOp[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new CliError('E_INVALID_ARGS', `cannot read batch file "${filePath}": ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new CliError('E_INVALID_ARGS', 'batch file must be a non-empty JSON array of {cmd,params}');
  }
  return parsed.map((op, i) => {
    const candidate = op as { cmd?: unknown; params?: unknown };
    if (typeof candidate?.cmd !== 'string' || !(COMMANDS as readonly string[]).includes(candidate.cmd)) {
      throw new CliError('E_INVALID_ARGS', `batch[${i}].cmd invalid — must be one of: ${COMMANDS.join(', ')}`);
    }
    return { cmd: candidate.cmd as CommandName, params: candidate.params ?? {} };
  });
}

/**
 * Audit backlog 2.10, phase 2 — BATCH executes every op sequentially in ONE
 * uncancellable pass (the plugin sandbox cannot be interrupted mid-sequence), so a
 * fixed timeout that fires early doesn't stop the work — it just makes the CLI's
 * report contradict the file state (ops keep landing after the reported "failure")
 * and invites a duplicate retry that double-applies. Mirrors
 * southleft/figma-console-mcp's `componentSetTimeoutMs` (per-unit budget, floor,
 * cap, hop buffer over the same base formula) — adapted per-OP rather than
 * per-variant: this codebase has no CREATE_COMPONENT_SET-equivalent single
 * command, so BATCH (N ops, one round trip, one uncancellable pass) is the
 * structurally closest analog available to scale.
 *
 * Never scales BELOW `COMMAND_TIMEOUTS.BATCH` (today's fixed default): an ordinary
 * batch keeps today's exact timeout unchanged. Only once `opCount * PER_OP_MS +
 * HOP_BUFFER_MS` would exceed that default does the wait actually grow, capped at
 * `CAP_MS` — mirroring the fork's own cap.
 */
export function batchTimeoutMs(opCount: number): number {
  const PER_OP_MS = 1_200; // mirrors componentSetTimeoutMs's per-unit budget
  const HOP_BUFFER_MS = 5_000; // mirrors the fork's buffer over its own hop
  const CAP_MS = 120_000; // same cap the fork uses
  const base = COMMAND_TIMEOUTS.BATCH ?? DEFAULT_TIMEOUT_MS;
  const scaled = opCount * PER_OP_MS + HOP_BUFFER_MS;
  return Math.min(CAP_MS, Math.max(base, scaled));
}

/** A command runner (the BATCH transport call), injectable for tests. */
export type Runner = (cmd: string, params: unknown, opts?: { timeoutMs?: number }) => Promise<unknown>;

/**
 * Decoupled from `CommandArgs` + the real transport so it is unit-testable with a
 * stub runner and a fixture file, matching `scan-design-system.ts`'s `execute`
 * pattern.
 */
export async function execute(
  filePath: string,
  stopOnError: boolean,
  runner: Runner = runCommand,
): Promise<unknown> {
  const ops = loadOps(resolve(filePath));
  return runner('BATCH', { ops, stopOnError }, { timeoutMs: batchTimeoutMs(ops.length) });
}

export async function run(args: CommandArgs): Promise<unknown> {
  const fileArg = args.positionals[0];
  if (!fileArg) throw new CliError('E_INVALID_ARGS', 'usage: figma-agent batch <file.json> [--stop-on-error]');
  return execute(fileArg, args.bool('stop-on-error'));
}
