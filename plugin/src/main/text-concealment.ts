// Concealed text: is this TEXT node something a human reviewing the canvas can SEE?
//
// Text the eye never meets is still text an agent reads — a hidden layer, a 0.01-opacity
// frame, a 1px font, a string parked outside its clipping frame. Carried into an agent's
// context unmarked, it reads exactly like the visible copy, which makes it a prompt-injection
// channel nobody reviewing the design would ever notice. The answer is a FLAG, never a strip:
// the characters stay on the record (the reader still needs the truth about the file), and
// `concealed.reasons` says why a human would not have seen them. Visible text gets no key.
//
// One pure, sync function, shared by all three read paths (scan-node walker, `context`
// record, `ui.textConcealment`) so they can never disagree about the same node.
//
// Refusal handling is the load-bearing part. Under `documentAccess: "dynamic-page"` a
// getter can THROW, and `figma.mixed` reads back as a symbol. `safe()` would collapse a
// throw into "absent", and absent is NEUTRAL here — so a refusal would pass as "visible".
// Every read therefore goes through `probe`, which tells a throw apart; a throw becomes
// the reason `unknown`, never a crash and never a silent pass.

export type ConcealmentReason = 'invisible' | 'transparent' | 'tiny' | 'clipped' | 'unknown';

export interface Concealment {
  reasons: ConcealmentReason[];
}

/** Per-walk memo: node → its resolved ancestor chain. Create ONE per walk / per scan and
 *  pass it down; a module-level map would outlive the canvas state it describes. */
export type ConcealmentMemo = WeakMap<object, unknown>;

type NodeLike = Record<string, unknown>;

interface Box { x: number; y: number; width: number; height: number }

/** The folded facts of a node's ancestor chain, up to (not including) the page. */
interface Chain {
  hidden: boolean;
  opacity: number;
  clips: Box[];
  unknown: boolean;
  /** Ancestors from this node up to the page, this node included. */
  hops: number;
}

/** Below this, opacity (the product through ancestors) or a paint's alpha is not visible. */
export const MIN_VISIBLE_ALPHA = 0.05;
/** Below this font size (px), text is not readable. */
export const MIN_READABLE_FONT_SIZE = 4;
/** Ancestor walk cap; past it the answer is `unknown`, never a guess. */
export const MAX_ANCESTOR_HOPS = 64;

const REASON_ORDER: readonly ConcealmentReason[] = ['invisible', 'transparent', 'tiny', 'clipped', 'unknown'];
const EMPTY_CHAIN: Chain = { hidden: false, opacity: 1, clips: [], unknown: false, hops: 0 };

type Probe = { ok: true; value: unknown } | { ok: false };

function probe(read: () => unknown): Probe {
  try {
    return { ok: true, value: read() };
  } catch {
    return { ok: false };
  }
}

const isObject = (v: unknown): v is NodeLike => typeof v === 'object' && v !== null;

function asBox(v: unknown): Box | null {
  if (!isObject(v)) return null;
  const { x, y, width, height } = v;
  return typeof x === 'number' && typeof y === 'number' && typeof width === 'number' && typeof height === 'number'
    ? { x, y, width, height }
    : null;
}

/** Boxes share no area. Touching edges share none, so they count as outside. */
function disjoint(a: Box, b: Box): boolean {
  return a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
}

const isPageLike = (type: unknown): boolean => type === 'PAGE' || type === 'DOCUMENT';

/** One ancestor's own contribution. Every getter is read here, once. */
function readAncestor(node: NodeLike): { own: Omit<Chain, 'hops'>; parent: unknown } | 'page' {
  let unknown = false;
  const read = (field: string): unknown => {
    const r = probe(() => node[field]);
    if (!r.ok) { unknown = true; return undefined; }
    return r.value;
  };
  const type = read('type');
  if (isPageLike(type)) return 'page'; // the chain ends below the page
  const visible = read('visible');
  const opacity = read('opacity');
  const clips: Box[] = [];
  // SECTION / GROUP are organisational: neither clips its content in a way this reader
  // models, so neither is ever the reason text is flagged as clipped.
  if (type !== 'SECTION' && type !== 'GROUP' && read('clipsContent') === true) {
    const box = asBox(read('absoluteBoundingBox'));
    if (box) clips.push(box);
  }
  const parent = read('parent');
  return {
    own: {
      hidden: visible === false,
      opacity: typeof opacity === 'number' ? opacity : 1,
      clips,
      unknown,
    },
    parent,
  };
}

/**
 * The folded chain of `start` (an ancestor of the text) up to the page. Walks up only
 * until it meets a node already in the memo, then folds back down, caching every node on
 * the way — so sibling texts share one read of each ancestor.
 */
function chainOf(start: unknown, memo: ConcealmentMemo): Chain {
  const pending: { node: NodeLike; own: Omit<Chain, 'hops'> }[] = [];
  let base: Chain = EMPTY_CHAIN;
  let cur: unknown = start;
  while (isObject(cur)) {
    const cached = memo.get(cur) as Chain | undefined;
    if (cached) { base = cached; break; }
    if (pending.length > MAX_ANCESTOR_HOPS) {
      // Never reached the page: whatever sits above is not known.
      base = { ...EMPTY_CHAIN, unknown: true, hops: MAX_ANCESTOR_HOPS + 1 };
      break;
    }
    const read = readAncestor(cur);
    if (read === 'page') break;
    pending.push({ node: cur, own: read.own });
    cur = read.parent;
  }
  let chain = base;
  for (let i = pending.length - 1; i >= 0; i -= 1) {
    const { node, own } = pending[i];
    const hops = chain.hops + 1;
    chain = {
      hidden: own.hidden || chain.hidden,
      opacity: own.opacity * chain.opacity,
      clips: own.clips.length ? [...chain.clips, ...own.clips] : chain.clips,
      unknown: own.unknown || chain.unknown || hops > MAX_ANCESTOR_HOPS,
      hops,
    };
    memo.set(node, chain);
  }
  return chain;
}

/** A paint a human can see: shown, alpha above the threshold, and (for a gradient) at
 *  least one stop that is not fully transparent. */
function paintVisible(p: unknown): boolean {
  if (!isObject(p) || p.visible === false) return false;
  const alpha = typeof p.opacity === 'number' ? p.opacity : 1;
  if (alpha < MIN_VISIBLE_ALPHA) return false;
  if (Array.isArray(p.gradientStops)) {
    return p.gradientStops.some((s) => isObject(s) && isObject(s.color)
      && (typeof s.color.a !== 'number' || s.color.a * alpha >= MIN_VISIBLE_ALPHA));
  }
  return true;
}

const anyVisible = (paints: unknown): boolean => Array.isArray(paints) && paints.some(paintVisible);

/** The styled segments for one field, or `null` when they cannot be read. */
function segments(node: NodeLike, field: string): NodeLike[] | null {
  const fn = probe(() => node.getStyledTextSegments);
  if (!fn.ok || typeof fn.value !== 'function') return null;
  const read = probe(() => (fn.value as (fields: string[]) => unknown).call(node, [field]));
  if (!read.ok || !Array.isArray(read.value)) return null;
  return read.value.filter(isObject);
}

/**
 * Why a human would not see this TEXT node, or `null` when nothing conceals it.
 *
 * A missing property is NEUTRAL (opacity 1, no clipping, no parent ends the chain); only a
 * getter that THROWS — or a walk past MAX_ANCESTOR_HOPS — yields `unknown`.
 */
export function readConcealment(node: NodeLike, memo: ConcealmentMemo): Concealment | null {
  const found = new Set<ConcealmentReason>();
  const read = (field: string): unknown => {
    const r = probe(() => node[field]);
    if (!r.ok) { found.add('unknown'); return undefined; }
    return r.value;
  };

  const parent = read('parent');
  const chain = chainOf(parent, memo);
  if (chain.unknown) found.add('unknown');

  if (read('visible') === false || chain.hidden) found.add('invisible');

  const opacity = read('opacity');
  const effective = (typeof opacity === 'number' ? opacity : 1) * chain.opacity;
  if (effective < MIN_VISIBLE_ALPHA) found.add('transparent');

  const fills = read('fills');
  const strokes = read('strokes');
  const strokeWeight = read('strokeWeight');
  const strokeShows = strokeWeight !== 0 && anyVisible(strokes);
  if (!strokeShows) {
    if (typeof fills === 'symbol') {
      // figma.mixed: the runs carry the fills. Transparent only if NO run shows paint.
      const runs = segments(node, 'fills');
      if (runs === null) found.add('unknown');
      else if (!runs.some((run) => anyVisible(run.fills))) found.add('transparent');
    } else if (fills !== undefined && !anyVisible(fills)) {
      found.add('transparent');
    }
  }

  const fontSize = read('fontSize');
  if (typeof fontSize === 'number') {
    if (fontSize < MIN_READABLE_FONT_SIZE) found.add('tiny');
  } else if (typeof fontSize === 'symbol') {
    const runs = segments(node, 'fontSize');
    const sizes = runs?.map((run) => run.fontSize).filter((s): s is number => typeof s === 'number') ?? [];
    if (runs === null) found.add('unknown');
    else if (sizes.length && Math.min(...sizes) < MIN_READABLE_FONT_SIZE) found.add('tiny');
  }

  if (chain.clips.length) {
    const box = asBox(read('absoluteBoundingBox'));
    if (box && chain.clips.some((clip) => disjoint(box, clip))) found.add('clipped');
  }

  if (found.size === 0) return null;
  return { reasons: REASON_ORDER.filter((r) => found.has(r)) };
}
