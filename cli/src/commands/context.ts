// `figma-agent context [nodeId|selection] [--budget KB] [--depth N] [--no-css] [--timeout ms]`
// — the code context of one node's subtree as data: the Inspect panel's own CSS
// declarations, the variables and styles each node binds, its text and component
// properties. Not generated framework code, and not Dev Mode.
//
// Read-only by name: GET_CONTEXT is on the broker's safe-read allowlist, so this asserts
// `readOnly` and the request bypasses mutation admission — a context read never queues
// behind someone's build. (`inspect` and `scan-node` cannot do that: they ride EXEC_JS,
// which the broker classifies as a mutation because a script's targets are unknowable.)
//
// The BUDGET is spent in the plugin, before the wire. What arrives here is already bounded,
// already counted, and already carries the cursor for the rest.
import type { CommandArgs } from '../figma-agent.ts';
import { CliError } from '../transport/protocol-helpers.ts';
import { runCommand } from '../transport/broker-client.ts';
import { resolveSafeTarget } from '../../../shared/safe-target.ts';
import { CHUNK_LIMIT, COMMAND_TIMEOUTS, EXEC_JS_MAX_TIMEOUT_MS } from '../../../shared/protocol.ts';
import type { CorrectionEvent } from '../../../shared/supervised-memory.ts';

type Runner = typeof runCommand;

interface SelectionReply {
  selection?: { id?: string }[];
}

export interface ContextInput {
  explicit?: string;
  /** `--budget`, in KILOBYTES — the unit a caller reasons about; the wire carries bytes. */
  budgetKb?: number;
  depth?: number;
  noCss?: boolean;
  timeout?: number;
}

export const DEFAULT_CONTEXT_BUDGET_KB = 64;
/** The 512 KB chunk seam (`CHUNK_LIMIT`). Past it a single reply is not "one large answer"
 *  but hundreds of frames of a plugin sandbox accumulating an unbounded `nodes[]` — the
 *  opposite of what a command whose selling point is "bounded before the wire" may do.
 *  REFUSED rather than clamped: a caller who asked for a gigabyte and silently got 512 KB
 *  learns the wrong thing about this command. */
export const MAX_CONTEXT_BUDGET_KB = CHUNK_LIMIT / 1024;
/** The plugin's soft deadline sits this far inside the wire timeout, so a slow subtree
 *  answers with a partial AND its counts before the wire can fail with nothing. */
export const DEADLINE_HEADROOM_MS = 2_000;

export interface ResolvedContextCall {
  params: Record<string, unknown>;
  timeoutMs: number;
}

/**
 * Flags → wire params. Pure, so the unit conversion and the deadline arithmetic are
 * testable without a broker. A budget or depth that cannot be honestly converted is
 * refused here rather than rounded into something the caller did not ask for.
 */
export function resolveContextParams(input: ContextInput): ResolvedContextCall {
  const budgetKb = input.budgetKb ?? DEFAULT_CONTEXT_BUDGET_KB;
  if (!Number.isFinite(budgetKb) || budgetKb <= 0) {
    throw new CliError('E_INVALID_ARGS', `--budget must be a positive number of KB, got ${String(input.budgetKb)}`);
  }
  if (input.depth !== undefined && (!Number.isInteger(input.depth) || input.depth < 0)) {
    throw new CliError('E_INVALID_ARGS', `--depth must be a non-negative integer, got ${String(input.depth)}`);
  }
  if (budgetKb > MAX_CONTEXT_BUDGET_KB) {
    throw new CliError(
      'E_INVALID_ARGS',
      `--budget ${budgetKb} KB is past the ${MAX_CONTEXT_BUDGET_KB} KB maximum (the wire's chunk seam) `
      + '— ask for less, then follow the frontier ids for the rest',
    );
  }
  const budgetBytes = Math.floor(budgetKb * 1024);
  // Refused HERE rather than after a round trip: the plugin's own boundary check would
  // reject `budgetBytes: 0`, but only once the request had already reached it.
  if (budgetBytes < 1) {
    throw new CliError('E_INVALID_ARGS', `--budget ${budgetKb} KB floors to 0 bytes — pass at least 1`);
  }
  const requestedTimeout = input.timeout ?? COMMAND_TIMEOUTS.GET_CONTEXT ?? 0;
  if (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0) {
    throw new CliError('E_INVALID_ARGS', `--timeout must be a positive number of ms, got ${String(input.timeout)}`);
  }
  // CLAMPED, not refused — the same treatment `resolveScanTimeout` gives exec-js, and for
  // the same reason: an over-long timeout is a caller asking to wait, not a caller asking
  // for something impossible. It is never invisible: the value actually used rides back in
  // the reply's `budget.timeoutMs`.
  const timeoutMs = Math.min(requestedTimeout, EXEC_JS_MAX_TIMEOUT_MS);
  // Below ~4s the headroom would leave the plugin no time at all, so the deadline becomes
  // half the budget instead of a negative number.
  const deadlineMs = timeoutMs > DEADLINE_HEADROOM_MS * 2
    ? timeoutMs - DEADLINE_HEADROOM_MS
    : Math.max(1, Math.floor(timeoutMs / 2));
  return {
    params: {
      budgetBytes,
      deadlineMs,
      ...(input.depth !== undefined && { depth: input.depth }),
      ...(input.noCss === true && { noCss: true }),
    },
    timeoutMs,
  };
}

/**
 * Target resolution is `inspect`'s exactly: an explicit id, else the selection, else the
 * most recently corrected node, else a refusal that names the three ways to fix it.
 */
/** `budget` with the wire timeout actually used folded in. The plugin authors the rest of
 *  that block; this one number is the CLI's own (it clamps `--timeout`), and hiding it would
 *  make the clamp invisible. */
function withTimeout(reply: Record<string, unknown>, timeoutMs: number): Record<string, unknown> {
  const budget = reply.budget;
  if (budget === null || typeof budget !== 'object') return reply;
  return { ...reply, budget: { ...(budget as Record<string, unknown>), timeoutMs } };
}

export async function contextTarget(input: ContextInput, runner: Runner = runCommand): Promise<unknown> {
  // Flags are validated BEFORE any round trip: a refused budget must not cost a
  // GET_SELECTION first.
  const { params, timeoutMs } = resolveContextParams(input);
  const selected = input.explicit ? [] : ((await runner('GET_SELECTION', { depth: 0 })) as SelectionReply)
    .selection?.flatMap((node) => (node.id ? [node.id] : [])) ?? [];
  const recent = input.explicit || selected.length > 0
    ? []
    : ((await runner('GET_CORRECTION_MEMORY', {}, { activity: 'Resolve recent target' })) as {
      events?: CorrectionEvent[];
    }).events?.slice().sort((a, b) => b.timestamp.localeCompare(a.timestamp)).map((event) => event.nodeId) ?? [];
  const target = resolveSafeTarget({ explicit: input.explicit, selection: selected, recent });
  const reply = await runner('GET_CONTEXT', { nodeId: target.nodeId, ...params }, {
    readOnly: true, timeoutMs, activity: `Context · ${target.nodeId}`,
  }) as Record<string, unknown> | null;
  return { ...withTimeout(reply ?? {}, timeoutMs), nodeId: target.nodeId, targetSource: target.source };
}

/**
 * A numeric flag whose value is missing.
 *
 * `parseArgs` stores a flag whose next token starts with `--` as boolean `true`, so `num()`
 * answers `undefined` and the DEFAULT silently applies: `--depth --no-css` walked the
 * subtree unbounded after the caller asked to bound it, and `--budget --no-css` reported a
 * `requestedBytes` the caller never stated. figma-agent.ts already refuses exactly this
 * parse quirk for `--file` / `--instance` / `--target-file-key`, for the same reason.
 */
function numericFlag(args: CommandArgs, name: string): number | undefined {
  if (args.bool(name) && args.str(name) === undefined) {
    throw new CliError('E_INVALID_ARGS', `--${name} needs a number, e.g. --${name} 2`);
  }
  return args.num(name);
}

export async function run(args: CommandArgs, runner: Runner = runCommand): Promise<unknown> {
  // RESERVED, not implemented: an alternative serialization is only worth a second on-wire
  // shape once the byte numbers this command reports prove JSON is what costs. Accepting
  // and ignoring the flag would have the caller believe it got the format it asked for.
  if (args.bool('format') || args.str('format') !== undefined) {
    throw new CliError(
      'E_INVALID_ARGS',
      '--format is reserved and not implemented — this command emits one JSON object. '
      + 'Use --no-css for a smaller answer, or --budget/--depth to bound it.',
    );
  }
  return contextTarget({
    explicit: args.str('node') ?? args.positionals[0],
    budgetKb: numericFlag(args, 'budget'),
    depth: numericFlag(args, 'depth'),
    noCss: args.bool('no-css'),
    timeout: numericFlag(args, 'timeout'),
  }, runner);
}
