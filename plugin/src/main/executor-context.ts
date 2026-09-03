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
import { assertDedupConservation, dedupContextPayload } from '../../../shared/context-dedup';
import { CHUNK_LIMIT, CONTEXT_SCHEMA, EXEC_JS_MAX_TIMEOUT_MS } from '../../../shared/protocol';
import { utf8ByteLength } from '../../../shared/utf8-byte-length';
import { createContextIntentReader, noDevResourcesRead, readSubtreeDevResources } from './context-intent';
import type { ContextNodeLike } from './context-node-record';
import {
  contextBoundedNumber, contextFlag, contextMaxDepth, resolveContextTarget,
} from './context-params';
import { resolveContextRefs, type ContextRefsDeps } from './context-refs';
import { walkContext } from './context-walk';

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


export async function opGetContext(params: Params, env: GetContextEnv): Promise<Record<string, unknown>> {
  const budgetBytes = contextBoundedNumber(params, 'budgetBytes', DEFAULT_CONTEXT_BUDGET_BYTES, CHUNK_LIMIT);
  const deadlineMs = contextBoundedNumber(params, 'deadlineMs', DEFAULT_CONTEXT_DEADLINE_MS, EXEC_JS_MAX_TIMEOUT_MS);
  const depth = contextMaxDepth(params);
  const includeCss = params.noCss !== true;
  const dedup = contextFlag(params, 'dedup');
  const node = await resolveContextTarget(params, env);

  // Dev resources are OPT-IN, and the reason is measured rather than assumed: on the owner's
  // Free file `getDevResourcesAsync({includeChildren: true})` costs a FIXED ~2.1s whatever the
  // subtree size (11 nodes 2115ms, 121 nodes 2060ms, a 453-node page 2149ms). It is a server
  // round trip, not a walk, and reading it unconditionally put ~2s onto a command whose
  // `--no-css` fast path measured 124ms. So: no flag, no read, no block.
  //
  // When it IS asked for, the read runs before the walk that needs its map, OUTSIDE the soft
  // deadline and bounded by NEITHER `--budget` nor `--depth`. At `--depth 0` only one record
  // can carry an answer, so it narrows to that node (`includeChildren: false`, measured
  // 408ms): still its own links, including any inherited from its main component.
  const wantDevResources = contextFlag(params, 'devResources');
  const devResourcesStartedAt = env.now();
  const devResources = wantDevResources
    ? await readSubtreeDevResources(node, { includeChildren: depth > 0 })
    : noDevResourcesRead();
  const devResourcesMs = wantDevResources ? env.now() - devResourcesStartedAt : 0;
  const intent = createContextIntentReader({ devResources });

  const changesBefore = env.changeCount();
  const walk = await walkContext(node, { now: env.now, hop: env.hop }, {
    budgetBytes,
    maxDepth: depth,
    // The dev-resource read is CHARGED against the soft deadline, not spent on top of it.
    // `deadlineMs` is the wire timeout minus 2s of headroom so the plugin can get a
    // partial-with-counts onto the wire before the CLI gives up; starting the deadline clock
    // after a fixed ~2s read hands the walk its full budget anyway and pushes the wall clock
    // past the wire timeout, so the caller gets E_TIMEOUT instead of the partial. Never zero
    // or negative: a read that ate the whole deadline still leaves the root emitted.
    deadlineAt: env.now() + Math.max(1, deadlineMs - devResourcesMs),
    includeCss,
    buildRecord: intent.buildRecord,
  });
  // Ref resolution runs AFTER the walk and therefore OUTSIDE the soft deadline: it is one
  // lookup per distinct id, which is the headroom between the deadline and the wire timeout.
  // Measured rather than assumed, so a file whose ref tables cost more than that headroom
  // shows up as a number instead of as a mystery E_TIMEOUT.
  const refsStartedAt = env.now();
  const refs = await resolveContextRefs(walk.nodes, env.refs);
  const refsMs = env.now() - refsStartedAt;
  // The component intent was resolved once per KEY during the walk; the identity table is
  // where it belongs, so forty instances of one button carry a key, not forty descriptions.
  // The walk's own `{name}` wins on the name it already read.
  for (const [key, component] of Object.entries(intent.components())) {
    // The walk's row wins, EXCEPT on an empty name: `context-refs.ts` falls back to `''` when
    // the main component's name read refused, and letting that placeholder overwrite the name
    // intent actually read would trade a fact for a blank.
    const walked = refs.components[key];
    const name = typeof walked?.name === 'string' && walked.name !== '' ? walked.name : component.name;
    refs.components[key] = { ...component, ...walked, name };
  }
  // A designer editing mid-walk produces a tree read across two document states. Two
  // honesty caveats live in this name: the batches are DOCUMENT-WIDE (`soleActorChangeEvents`
  // counts every batch, not edits inside the walked subtree), and the count is a LOWER
  // BOUND — a batch landing while a second dispatch is in flight is attributed to neither
  // (see readonly-guard.ts). A conservative bound the caller can see beats a clean zero.
  const changeBatchesDuringWalk = Math.max(0, env.changeCount() - changesBefore);

  // Dedup is a POST-walk transform, which is exactly why `--budget`'s meaning is unchanged:
  // the budget bounded the raw records as they were built (`estimatedBytes`), and what the
  // transformed payload costs is `finalBytes`. Whether it was worth applying is the
  // transform's own honest decision — the raw form ships with `applied: false` and a reason
  // when the deduped one would not be smaller.
  // `{ ...refs }` rather than `refs`: the transform is pure and takes an open record, and a
  // copy is also what keeps the walk's own tables out of reach of it.
  const transformed = dedup ? dedupContextPayload({ nodes: walk.nodes, refs: { ...refs } }) : null;
  const payload = transformed === null
    ? { nodes: walk.nodes, refs }
    : { nodes: transformed.nodes, refs: transformed.refs };
  const attached = intent.attachedDevResources();
  // The reply-level law after folding: every record the walk emitted is either still in
  // `nodes[]` or counted as folded into a template occurrence. Asserted here as well as
  // inside the transform because THIS is the object that goes on the wire.
  assertDedupConservation(
    walk.accounting.emitted, payload.nodes.length, transformed?.dedup.foldedNodes ?? 0,
  );
  return {
    schema: CONTEXT_SCHEMA,
    nodeId: String(walk.nodes[0]?.id ?? ''),
    ...payload,
    ...(transformed !== null && { dedup: transformed.dedup }),
    budget: {
      ...walk.accounting,
      // `--budget` bounds the node RECORDS (`estimatedBytes`), measured in the plugin
      // before the wire. The ref tables are resolved AFTER the walk and are NOT budgeted —
      // so they are measured and reported on their own rather than folded into a total the
      // caller would read as bounded. `finalBytes` is the whole payload as it goes out.
      // Under `--dedup` this covers the WHOLE `refs` object, so it includes `literals` and
      // `templates` — content, not only identity tables.
      refsBytes: utf8ByteLength(JSON.stringify(payload.refs)),
      finalBytes: utf8ByteLength(JSON.stringify(payload)),
      refsMs,
      changeBatchesDuringWalk,
      // Present whenever `--dev-resources` was passed, INCLUDING at `found: 0`. Presence then
      // means exactly "you asked", so a caller can tell "this subtree has none" from "nobody
      // looked" — and `readMs` keeps the ~2s round trip visible rather than mysterious.
      // `attached` counts the EMITTED records a resource landed on, so `attached < found`
      // means the rest belong to nodes that are not in this reply: descendants the budget or
      // the deadline never enqueued (below the frontier), nodes outside the `--depth` bound,
      // or a record whose own identity read refused and which therefore carries no intent.
      ...(wantDevResources && {
        devResources: {
          found: devResources.found,
          attached,
          // Present only when it happened: links the read returned that name no readable node
          // id, and which therefore could not be attached to anything.
          ...(devResources.unaddressed > 0 && { unaddressed: devResources.unaddressed }),
          readMs: devResourcesMs,
          ...(devResources.error !== undefined && { error: devResources.error }),
        },
      }),
    },
  };
}
