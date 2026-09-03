// The WIRE boundary for GET_CONTEXT: every number, flag and target this command accepts from
// a client, validated before a single node is read.
//
// It is a separate module from the executor because the trust boundary is a separate concern
// from the reply assembly — and because the CLI is only ONE client of this wire. Every bound
// the CLI enforces is enforced again here: without that, `budgetBytes: 1_073_741_824` from
// any other client has the designer's plugin accumulate an unbounded `nodes[]` until it dies
// mid-session.
//
// Nothing here corrects a value silently. A caller who asked for `--budget 0` and got 64 KB
// learns the wrong thing about this command, so a value that cannot be honoured is refused
// with `E_INVALID_ARGS` naming the field and what it received.
import { withCode } from './executor-styles';
import type { ContextNodeLike } from './context-node-record';
import { safe } from './scan-node-utils';

type Params = Record<string, unknown>;

/** What the executor needs in order to find the target — the same injected surface, narrowed
 *  to the two reads target resolution actually performs. */
export interface ContextTargetEnv {
  nodeById: (id: string) => Promise<ContextNodeLike | null>;
  selection: () => readonly ContextNodeLike[];
}

/** A wire number is validated at the boundary, never silently corrected: a caller that
 *  asked for `--budget 0` and got 64 KB learns the wrong thing about this command.
 *
 *  The upper bound is enforced HERE as well as at the CLI because the WIRE is the trust
 *  boundary — the CLI is one client of it. Without this, `budgetBytes: 1_073_741_824` from
 *  any other client has the designer's plugin accumulate an unbounded `nodes[]` until it
 *  dies mid-session. */
export function contextBoundedNumber(params: Params, key: string, fallback: number, max: number): number {
  const raw = params[key];
  if (raw === undefined) return fallback;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    throw withCode(new Error(`${key} must be a positive number, got ${JSON.stringify(raw)}`), 'E_INVALID_ARGS');
  }
  if (raw > max) {
    throw withCode(new Error(`${key} ${raw} is past the ${max} maximum`), 'E_INVALID_ARGS');
  }
  return raw;
}

/** A wire boolean, validated rather than coerced: `dedup: "yes"` from another client is a
 *  caller with a wrong idea of this contract, and answering it with the raw form silently
 *  would teach that idea. */
export function contextFlag(params: Params, key: string): boolean {
  const raw = params[key];
  if (raw === undefined) return false;
  if (typeof raw !== 'boolean') {
    throw withCode(new Error(`${key} must be true or false, got ${JSON.stringify(raw)}`), 'E_INVALID_ARGS');
  }
  return raw;
}

export function contextMaxDepth(params: Params): number {
  const raw = params.depth;
  if (raw === undefined) return Number.POSITIVE_INFINITY;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    throw withCode(new Error(`depth must be a non-negative integer, got ${JSON.stringify(raw)}`), 'E_INVALID_ARGS');
  }
  return raw;
}

/**
 * A DOCUMENT is refused; a PAGE is allowed and says so in the docs.
 *
 * `context 0:0` would walk every page — bounded by bytes, but still "a read outside the
 * target's subtree", and on the one command whose selling point is that it never widens a
 * read, a silent allow is the wrong default. A PAGE, by contrast, IS a subtree and "give me
 * this screen" is the natural call.
 */
function refuseNonSubtree(node: ContextNodeLike): void {
  if (safe(() => node.type) === 'DOCUMENT') {
    throw withCode(
      new Error('a document is not a subtree — pass a page or a node id'),
      'E_INVALID_ARGS',
    );
  }
}

export async function resolveContextTarget(params: Params, env: ContextTargetEnv): Promise<ContextNodeLike> {
  const nodeId = params.nodeId;
  if (typeof nodeId === 'string' && nodeId !== '') {
    const found = await env.nodeById(nodeId);
    if (!found) throw withCode(new Error(`no node answers to "${nodeId}"`), 'E_INVALID_ARGS');
    refuseNonSubtree(found);
    return found;
  }
  const selected = env.selection()[0];
  if (!selected) {
    throw withCode(new Error('no target: pass a node id, or select one node in Figma'), 'E_INVALID_ARGS');
  }
  refuseNonSubtree(selected);
  return selected;
}