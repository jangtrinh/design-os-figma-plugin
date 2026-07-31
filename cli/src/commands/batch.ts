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

// Mirrors southleft/figma-console-mcp's componentSetTimeoutMs's per-unit budget,
// hop buffer, and cap — shared between `batchTimeoutMs` (scales the wait) and
// `maxBatchOps`/`assertBatchAdmissible` (issue #16: refuses what the SAME formula
// says the cap can no longer cover). Hoisted to module scope so both readings of
// the formula can never drift apart.
const PER_OP_MS = 1_200; // mirrors componentSetTimeoutMs's per-unit budget
const HOP_BUFFER_MS = 5_000; // mirrors the fork's buffer over its own hop
const CAP_MS = 120_000; // same cap the fork uses

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
  const base = COMMAND_TIMEOUTS.BATCH ?? DEFAULT_TIMEOUT_MS;
  const scaled = opCount * PER_OP_MS + HOP_BUFFER_MS;
  return Math.min(CAP_MS, Math.max(base, scaled));
}

/**
 * Issue #16 ruling (follow-up to PR #14) — the largest op count whose UNCAPPED
 * scaled budget (`opCount * PER_OP_MS + HOP_BUFFER_MS`) still fits inside `CAP_MS`.
 * Above this count, `batchTimeoutMs` clamps the wait to `CAP_MS` while the formula
 * itself says the pass needs MORE than that — the clamp doesn't shrink the work,
 * only the time the CLI is told to wait for it, so the uncancellable plugin-side
 * pass keeps running past the clamped timeout and the CLI reports a false timeout
 * failure mid-flight (with the ops still landing, inviting a double-apply retry).
 */
export function maxBatchOps(): number {
  return Math.floor((CAP_MS - HOP_BUFFER_MS) / PER_OP_MS);
}

/**
 * Hard refusal (issue #16), not a raised cap: a BATCH whose scaled budget would
 * exceed `CAP_MS` is refused BEFORE dispatch — a job is never created for a pass
 * this codebase already knows it cannot honor in one uncancellable round trip.
 * Cheap, loud, and carries no double-apply risk (nothing was sent to the broker
 * yet), unlike letting it run and hit the wire timeout, or raising the cap (which
 * only moves the same failure to a higher op count).
 */
export function assertBatchAdmissible(opCount: number): void {
  const max = maxBatchOps();
  if (opCount > max) {
    throw new CliError(
      'E_INVALID_ARGS',
      `${opCount} ops exceeds the single-pass budget of ${CAP_MS / 1_000}s; split into batches of ≤${max}`,
    );
  }
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
  assertBatchAdmissible(ops.length);
  return runner('BATCH', { ops, stopOnError }, { timeoutMs: batchTimeoutMs(ops.length) });
}

export async function run(args: CommandArgs): Promise<unknown> {
  const fileArg = args.positionals[0];
  if (!fileArg) throw new CliError('E_INVALID_ARGS', 'usage: figma-agent batch <file.json> [--stop-on-error]');
  return execute(fileArg, args.bool('stop-on-error'));
}
