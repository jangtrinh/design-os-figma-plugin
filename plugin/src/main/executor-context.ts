// GET_CONTEXT: the code context of ONE node's subtree, read-only.
//
// What the caller gets is what the Plugin API exposes on every plan — the Inspect panel's
// own CSS declarations, the variables and styles each node binds, its text and component
// properties — as data. It is not generated framework code, and nothing here reaches
// outside the requested subtree: no `loadAllPagesAsync`, no `findAll*`, no whole-file
// variable registry read. A subtree read must not cost the file's dynamic-page grant.
//
// The environment is INJECTED (`GetContextEnv`) rather than read off `figma` inline, so the
// whole command is drivable from plain fixture objects. main.ts supplies the live one.
import { CHUNK_LIMIT, CONTEXT_SCHEMA, EXEC_JS_MAX_TIMEOUT_MS } from '../../../shared/protocol';
import { utf8ByteLength } from '../../../shared/utf8-byte-length';
import type { ContextNodeLike } from './context-node-record';
import { resolveContextRefs, type ContextRefsDeps } from './context-refs';
import { walkContext } from './context-walk';
import { withCode } from './executor-styles';
import { safe } from './scan-node-utils';

type Params = Record<string, unknown>;

/** 64 KB ≈ 16k tokens of JSON — enough for a screen's skeleton plus leaf detail, and far
 *  under the 512 KB chunk seam (chunking is transport, never a bound on an answer). */
export const DEFAULT_CONTEXT_BUDGET_BYTES = 64 * 1024;

/** The walk's own budget when the caller named none. Deliberately below the wire timeout
 *  for GET_CONTEXT so a slow subtree returns a PARTIAL WITH COUNTS rather than an empty
 *  E_TIMEOUT — which teaches an agent to re-issue and pay for the whole walk twice. */
export const DEFAULT_CONTEXT_DEADLINE_MS = 43_000;

export interface GetContextEnv {
  nodeById: (id: string) => Promise<ContextNodeLike | null>;
  selection: () => readonly ContextNodeLike[];
  refs: ContextRefsDeps;
  now: () => number;
  hop: () => Promise<void>;
  /** A monotonically increasing count of document-change batches attributable to the one
   *  active dispatch. Snapshotted before the walk and diffed after. */
  changeCount: () => number;
}

/** The live environment. Built lazily inside a function: this module must be importable
 *  outside a plugin sandbox for its own tests. */
export function figmaContextEnv(changeCount: () => number): GetContextEnv {
  return {
    nodeById: async (id) => (await figma.getNodeByIdAsync(id)) as unknown as ContextNodeLike | null,
    // The one cast at the sandbox boundary (the standing pattern for a reader that must run
    // over both a real SceneNode and a fixture): every property access past this point goes
    // through `safe()`, so a node that refuses a read costs one field, never the walk.
    selection: () => figma.currentPage.selection as unknown as readonly ContextNodeLike[],
    refs: {
      variableById: (id) => figma.variables.getVariableByIdAsync(id),
      collectionById: (id) => figma.variables.getVariableCollectionByIdAsync(id),
      styleById: (id) => figma.getStyleByIdAsync(id),
    },
    now: () => Date.now(),
    hop: () => new Promise<void>((resolve) => { setTimeout(resolve, 0); }),
    changeCount,
  };
}

/** A wire number is validated at the boundary, never silently corrected: a caller that
 *  asked for `--budget 0` and got 64 KB learns the wrong thing about this command.
 *
 *  The upper bound is enforced HERE as well as at the CLI because the WIRE is the trust
 *  boundary — the CLI is one client of it. Without this, `budgetBytes: 1_073_741_824` from
 *  any other client has the designer's plugin accumulate an unbounded `nodes[]` until it
 *  dies mid-session. */
function bounded(params: Params, key: string, fallback: number, max: number): number {
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

function maxDepth(params: Params): number {
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

async function resolveTarget(params: Params, env: GetContextEnv): Promise<ContextNodeLike> {
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

export async function opGetContext(params: Params, env: GetContextEnv): Promise<Record<string, unknown>> {
  const budgetBytes = bounded(params, 'budgetBytes', DEFAULT_CONTEXT_BUDGET_BYTES, CHUNK_LIMIT);
  const deadlineMs = bounded(params, 'deadlineMs', DEFAULT_CONTEXT_DEADLINE_MS, EXEC_JS_MAX_TIMEOUT_MS);
  const depth = maxDepth(params);
  const includeCss = params.noCss !== true;
  const node = await resolveTarget(params, env);

  const changesBefore = env.changeCount();
  const walk = await walkContext(node, { now: env.now, hop: env.hop }, {
    budgetBytes, maxDepth: depth, deadlineAt: env.now() + deadlineMs, includeCss,
  });
  // Ref resolution runs AFTER the walk and therefore OUTSIDE the soft deadline: it is one
  // lookup per distinct id, which is the headroom between the deadline and the wire timeout.
  // Measured rather than assumed, so a file whose ref tables cost more than that headroom
  // shows up as a number instead of as a mystery E_TIMEOUT.
  const refsStartedAt = env.now();
  const refs = await resolveContextRefs(walk.nodes, env.refs);
  const refsMs = env.now() - refsStartedAt;
  // A designer editing mid-walk produces a tree read across two document states. Two
  // honesty caveats live in this name: the batches are DOCUMENT-WIDE (`soleActorChangeEvents`
  // counts every batch, not edits inside the walked subtree), and the count is a LOWER
  // BOUND — a batch landing while a second dispatch is in flight is attributed to neither
  // (see readonly-guard.ts). A conservative bound the caller can see beats a clean zero.
  const changeBatchesDuringWalk = Math.max(0, env.changeCount() - changesBefore);

  const payload = { nodes: walk.nodes, refs };
  return {
    schema: CONTEXT_SCHEMA,
    nodeId: String(walk.nodes[0]?.id ?? ''),
    ...payload,
    budget: {
      ...walk.accounting,
      // `--budget` bounds the node RECORDS (`estimatedBytes`), measured in the plugin
      // before the wire. The ref tables are resolved AFTER the walk and are NOT budgeted —
      // so they are measured and reported on their own rather than folded into a total the
      // caller would read as bounded. `finalBytes` is the whole payload as it goes out.
      refsBytes: utf8ByteLength(JSON.stringify(refs)),
      finalBytes: utf8ByteLength(JSON.stringify(payload)),
      refsMs,
      changeBatchesDuringWalk,
    },
  };
}
