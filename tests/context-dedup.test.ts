// `context --dedup` — the round-trip invariant that GATES the feature, plus the corpus of
// hostile pairs the ruling names by hand.
//
// Why the invariant and not a size assertion: a content-hash dedup that loses a name, a
// position or a style identity still gets SMALLER. Bytes prove nothing about honesty. The
// only test that does is `inflate(dedup(x)) deepEquals x` over a corpus built out of the
// exact confusions dedup can commit: two differently-NAMED styles holding the same value,
// two instances of one component with different props, a visible/hidden twin pair, a bound
// node beside a literal one with the same resolved block, and two identical subtrees beside
// one that differs by a single word.
//
// The size assertion runs HERE, in `npm test`, not in a script — the competitor pitfall this
// phase must not regress into is a size benchmark that lives outside CI and never runs.
//
// The css and layout blocks below are deliberately the SIZE the live reader produces (the
// controller measured a 121-node frame at 60 KB with CSS, 37 KB without — repeated css and
// layout blocks are the bulk). A corpus of two-declaration toy blocks would make the
// applied/not decision answer "not smaller" every time and the invariant would then be
// proving the identity transform.
import { describe, expect, it } from 'vitest';
import { dedupContextPayload } from '../shared/context-dedup.ts';
import { foldContextLiterals } from '../shared/context-dedup-literals.ts';
import { foldContextTemplates } from '../shared/context-dedup-templates.ts';
import { inflateContextReply } from '../cli/src/commands/context-inflate.ts';
import { utf8ByteLength } from '../shared/utf8-byte-length.ts';

type Record_ = Record<string, unknown>;
interface Payload { nodes: Record_[]; refs: Record_ }

const emptyRefs = (): Record_ => ({ variables: {}, styles: {}, components: {} });

/** Live-sized blocks: what `getCSSAsync` and the layout summary actually return. */
const rowCss = (): Record_ => ({
  display: 'flex',
  'flex-direction': 'row',
  'align-items': 'center',
  gap: '4px',
  padding: '8px 12px',
  'border-radius': '6px',
  background: 'var(--color-surface-default, #FFFFFF)',
});
const textCss = (): Record_ => ({
  color: 'var(--color-text-primary, #111111)',
  'font-family': 'Inter',
  'font-size': '12px',
  'font-weight': 500,
  'line-height': '16px',
  'letter-spacing': '0.01em',
});
const flatTextCss = (): Record_ => ({
  color: '#111111',
  'font-family': 'Inter',
  'font-size': '12px',
  'font-weight': 500,
  'line-height': '16px',
  'letter-spacing': '0.01em',
});
const iconCss = (): Record_ => ({ width: '16px', height: '16px', 'aspect-ratio': '1/1', overflow: 'hidden' });
const rowLayout = (): Record_ => ({
  layoutMode: 'HORIZONTAL', sizingH: 'FILL', sizingV: 'HUG', gap: 4,
  padding: [8, 12, 8, 12], w: 320, h: 32, x: 0, y: 0,
});

/** A reply in the shape `executor-context.ts` assembles, so the corpus exercises the object
 *  that actually travels rather than a stripped-down stand-in. */
function reply(payload: Payload): Record_ {
  return {
    schema: 'context/1',
    nodeId: String(payload.nodes[0]?.id ?? ''),
    nodes: payload.nodes,
    refs: payload.refs,
    budget: { requestedBytes: 65_536, emitted: payload.nodes.length, complete: true },
  };
}

/** dedup exactly as the executor applies it: the transform's `nodes`/`refs`/`dedup` spread
 *  over the reply it came from. */
function dedupReply(raw: Record_): Record_ {
  const out = dedupContextPayload({ nodes: raw.nodes as Record_[], refs: raw.refs as Record_ });
  return { ...raw, nodes: out.nodes, refs: out.refs, dedup: out.dedup };
}

const bytes = (r: Record_): number => utf8ByteLength(JSON.stringify({ nodes: r.nodes, refs: r.refs }));

// ---------------------------------------------------------------------------- the corpus

/** Two text nodes whose resolved CSS is byte-identical but whose STYLE IDS differ. The
 *  ruling's headline wrong fact: `color/text/primary` and `color/border/strong` are both
 *  #111 and mean different things. The literal block may be shared; the identities may not. */
function sameValueDifferentNameStyles(): Payload {
  return {
    nodes: [
      { id: '1:1', name: 'Root', type: 'FRAME', depth: 0, parentId: null, visible: true, childCount: 2, layout: rowLayout(), css: rowCss() },
      { id: '1:2', name: 'Heading', type: 'TEXT', depth: 1, parentId: '1:1', visible: true, childCount: 0, styles: { fill: 'S:1' }, characters: 'Title', css: flatTextCss() },
      { id: '1:3', name: 'Divider', type: 'TEXT', depth: 1, parentId: '1:1', visible: true, childCount: 0, styles: { fill: 'S:2' }, characters: 'Sub', css: flatTextCss() },
    ],
    refs: {
      variables: {},
      styles: { 'S:1': { name: 'color/text/primary', type: 'PAINT' }, 'S:2': { name: 'color/border/strong', type: 'PAINT' } },
      components: {},
    },
  };
}

/** One component, two instances, different props. Props are part of the signature, so these
 *  must NOT share a template however similar everything else is. */
function sameComponentDifferentProps(): Payload {
  return {
    nodes: [
      { id: '2:1', name: 'Bar', type: 'FRAME', depth: 0, parentId: null, visible: true, childCount: 2, layout: rowLayout(), css: rowCss() },
      { id: '2:2', name: 'Save', type: 'INSTANCE', depth: 1, parentId: '2:1', visible: true, childCount: 0, mainComponent: { key: 'K1', name: 'Button' }, componentProperties: { Label: { value: 'Save', type: 'TEXT' } }, layout: rowLayout(), css: rowCss() },
      { id: '2:3', name: 'Cancel', type: 'INSTANCE', depth: 1, parentId: '2:1', visible: true, childCount: 0, mainComponent: { key: 'K1', name: 'Button' }, componentProperties: { Label: { value: 'Cancel', type: 'TEXT' } }, layout: rowLayout(), css: rowCss() },
    ],
    refs: { variables: {}, styles: {}, components: { K1: { name: 'Button' } } },
  };
}

/** Identical in every field but `visible`. `visible` is in the signature, so these are two
 *  templates' worth of difference — and at one node each they are not templatable anyway. */
function visibleHiddenTwins(): Payload {
  const shared = (): Record_ => ({
    type: 'RECTANGLE', depth: 1, parentId: '3:1', childCount: 0, layout: rowLayout(), css: iconCss(),
  });
  return {
    nodes: [
      { id: '3:1', name: 'Row', type: 'FRAME', depth: 0, parentId: null, visible: true, childCount: 2, layout: rowLayout(), css: rowCss() },
      { id: '3:2', name: 'Dot', ...shared(), visible: true },
      { id: '3:3', name: 'Dot', ...shared(), visible: false },
    ],
    refs: emptyRefs(),
  };
}

/** One node binds a variable for its gap, the other states the same literal gap. The layout
 *  blocks are identical; the binding is not, and must survive on the one node that has it.
 *  Their CSS differs precisely because the declaration is verbatim — which is how a
 *  var(--token, #hex) fallback protects the token's name from a content hash. */
function boundVersusLiteralTwins(): Payload {
  return {
    nodes: [
      { id: '4:1', name: 'Root', type: 'FRAME', depth: 0, parentId: null, visible: true, childCount: 2, layout: rowLayout(), css: rowCss() },
      { id: '4:2', name: 'Bound', type: 'TEXT', depth: 1, parentId: '4:1', visible: true, childCount: 0, bindings: { itemSpacing: 'V:1' }, characters: 'Bound', layout: rowLayout(), css: textCss() },
      { id: '4:3', name: 'Literal', type: 'TEXT', depth: 1, parentId: '4:1', visible: true, childCount: 0, characters: 'Literal', layout: rowLayout(), css: flatTextCss() },
    ],
    refs: {
      variables: { 'V:1': { name: 'space/2', collection: 'Primitives', modeCount: 1 } },
      styles: {}, components: {},
    },
  };
}

/** Two subtrees whose ONLY difference is a `bindings` entry on the child — same css, same
 *  layout, same everything else. A subtree signature that dropped `bindings` (it is not in
 *  the `PER_OCCURRENCE` per-node exclusion list, and must not be) would treat these two
 *  subtrees as one repeated template; the second occurrence's real "this value is bound to
 *  V:1" fact would then be replaced by the first occurrence's bound content on inflate. */
function boundVersusLiteralTemplateTwins(): Payload {
  const child = (id: string, parentId: string, bound: boolean): Record_ => ({
    id, name: 'Child', type: 'TEXT', depth: 1, parentId, visible: true, childCount: 0,
    ...(bound && { bindings: { itemSpacing: 'V:1' } }), characters: 'Hi', css: textCss(),
  });
  return {
    nodes: [
      { id: '8:1', name: 'RootA', type: 'FRAME', depth: 0, parentId: null, visible: true, childCount: 1, layout: rowLayout(), css: rowCss() },
      child('8:2', '8:1', true),
      { id: '8:3', name: 'RootB', type: 'FRAME', depth: 0, parentId: null, visible: true, childCount: 1, layout: rowLayout(), css: rowCss() },
      child('8:4', '8:3', false),
    ],
    refs: {
      variables: { 'V:1': { name: 'space/1', collection: 'Primitives', modeCount: 1 } },
      styles: {}, components: {},
    },
  };
}

/** Two identical 3-node rows plus one that differs by a single word of text. The one case
 *  where templating is meant to pay, and the near-miss that must stay raw. */
function repeatedSubtrees(): Payload {
  const row = (id: string, name: string): Record_ => ({
    id, name, type: 'FRAME', depth: 1, parentId: '5:1', visible: true, childCount: 2,
    bindings: { itemSpacing: 'V:1' }, layout: rowLayout(), css: rowCss(),
  });
  const label = (id: string, parentId: string, text: string): Record_ => ({
    id, name: 'Label', type: 'TEXT', depth: 2, parentId, visible: true, childCount: 0, characters: text, css: textCss(),
  });
  const icon = (id: string, parentId: string): Record_ => ({
    id, name: 'Icon', type: 'VECTOR', depth: 2, parentId, visible: true, childCount: 0, css: iconCss(),
  });
  return {
    nodes: [
      { id: '5:1', name: 'List', type: 'FRAME', depth: 0, parentId: null, visible: true, childCount: 3, layout: rowLayout(), css: rowCss() },
      row('5:2', 'Row A'), row('5:3', 'Row B'), row('5:4', 'Row C'),
      label('5:5', '5:2', 'Hello'), icon('5:6', '5:2'),
      label('5:7', '5:3', 'Hello'), icon('5:8', '5:3'),
      label('5:9', '5:4', 'Goodbye'), icon('5:10', '5:4'),
    ],
    refs: {
      variables: { 'V:1': { name: 'space/1', collection: 'Primitives', modeCount: 1 } },
      styles: {}, components: {},
    },
  };
}

/** A record whose own identity read refused ships as a minimal `{id, readError}` — no name,
 *  no parentId, no depth. Nothing may claim to restore what it never carried. */
function refusedIdentityRecords(): Payload {
  return {
    nodes: [
      { id: '6:1', name: 'Root', type: 'FRAME', depth: 0, parentId: null, visible: true, childCount: 2, layout: rowLayout(), css: rowCss() },
      { id: '(unreadable child 0 of 6:1)', readError: 'The node with id "6:2" does not exist' },
      { id: '(unreadable child 1 of 6:1)', readError: 'The node with id "6:3" does not exist' },
    ],
    refs: emptyRefs(),
  };
}

/** Nothing repeats anywhere: the transform must ship the RAW form and say why. */
function nothingRepeated(): Payload {
  return {
    nodes: [
      { id: '7:1', name: 'Only', type: 'FRAME', depth: 0, parentId: null, visible: true, childCount: 0, layout: rowLayout(), css: rowCss() },
    ],
    refs: emptyRefs(),
  };
}

const corpus: [string, () => Payload][] = [
  ['same-value different-name styles', sameValueDifferentNameStyles],
  ['same-component different-props instances', sameComponentDifferentProps],
  ['visible/hidden twins', visibleHiddenTwins],
  ['bound-vs-literal twins', boundVersusLiteralTwins],
  ['bound-vs-literal template twins', boundVersusLiteralTemplateTwins],
  ['two identical subtrees + one near-identical', repeatedSubtrees],
  ['refused-identity records', refusedIdentityRecords],
  ['nothing repeated', nothingRepeated],
];

// ------------------------------------------------------------------------- the invariants

describe('context --dedup — the round-trip invariant', () => {
  it.each(corpus)('inflate(dedup(x)) deepEquals x — %s', (_name, build) => {
    expect(inflateContextReply(dedupReply(reply(build())))).toEqual(reply(build()));
  });

  it.each(corpus)('deduped bytes never exceed raw bytes — %s', (_name, build) => {
    expect(bytes(dedupReply(reply(build())))).toBeLessThanOrEqual(bytes(reply(build())));
  });

  it.each(corpus)('applied is always present, savedBytes only when > 0 — %s', (_name, build) => {
    const out = dedupReply(reply(build())).dedup as { applied: boolean; savedBytes?: number; reason?: string };
    expect(typeof out.applied).toBe('boolean');
    if (out.applied) {
      expect(out.savedBytes).toBeGreaterThan(0);
      expect(out.reason).toBeUndefined();
    } else {
      // A reduction that reduced nothing must never be announced as one, and the reason is a
      // field the caller can read rather than an absence it has to infer.
      expect(out.savedBytes).toBeUndefined();
      expect(typeof out.reason).toBe('string');
    }
  });

  it('actually saves bytes on the corpus entries built to repeat', () => {
    for (const build of [sameValueDifferentNameStyles, visibleHiddenTwins, boundVersusLiteralTwins, repeatedSubtrees]) {
      const out = dedupReply(reply(build())).dedup as { applied: boolean };
      expect(out.applied).toBe(true);
    }
  });

  it('counts every folded record, so the reply-level law stays checkable', () => {
    for (const build of corpus.map(([, fn]) => fn)) {
      const payload = build();
      const out = dedupContextPayload(payload);
      if (!out.dedup.applied) continue;
      // `savedBytes` counts BYTES. Records that went into a template occurrence need their
      // own counter, or the caller cannot tell a folded node from one that never arrived.
      expect(typeof out.dedup.foldedNodes).toBe('number');
      expect(out.nodes.length + (out.dedup.foldedNodes as number)).toBe(payload.nodes.length);
    }
  });

  it('gives every inflated record its own nested objects', () => {
    // `nodes[0].css === nodes[1].css` after inflate means one shared object behind two
    // records: an agent that normalises one declaration silently rewrites the other, and a
    // reply that describes two nodes describes one.
    const back = inflateContextReply(dedupReply(reply(sameValueDifferentNameStyles()))) as { nodes: Record_[] };
    expect(back.nodes[1].css).toEqual(back.nodes[2].css);
    expect(back.nodes[1].css).not.toBe(back.nodes[2].css);
    const rows = inflateContextReply(dedupReply(reply(repeatedSubtrees()))) as { nodes: Record_[] };
    const [a, b] = rows.nodes.filter((n) => n.name === 'Label');
    expect(a.css).toEqual(b.css);
    expect(a.css).not.toBe(b.css);
    // And a NON-literal field, which the literal table cannot accidentally clone on the way
    // out: one template feeds every occurrence, so `bindings` is the field that catches a
    // shallow spread of the template node itself.
    const [rowA, rowB] = rows.nodes.filter((n) => n.name === 'Row A' || n.name === 'Row B');
    expect(rowA.bindings).toEqual(rowB.bindings);
    expect(rowA.bindings).not.toBe(rowB.bindings);
  });

  it('does not mutate the payload it was handed', () => {
    const payload = repeatedSubtrees();
    const before = JSON.stringify(payload);
    dedupContextPayload(payload);
    expect(JSON.stringify(payload)).toBe(before);
  });
});

describe('context --dedup — identity is never content', () => {
  it('shares an identical css block while keeping two different style ids apart', () => {
    const payload = sameValueDifferentNameStyles();
    const out = foldContextLiterals(payload.nodes);
    const [, a, b] = out.nodes;
    expect(a.cssRef).toBe(b.cssRef);
    expect(a.css).toBeUndefined();
    // The whole point: the block is shared, the identities are not.
    expect(a.styles).toEqual({ fill: 'S:1' });
    expect(b.styles).toEqual({ fill: 'S:2' });
    expect(out.literals[a.cssRef as string]).toEqual(flatTextCss());
  });

  it('passes the walk-resolved identity tables through untouched', () => {
    const out = dedupContextPayload(sameValueDifferentNameStyles());
    expect(out.refs.styles).toEqual({
      'S:1': { name: 'color/text/primary', type: 'PAINT' },
      'S:2': { name: 'color/border/strong', type: 'PAINT' },
    });
    expect(out.refs.variables).toEqual({});
  });

  it('keeps a binding on the node that has it while sharing the resolved layout block', () => {
    const out = foldContextLiterals(boundVersusLiteralTwins().nodes);
    const [, bound, literal] = out.nodes;
    expect(bound.layoutRef).toBe(literal.layoutRef);
    expect(bound.bindings).toEqual({ itemSpacing: 'V:1' });
    expect(literal.bindings).toBeUndefined();
    // Their CSS differs (`var(--color-text-primary, #111111)` vs `#111111`), so those blocks
    // are NOT shared — a verbatim declaration is what protects the token's name.
    expect(bound.cssRef).toBeUndefined();
    expect(literal.cssRef).toBeUndefined();
  });

  it('never folds a block that occurs only once', () => {
    const out = foldContextLiterals(nothingRepeated().nodes);
    expect(out.literals).toEqual({});
    expect(out.nodes[0].css).toEqual(rowCss());
  });

  it('refuses to template two instances of one component with different props', () => {
    const out = foldContextTemplates(sameComponentDifferentProps().nodes);
    expect(out.templates).toEqual({});
    expect(out.nodes.map((n) => n.templateRef)).toEqual([undefined, undefined, undefined]);
  });

  it('refuses to template a visible/hidden twin pair', () => {
    expect(foldContextTemplates(visibleHiddenTwins().nodes).templates).toEqual({});
  });
});

describe('context --dedup — subtree templates', () => {
  it('folds the two identical rows and leaves the near-identical one raw', () => {
    const out = foldContextTemplates(repeatedSubtrees().nodes);
    expect(Object.keys(out.templates)).toHaveLength(1);
    const [hash] = Object.keys(out.templates);
    // 10 raw records → the root, three rows, and Row C's two children: the two folded rows
    // shed 2 descendants each.
    expect(out.nodes).toHaveLength(6);
    const occurrences = out.nodes.filter((n) => n.templateRef === hash);
    expect(occurrences.map((n) => n.id)).toEqual(['5:2', '5:3']);
    // An occurrence keeps every fact that is per-occurrence: its own identity, its place in
    // the tree, and its descendants' ids, names and list positions.
    expect(occurrences[0]).toEqual({
      id: '5:2', name: 'Row A', type: 'FRAME', depth: 1, parentId: '5:1', templateRef: hash,
      rootMap: { 1: { id: '5:5', name: 'Label', at: 4 }, 2: { id: '5:6', name: 'Icon', at: 5 } },
    });
    expect(occurrences[1].rootMap).toEqual({
      1: { id: '5:7', name: 'Label', at: 6 }, 2: { id: '5:8', name: 'Icon', at: 7 },
    });
    // The template carries the shared structure with relative ids and NO name — a name is
    // per-occurrence by construction, which is what lets "Row A" and "Row B" share at all.
    const template = out.templates[hash];
    expect(template.nodes.map((n) => n.id)).toEqual(['0', '1', '2']);
    expect(template.nodes.map((n) => n.parentId)).toEqual([null, '0', '0']);
    expect(template.nodes.map((n) => n.depth)).toEqual([0, 1, 1]);
    expect(template.nodes.every((n) => n.name === undefined)).toBe(true);
    expect(template.nodes[1].characters).toBe('Hello');
    // Row C stayed whole.
    expect(out.nodes.filter((n) => n.templateRef === undefined).map((n) => n.id))
      .toEqual(['5:1', '5:4', '5:9', '5:10']);
  });

  it('never templates a record that cannot carry an identity', () => {
    const out = foldContextTemplates(refusedIdentityRecords().nodes);
    expect(out.templates).toEqual({});
    expect(out.nodes).toHaveLength(3);
  });

  it('reports why it did nothing on a subtree with nothing repeated', () => {
    const out = dedupContextPayload(nothingRepeated());
    expect(out.dedup.applied).toBe(false);
    expect(out.dedup.reason).toMatch(/nothing/i);
    expect(out.refs.literals).toBeUndefined();
    expect(out.refs.templates).toBeUndefined();
  });

  it('refuses a reduction that reduced nothing, even when a tiny block repeats', () => {
    // A one-key css block is small enough that adding the ref field plus the `refs.literals`
    // table costs as much as, or more than, the two inline copies it replaces — the case the
    // "not smaller" guard exists for, as opposed to "nothing repeated" (no candidate at all).
    const nodes: Record_[] = [
      { id: 'a', name: 'a', type: 'TEXT', depth: 0, parentId: null, css: { x: 1 } },
      { id: 'b', name: 'b', type: 'TEXT', depth: 0, parentId: null, css: { x: 1 } },
    ];
    const out = dedupContextPayload({ nodes, refs: emptyRefs() });
    expect(out.dedup.applied).toBe(false);
    expect(out.dedup.savedBytes).toBeUndefined();
    expect(out.dedup.foldedNodes).toBeUndefined();
    expect(typeof out.dedup.reason).toBe('string');
  });
});

describe('context --dedup — a hash is never trusted on its own', () => {
  // Two blocks a 32-bit hash genuinely collides on are not constructible by hand, so the
  // guard is driven directly: a hash function that answers the same string for everything.
  // A collision must produce a SECOND key, never a silently reused first one — a shared ref
  // has to mean byte-identical content, not equal hash, or dedup invents a fact.
  const twoBlocksTwiceEach = (): Record_[] => [
    { id: 'a', name: 'a', type: 'TEXT', depth: 0, parentId: null, css: flatTextCss() },
    { id: 'b', name: 'b', type: 'TEXT', depth: 0, parentId: null, css: flatTextCss() },
    { id: 'c', name: 'c', type: 'TEXT', depth: 0, parentId: null, css: textCss() },
    { id: 'd', name: 'd', type: 'TEXT', depth: 0, parentId: null, css: textCss() },
  ];

  it('gives a colliding block its own key instead of reusing the first', () => {
    const out = foldContextLiterals(twoBlocksTwiceEach(), () => 'X');
    expect(out.nodes[0].cssRef).toBe('X');
    expect(out.nodes[1].cssRef).toBe('X');
    expect(out.nodes[2].cssRef).not.toBe('X');
    expect(out.nodes[2].cssRef).toBe(out.nodes[3].cssRef);
    expect(out.literals[out.nodes[0].cssRef as string]).toEqual(flatTextCss());
    expect(out.literals[out.nodes[2].cssRef as string]).toEqual(textCss());
  });

  it('keeps two different subtrees apart under a colliding signature hash', () => {
    const rows = repeatedSubtrees().nodes;
    const out = foldContextTemplates(rows, () => 'X');
    // Two distinct signatures (Row A/B versus Row C) collide onto one hash; only the
    // repeated one is a template, and it must not swallow Row C.
    expect(Object.keys(out.templates)).toHaveLength(1);
    expect(out.nodes.filter((n) => n.templateRef !== undefined).map((n) => n.id)).toEqual(['5:2', '5:3']);
  });

  it('round-trips through inflate under a colliding hash too', () => {
    const nodes = twoBlocksTwiceEach();
    const folded = foldContextLiterals(nodes, () => 'X');
    const restored = inflateContextReply({
      nodes: folded.nodes, refs: { ...emptyRefs(), literals: folded.literals },
    }) as { nodes: Record_[] };
    expect(restored.nodes).toEqual(nodes);
  });
});

describe('context --dedup — inflate is the exact inverse, and nothing else', () => {
  it('leaves a reply that was never deduped alone', () => {
    const raw = reply(nothingRepeated());
    expect(inflateContextReply(raw)).toEqual(raw);
  });

  it('restores absolute depth from the occurrence, not from the template', () => {
    const nested = repeatedSubtrees();
    // Push the whole list three levels down so template depths must be relative.
    const deeper: Payload = {
      nodes: nested.nodes.map((n) => ({ ...n, depth: (n.depth as number) + 3 })),
      refs: nested.refs,
    };
    const restored = inflateContextReply(dedupReply(reply(deeper))) as { nodes: Record_[] };
    expect(restored.nodes.map((n) => n.depth)).toEqual(deeper.nodes.map((n) => n.depth));
  });
});
