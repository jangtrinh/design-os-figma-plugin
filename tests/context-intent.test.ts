// The `context` design-intent channel: what the DESIGNER meant, not just what the node is.
//
// The controller's live probe on the owner's Free file settles what is worth testing:
// `devStatus` reads as `null` and the file has 0 dev resources, while `annotations` read
// fine. The reads work; the VALUES are file-dependent. So the cases that matter are the
// empty one (no `intent` key at all, no `description` key in `refs.components`) and the
// throwing one — not a happy path full of invented values.
//
// Every getter below that a real dynamic-page sandbox refuses is written to THROW, because a
// permissive mock is a green light that means nothing: `devStatus`, `annotations` and
// `getDevResourcesAsync` are all sync-or-async surfaces a node can refuse outright.
import { describe, expect, it, vi } from 'vitest';
import { buildContextRecord } from '../plugin/src/main/context-node-record.ts';
import {
  createContextIntentReader, readSubtreeDevResources,
} from '../plugin/src/main/context-intent.ts';
import { opGetContext } from '../plugin/src/main/executor-context.ts';

type Fixture = Record<string, unknown>;

const noDevResources = { byNode: new Map<string, never[]>(), found: 0, attached: 0 };

function reader(over: Partial<Parameters<typeof createContextIntentReader>[0]> = {}) {
  return createContextIntentReader({ devResources: noDevResources, ...over });
}

const opts = { depth: 0, parentId: null, includeCss: false };

function node(id: string, type = 'FRAME', over: Fixture = {}): Fixture {
  return { id, name: `n${id}`, type, visible: true, children: [], ...over };
}

/** A property whose getter refuses — the dynamic-page behaviour a permissive mock hides. */
function throwing(base: Fixture, field: string, message: string): Fixture {
  Object.defineProperty(base, field, { get() { throw new Error(message); }, enumerable: true });
  return base;
}

describe('context intent — an empty file gets no intent key at all', () => {
  it('omits intent entirely when nothing is set', async () => {
    const result = await reader().buildRecord(node('1:1'), opts);
    expect(result.record.intent).toBeUndefined();
    expect(result.record.intentError).toBeUndefined();
    expect(result.incomplete).toBe(false);
  });

  it('omits intent when devStatus is explicitly null — the Free-plan reality', async () => {
    const result = await reader().buildRecord(node('1:1', 'FRAME', { devStatus: null, annotations: [] }), opts);
    expect(result.record.intent).toBeUndefined();
  });

  it('records no component row for a component with no description or links', async () => {
    const component = node('1:2', 'COMPONENT', {
      key: 'K1', description: '', descriptionMarkdown: '', documentationLinks: [],
    });
    const intent = reader();
    const result = await intent.buildRecord(component, opts);
    expect(result.record.intent).toBeUndefined();
    // Memoised as "asked and empty", but with nothing to say — so `refs.components[K1]`
    // gains no `description` key and stays exactly the `{name}` P1 ships.
    expect(intent.components()).toEqual({});
  });
});

describe('context intent — what it reports when the designer did set something', () => {
  it('carries devStatus verbatim, dropping an empty description', async () => {
    const withType = await reader().buildRecord(
      node('2:1', 'FRAME', { devStatus: { type: 'READY_FOR_DEV', description: '' } }), opts,
    );
    expect(withType.record.intent).toEqual({ devStatus: { type: 'READY_FOR_DEV' } });
    const withDescription = await reader().buildRecord(
      node('2:2', 'FRAME', { devStatus: { type: 'COMPLETED', description: 'ship it' } }), opts,
    );
    expect(withDescription.record.intent).toEqual({
      devStatus: { type: 'COMPLETED', description: 'ship it' },
    });
  });

  it('carries annotations as label + categoryId + the property type list', async () => {
    const result = await reader().buildRecord(node('2:3', 'FRAME', {
      annotations: [
        { label: 'Use the compact row', categoryId: 'C:1', properties: [{ type: 'padding' }, { type: 'itemSpacing' }] },
        { labelMarkdown: '**tap target 44px**' },
        {},
      ],
    }), opts);
    // The empty annotation is kept as an empty object rather than dropped: the count of
    // annotations on this node is a fact, and three-became-two is not.
    expect(result.record.intent).toEqual({
      annotations: [
        { label: 'Use the compact row', categoryId: 'C:1', properties: ['padding', 'itemSpacing'] },
        { labelMarkdown: '**tap target 44px**' },
        {},
      ],
    });
  });

  it('attaches the dev resources of the one subtree read, keyed by node id', async () => {
    const devResources = {
      byNode: new Map([['3:1', [{ name: 'Row.tsx', url: 'https://example.test/Row.tsx' }]]]),
      found: 2, attached: 0,
    };
    const intent = reader({ devResources });
    const hit = await intent.buildRecord(node('3:1'), opts);
    const miss = await intent.buildRecord(node('3:2'), opts);
    expect(hit.record.intent).toEqual({ devResources: [{ name: 'Row.tsx', url: 'https://example.test/Row.tsx' }] });
    expect(miss.record.intent).toBeUndefined();
    // `found` counted 2 and only 1 landed: the difference belongs to a node this reply did
    // not emit, and it is a number the caller can see rather than a silent drop.
    expect(intent.attachedDevResources()).toBe(1);
  });
});

describe('context intent — the one subtree-wide dev-resource read', () => {
  it('makes exactly one call, without includeChildren left to chance', async () => {
    const getDevResourcesAsync = vi.fn(async () => [
      { nodeId: '4:1', name: 'a', url: 'https://a.test', inheritedNodeId: '4:0' },
      { nodeId: '4:2', name: 'b', url: 'https://b.test' },
      { nodeId: '4:1', name: 'c', url: 'https://c.test' },
    ]);
    const out = await readSubtreeDevResources(node('4:1', 'FRAME', { getDevResourcesAsync }));
    expect(getDevResourcesAsync).toHaveBeenCalledTimes(1);
    expect(getDevResourcesAsync).toHaveBeenCalledWith({ includeChildren: true });
    expect(out.found).toBe(3);
    // `nodeId` is dropped from each entry — it is the record's own id — and
    // `inheritedNodeId` is kept, because "this link came from the main component" is a fact
    // the agent cannot recover any other way.
    expect(out.byNode.get('4:1')).toEqual([
      { name: 'a', url: 'https://a.test', inheritedNodeId: '4:0' },
      { name: 'c', url: 'https://c.test' },
    ]);
    expect(out.error).toBeUndefined();
  });

  it('reports a refused read as an error instead of an empty file', async () => {
    const out = await readSubtreeDevResources(node('4:3', 'FRAME', {
      getDevResourcesAsync: async () => { throw new Error('nope'); },
    }));
    expect(out.found).toBe(0);
    expect(out.error).toMatch(/nope/);
  });

  it('says so when the method is not there at all', async () => {
    const out = await readSubtreeDevResources(node('4:4'));
    expect(out.error).toMatch(/getDevResourcesAsync/);
  });
});

describe('context intent — a refused read keeps the node and says so', () => {
  it('keeps the node, notes the first message, and counts the record partial', async () => {
    const target = throwing(node('5:1'), 'annotations', 'in a dynamic-page file this getter refuses');
    const result = await reader().buildRecord(target, opts);
    expect(result.record.id).toBe('5:1');
    expect(result.record.intentError).toMatch(/refuses/);
    // The walk turns `incomplete` into `budget.partial`, which turns `complete` false.
    expect(result.incomplete).toBe(true);
  });

  it('keeps the FIRST message when two reads refuse', async () => {
    const target = throwing(throwing(node('5:2'), 'devStatus', 'first refusal'), 'annotations', 'second refusal');
    const result = await reader().buildRecord(target, opts);
    expect(result.record.intentError).toBe('first refusal');
  });

  it('reads nothing at all on a record whose own identity refused', async () => {
    const annotations = vi.fn(() => [{ label: 'never read' }]);
    const target = throwing({ name: 'x', type: 'FRAME' }, 'id', 'invalidated reference');
    Object.defineProperty(target, 'annotations', { get: annotations, enumerable: true });
    const result = await reader().buildRecord(target, opts);
    expect(result.record.readError).toMatch(/invalidated/);
    expect(result.record.intent).toBeUndefined();
    expect(annotations).not.toHaveBeenCalled();
  });
});

describe('context intent — component intent is resolved once per key', () => {
  const componentIntent = {
    key: 'K1', name: 'Button', description: 'Primary action',
    descriptionMarkdown: '**Primary** action', documentationLinks: [{ uri: 'https://docs.test/button' }],
  };

  it('asks once even when the answer is "no such component"', async () => {
    // A null answer is an answer. Not remembering it turns 40 instances of one unresolvable
    // component into 40 host round trips — the per-node cost this memo exists to refuse.
    const mainComponentOf = vi.fn(async () => null);
    const intent = reader({ mainComponentOf });
    for (const id of ['6:8', '6:9', '6:10']) {
      await intent.buildRecord(node(id, 'INSTANCE', {
        getMainComponentAsync: async () => ({ key: 'K5', name: 'Gone' }),
      }), opts);
    }
    expect(mainComponentOf).toHaveBeenCalledTimes(1);
    expect(intent.components()).toEqual({});
  });

  it('resolves one main component for three instances of the same key', async () => {
    const mainComponentOf = vi.fn(async () => componentIntent as Fixture);
    const intent = reader({ mainComponentOf });
    for (const id of ['6:1', '6:2', '6:3']) {
      const record = await intent.buildRecord(node(id, 'INSTANCE', {
        getMainComponentAsync: async () => componentIntent,
        componentProperties: {},
      }), opts);
      expect(record.record.intent).toEqual({ componentKey: 'K1' });
    }
    expect(mainComponentOf).toHaveBeenCalledTimes(1);
    expect(intent.components()).toEqual({
      K1: {
        name: 'Button',
        description: 'Primary action',
        descriptionMarkdown: '**Primary** action',
        documentationLinks: ['https://docs.test/button'],
      },
    });
  });

  it('omits descriptionMarkdown when it says the same thing as description', async () => {
    const intent = reader({ mainComponentOf: async () => ({ key: 'K2', name: 'Card', description: 'A card', descriptionMarkdown: 'A card' }) });
    await intent.buildRecord(node('6:4', 'INSTANCE', { getMainComponentAsync: async () => ({ key: 'K2', name: 'Card' }) }), opts);
    expect(intent.components()).toEqual({ K2: { name: 'Card', description: 'A card' } });
  });

  it('reads a COMPONENT node from itself, with no extra resolve', async () => {
    const mainComponentOf = vi.fn(async () => null);
    const intent = reader({ mainComponentOf });
    const result = await intent.buildRecord(node('6:5', 'COMPONENT', {
      key: 'K3', name: 'Chip', description: 'A chip', documentationLinks: [{ uri: 'https://docs.test/chip' }],
      componentPropertyDefinitions: {},
    }), opts);
    expect(result.record.intent).toEqual({ componentKey: 'K3' });
    expect(mainComponentOf).not.toHaveBeenCalled();
    expect(intent.components()).toEqual({
      K3: { name: 'Chip', description: 'A chip', documentationLinks: ['https://docs.test/chip'] },
    });
  });

  it('carries a keyless component inline, because there is no key to dedup by', async () => {
    const intent = reader();
    const result = await intent.buildRecord(node('6:6', 'COMPONENT_SET', {
      key: '', name: 'Local set', description: 'never published',
    }), opts);
    expect(result.record.intent).toEqual({
      component: { name: 'Local set', description: 'never published' },
    });
    expect(intent.components()).toEqual({});
  });

  it('notes a refused component read instead of dropping the node', async () => {
    const intent = reader({ mainComponentOf: async () => { throw new Error('component unreachable'); } });
    const result = await intent.buildRecord(node('6:7', 'INSTANCE', {
      getMainComponentAsync: async () => ({ key: 'K4', name: 'Ghost' }),
    }), opts);
    expect(result.record.intentError).toMatch(/component unreachable/);
    expect(result.incomplete).toBe(true);
  });
});

describe('context intent — the base record builder is not replaced, only wrapped', () => {
  it('keeps every field P1 emits', async () => {
    const plain = await buildContextRecord(node('7:1', 'TEXT', { characters: 'hi', width: 10, height: 4 }), opts);
    const wrapped = await reader().buildRecord(node('7:1', 'TEXT', { characters: 'hi', width: 10, height: 4 }), opts);
    expect(wrapped.record).toEqual(plain.record);
  });
});

// --------------------------------------------------------- and through the whole command

function figmaNode(id: string, type = 'FRAME', children: Fixture[] = [], over: Fixture = {}): Fixture {
  return {
    id, name: `n${id}`, type, visible: true, width: 10, height: 10, x: 0, y: 0, children,
    getCSSAsync: async () => ({ display: 'flex' }),
    ...over,
  };
}

function env(over: Partial<Parameters<typeof opGetContext>[1]> = {}) {
  return {
    nodeById: async (_id: string) => null as Fixture | null,
    selection: () => [] as Fixture[],
    refs: {
      variableById: async (id: string) => ({ name: `var/${id}`, variableCollectionId: 'C:1' }),
      collectionById: async () => ({ name: 'Theme', modes: [{ modeId: 'm' }] }),
      styleById: async (id: string) => ({ name: `style/${id}`, type: 'PAINT' }),
    },
    now: () => 0,
    hop: async () => {},
    changeCount: () => 0,
    ...over,
  };
}

describe('GET_CONTEXT — intent and dedup in the assembled reply', () => {
  it('does not read dev resources at all unless they were asked for', async () => {
    // The read is a ~2s fixed-cost server round trip (measured live), so the default is not
    // "read and report nothing" — it is "do not read". An absent block therefore means
    // "you did not ask", never "asked and found none".
    const getDevResourcesAsync = vi.fn(async () => []);
    const target = figmaNode('8:1', 'FRAME', [figmaNode('8:2', 'TEXT')], { getDevResourcesAsync });
    const out = await opGetContext({ nodeId: '8:1' }, env({ nodeById: async () => target })) as Record<string, unknown>;
    const nodes = out.nodes as Fixture[];
    expect(nodes.every((n) => n.intent === undefined)).toBe(true);
    expect(getDevResourcesAsync).toHaveBeenCalledTimes(0);
    expect((out.budget as Fixture).devResources).toBeUndefined();
    expect(out.dedup).toBeUndefined();
  });

  it('reads once and reports the block UNCONDITIONALLY when asked, found 0 included', async () => {
    // With the flag passed, presence means "you asked" — which is honest, and lets a caller
    // tell "this subtree has none" from "nobody looked".
    const getDevResourcesAsync = vi.fn(async () => []);
    const target = figmaNode('8:3', 'FRAME', [figmaNode('8:4', 'TEXT')], { getDevResourcesAsync });
    const out = await opGetContext({ nodeId: '8:3', devResources: true }, env({ nodeById: async () => target })) as Record<string, unknown>;
    expect(getDevResourcesAsync).toHaveBeenCalledTimes(1);
    expect((out.budget as Record<string, unknown>).devResources)
      .toEqual({ found: 0, attached: 0, readMs: 0 });
  });

  it('refuses a non-boolean devResources from the wire instead of guessing', async () => {
    const target = figmaNode('8:5');
    await expect(opGetContext({ nodeId: '8:5', devResources: 'yes' }, env({ nodeById: async () => target })))
      .rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
  });

  it('folds the component descriptions into refs.components, once per key', async () => {
    const main = { key: 'K9', name: 'Button', description: 'Primary action', documentationLinks: [{ uri: 'https://docs.test/b' }] };
    const instance = (id: string): Fixture => figmaNode(id, 'INSTANCE', [], {
      getMainComponentAsync: async () => main, componentProperties: {},
    });
    const target = figmaNode('9:1', 'FRAME', [instance('9:2'), instance('9:3')], {
      getDevResourcesAsync: async () => [],
    });
    const out = await opGetContext({ nodeId: '9:1' }, env({ nodeById: async () => target })) as Record<string, unknown>;
    const refs = out.refs as { components: Record<string, Record<string, unknown>> };
    expect(refs.components).toEqual({
      K9: { name: 'Button', description: 'Primary action', documentationLinks: ['https://docs.test/b'] },
    });
    expect((out.nodes as Fixture[]).slice(1).map((n) => n.intent)).toEqual([
      { componentKey: 'K9' }, { componentKey: 'K9' },
    ]);
  });

  it('counts a refused annotations read in budget.partial and drops complete to false', async () => {
    const child = throwing(figmaNode('a:2', 'TEXT'), 'annotations', 'annotations refused');
    const target = figmaNode('a:1', 'FRAME', [child], { getDevResourcesAsync: async () => [] });
    const out = await opGetContext({ nodeId: 'a:1' }, env({ nodeById: async () => target })) as Record<string, unknown>;
    const budget = out.budget as Record<string, unknown>;
    expect(budget.partial).toBe(1);
    expect(budget.complete).toBe(false);
    expect((out.nodes as Fixture[])[1].intentError).toMatch(/annotations refused/);
  });

  it('narrows the dev-resource read to the target itself at --depth 0', async () => {
    // The read runs BEFORE the walk and is bounded by neither --budget nor --depth, so on a
    // PAGE target it is a whole-page read. At depth 0 only one record can ever carry the
    // answer, and `includeChildren: false` is the read that matches — the node's own links
    // (including any inherited from its main component) are still reported.
    const getDevResourcesAsync = vi.fn(async () => [{ nodeId: 'g:1', name: 'Row.tsx', url: 'https://g.test' }]);
    const target = figmaNode('g:1', 'FRAME', [figmaNode('g:2', 'TEXT')], { getDevResourcesAsync });
    const out = await opGetContext({ nodeId: 'g:1', depth: 0, devResources: true }, env({ nodeById: async () => target })) as Record<string, unknown>;
    expect(getDevResourcesAsync).toHaveBeenCalledWith({ includeChildren: false });
    expect((out.nodes as Fixture[])[0].intent).toEqual({
      devResources: [{ name: 'Row.tsx', url: 'https://g.test' }],
    });
  });

  it('reports how long the unbounded read took once it costs anything', async () => {
    let clock = 0;
    const target = figmaNode('h:1', 'FRAME', [figmaNode('h:2', 'TEXT')], {
      getDevResourcesAsync: async () => { clock += 7; return []; },
    });
    const out = await opGetContext({ nodeId: 'h:1', devResources: true }, env({
      nodeById: async () => target, now: () => clock,
    })) as Record<string, unknown>;
    expect((out.budget as Record<string, unknown>).devResources)
      .toMatchObject({ found: 0, attached: 0, readMs: 7 });
  });

  it('reports a refused subtree dev-resource read once, at the reply level', async () => {
    const target = figmaNode('b:1', 'FRAME', [figmaNode('b:2', 'TEXT')], {
      getDevResourcesAsync: async () => { throw new Error('dev resources refused'); },
    });
    const out = await opGetContext({ nodeId: 'b:1', devResources: true }, env({ nodeById: async () => target })) as Record<string, unknown>;
    const devResources = (out.budget as Record<string, unknown>).devResources as Record<string, unknown>;
    expect(devResources).toMatchObject({ found: 0, attached: 0 });
    expect(devResources.error).toMatch(/dev resources refused/);
    // A reply-level read failure is not a per-node partial: no node's own answer is missing.
    expect((out.budget as Record<string, unknown>).partial).toBe(0);
  });

  it('applies dedup only when asked, and reports the decision either way', async () => {
    const rows = [1, 2, 3, 4].map((i) => figmaNode(`c:${i + 1}`, 'FRAME', [figmaNode(`c:1${i}`, 'TEXT', [], {
      characters: 'Same', getCSSAsync: async () => ({ color: '#111111', 'font-size': '12px', 'font-family': 'Inter' }),
    })], {
      getCSSAsync: async () => ({ display: 'flex', gap: '4px', padding: '8px 12px', 'border-radius': '6px' }),
    }));
    const target = figmaNode('c:1', 'FRAME', rows, { getDevResourcesAsync: async () => [] });
    const plain = await opGetContext({ nodeId: 'c:1' }, env({ nodeById: async () => target })) as Record<string, unknown>;
    expect(plain.dedup).toBeUndefined();
    const deduped = await opGetContext({ nodeId: 'c:1', dedup: true }, env({ nodeById: async () => target })) as Record<string, unknown>;
    const report = deduped.dedup as { applied: boolean; savedBytes?: number };
    expect(report.applied).toBe(true);
    expect(report.savedBytes).toBeGreaterThan(0);
    // finalBytes reports what actually goes out, so the saving is checkable against it.
    const plainFinal = (plain.budget as Record<string, number>).finalBytes;
    const dedupedFinal = (deduped.budget as Record<string, number>).finalBytes;
    expect(dedupedFinal).toBeLessThan(plainFinal);
    expect(plainFinal - dedupedFinal).toBe(report.savedBytes);
    // The budget's own meaning is unchanged: estimatedBytes still measures the RAW records
    // the walk built, so `--budget` bounds the same thing it did before.
    expect((deduped.budget as Record<string, number>).estimatedBytes)
      .toBe((plain.budget as Record<string, number>).estimatedBytes);
  });

  it('keeps the conservation law checkable after folding, with a RECORD counter', async () => {
    // `savedBytes` counts bytes; folding removes RECORDS. Without a record counter,
    // `emitted: 9` against a `nodes[]` of 5 is a documented law silently broken — the caller
    // reads four nodes as never having arrived, and has no frontier entry for any of them.
    const rows = [1, 2, 3, 4].map((i) => figmaNode(`e:${i + 1}`, 'FRAME', [figmaNode(`e:1${i}`, 'TEXT', [], {
      characters: 'Same', getCSSAsync: async () => ({ color: '#111111', 'font-size': '12px', 'font-family': 'Inter' }),
    })], {
      getCSSAsync: async () => ({ display: 'flex', gap: '4px', padding: '8px 12px', 'border-radius': '6px' }),
    }));
    const target = figmaNode('e:1', 'FRAME', rows, { getDevResourcesAsync: async () => [] });
    const out = await opGetContext({ nodeId: 'e:1', dedup: true }, env({ nodeById: async () => target })) as Record<string, unknown>;
    const budget = out.budget as Record<string, number> & { omitted: Record<string, number> };
    const report = out.dedup as { applied: boolean; foldedNodes?: number };
    expect(report.applied).toBe(true);
    // Four rows fold to one template, each shedding its one TEXT child.
    expect(report.foldedNodes).toBe(4);
    expect(budget.emitted).toBe((out.nodes as Fixture[]).length + (report.foldedNodes as number));
    // And P1's law is untouched: `emitted` is still the number the walk accounted for.
    expect(budget.visited).toBe(budget.emitted + budget.omitted.budget + budget.omitted.deadline);
  });

  it('reports foldedNodes 0 rather than omitting it when only literals folded', async () => {
    // `applied: true` with nothing templated is a real outcome. An absent counter would make
    // the identity above unverifiable exactly when a reader wants to check it.
    const css = async (): Promise<Record<string, string>> => ({
      display: 'flex', gap: '4px', padding: '8px 12px', 'border-radius': '6px', background: '#FFFFFF',
    });
    const target = figmaNode('f:1', 'FRAME', [
      figmaNode('f:2', 'TEXT', [], { getCSSAsync: css, characters: 'a' }),
      figmaNode('f:3', 'TEXT', [], { getCSSAsync: css, characters: 'b' }),
    ], { getDevResourcesAsync: async () => [], getCSSAsync: css });
    const out = await opGetContext({ nodeId: 'f:1', dedup: true }, env({ nodeById: async () => target })) as Record<string, unknown>;
    const report = out.dedup as { applied: boolean; foldedNodes?: number };
    expect(report.applied).toBe(true);
    expect(report.foldedNodes).toBe(0);
    expect((out.budget as Record<string, number>).emitted).toBe((out.nodes as Fixture[]).length);
  });

  it('refuses a non-boolean dedup from the wire instead of guessing', async () => {
    const target = figmaNode('d:1');
    await expect(opGetContext({ nodeId: 'd:1', dedup: 'yes' }, env({ nodeById: async () => target })))
      .rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
  });
});
