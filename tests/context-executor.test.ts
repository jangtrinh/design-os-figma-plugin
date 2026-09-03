// `GET_CONTEXT` end to end inside the plugin: target resolution, the assembled reply, and
// the two facts the caller cannot get anywhere else — `schema` (so a payload change is a
// version bump, not a surprise) and `changeBatchesDuringWalk` (so a tree read across two
// document states is never presented as one).
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONTEXT_BUDGET_BYTES, opGetContext } from '../plugin/src/main/executor-context.ts';
import { utf8ByteLength } from '../shared/utf8-byte-length.ts';

type Fixture = Record<string, unknown>;

function node(id: string, type = 'FRAME', children: Fixture[] = [], over: Fixture = {}): Fixture {
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

describe('GET_CONTEXT — target resolution', () => {
  it('resolves params.nodeId through the async getter', async () => {
    const target = node('1:1', 'FRAME', [node('1:2', 'TEXT')]);
    const nodeById = vi.fn(async (id: string) => (id === '1:1' ? target : null));
    const reply = await opGetContext({ nodeId: '1:1' }, env({ nodeById })) as Record<string, unknown>;
    expect(nodeById).toHaveBeenCalledWith('1:1');
    expect(reply.nodeId).toBe('1:1');
    // The plugin does NOT report a targetSource: the CLI resolves the target and owns that
    // field, in its own vocabulary (explicit|selection|recent). One field name with two
    // vocabularies is a wrong fact waiting for a reader.
    expect(reply.targetSource).toBeUndefined();
    expect((reply.nodes as Fixture[]).map((n) => n.id)).toEqual(['1:1', '1:2']);
  });

  it('falls back to the current selection when no id was passed', async () => {
    const reply = await opGetContext({}, env({ selection: () => [node('2:1')] })) as Record<string, unknown>;
    expect(reply.nodeId).toBe('2:1');
  });

  it('refuses a DOCUMENT target — a document is not a subtree', async () => {
    const doc = { id: '0:0', name: 'Document', type: 'DOCUMENT', children: [node('0:1', 'PAGE')] };
    await expect(opGetContext({ nodeId: '0:0' }, env({ nodeById: async () => doc })))
      .rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
    await expect(opGetContext({ nodeId: '0:0' }, env({ nodeById: async () => doc })))
      .rejects.toThrow(/page or a node id/i);
  });

  it('allows a PAGE target — "give me this screen" is the natural call, and bytes bound it', async () => {
    const page = { id: '0:1', name: 'Page 1', type: 'PAGE', children: [node('1:1', 'FRAME')] };
    const reply = await opGetContext({ nodeId: '0:1' }, env({ nodeById: async () => page })) as Record<string, unknown>;
    expect((reply.nodes as Fixture[]).map((n) => n.id)).toEqual(['0:1', '1:1']);
  });

  it('refuses an id nothing answers to, quoting it', async () => {
    await expect(opGetContext({ nodeId: 'nope' }, env())).rejects.toThrow(/"nope"/);
    await expect(opGetContext({ nodeId: 'nope' }, env())).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
  });

  it('refuses an empty selection with the action the caller can take', async () => {
    await expect(opGetContext({}, env())).rejects.toThrow(/select one node|node id/i);
  });
});

describe('GET_CONTEXT — the reply', () => {
  it('carries the schema tag agents pin against', async () => {
    const reply = await opGetContext({ nodeId: '1' }, env({ nodeById: async () => node('1') })) as Record<string, unknown>;
    expect(reply.schema).toBe('context/1');
  });

  it('assembles refs from the walked records and reports both byte numbers', async () => {
    const target = node('1', 'FRAME', [
      node('2', 'TEXT', [], { boundVariables: { itemSpacing: { id: 'V:1' } }, fillStyleId: 'S:1' }),
    ]);
    const reply = await opGetContext({ nodeId: '1' }, env({ nodeById: async () => target })) as Record<string, unknown>;
    expect(reply.refs).toEqual({
      variables: { 'V:1': { name: 'var/V:1', collection: 'Theme', modeCount: 1 } },
      styles: { 'S:1': { name: 'style/S:1', type: 'PAINT' } },
      components: {},
    });
    const budget = reply.budget as Record<string, number>;
    expect(budget.requestedBytes).toBe(DEFAULT_CONTEXT_BUDGET_BYTES);
    // --budget bounds the node RECORDS. The ref tables are resolved after the walk and are
    // reported separately, never silently folded into a total the caller believes is bounded.
    expect(budget.refsBytes).toBe(utf8ByteLength(JSON.stringify(reply.refs)));
    expect(budget.refsBytes).toBeGreaterThan(0);
    // finalBytes = the records + the ref tables + the JSON structure around them, so it is
    // strictly larger than either part and never a substitute for reading both.
    expect(budget.finalBytes).toBeGreaterThan(budget.estimatedBytes + budget.refsBytes);
    expect(budget.complete).toBe(true);
  });

  it('honours budget, depth and no-css params from the wire', async () => {
    const getCSSAsync = vi.fn(async () => ({ display: 'flex' }));
    const target = node('1', 'FRAME', [node('2', 'TEXT', [node('3', 'TEXT')], { getCSSAsync })], { getCSSAsync });
    const reply = await opGetContext({ nodeId: '1', depth: 1, noCss: true, budgetBytes: 4096 }, env({
      nodeById: async () => target,
    })) as Record<string, unknown>;
    expect((reply.nodes as Fixture[]).map((n) => n.id)).toEqual(['1', '2']);
    expect(getCSSAsync).toHaveBeenCalledTimes(0);
    expect((reply.budget as Record<string, number>).requestedBytes).toBe(4096);
  });

  it('refuses a malformed budget or depth from the wire instead of silently defaulting', async () => {
    const target = node('1');
    for (const params of [{ budgetBytes: 0 }, { budgetBytes: -1 }, { depth: -1 }, { depth: 1.5 }, { deadlineMs: 0 }]) {
      await expect(
        opGetContext({ nodeId: '1', ...params }, env({ nodeById: async () => target })),
      ).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
    }
  });

  it('refuses a wire budget or deadline past the caps, so a client cannot route around the CLI', async () => {
    const target = node('1');
    for (const params of [{ budgetBytes: 512 * 1024 + 1 }, { deadlineMs: 120_001 }]) {
      await expect(
        opGetContext({ nodeId: '1', ...params }, env({ nodeById: async () => target })),
      ).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
    }
    // Exactly at the caps is legal.
    await expect(
      opGetContext({ nodeId: '1', budgetBytes: 512 * 1024, deadlineMs: 120_000 }, env({ nodeById: async () => target })),
    ).resolves.toMatchObject({ schema: 'context/1' });
  });

  it('measures the ref resolution that runs outside the soft deadline', async () => {
    let clock = 0;
    const target = node('1', 'FRAME', [], { boundVariables: { itemSpacing: { id: 'V:1' } } });
    const reply = await opGetContext({ nodeId: '1' }, env({
      nodeById: async () => target,
      now: () => clock,
      refs: {
        variableById: async () => { clock += 3; return { name: 'var', variableCollectionId: 'C:1' }; },
        collectionById: async () => { clock += 2; return { name: 'Theme', modes: [{ modeId: 'm' }] }; },
        styleById: async () => null,
      },
    })) as Record<string, unknown>;
    expect((reply.budget as Record<string, number>).refsMs).toBe(5);
  });

  it('counts DOCUMENT-WIDE change batches during this dispatch, under a name that says so', async () => {
    let changes = 3;
    const target = node('1', 'FRAME', [node('2', 'TEXT')]);
    const reply = await opGetContext({ nodeId: '1' }, env({
      nodeById: async () => target,
      hop: async () => { changes += 1; },
      changeCount: () => changes,
    })) as Record<string, unknown>;
    const budget = reply.budget as Record<string, unknown>;
    expect(budget.changeBatchesDuringWalk).toBe(2);
    // The old name read as "edits to this subtree", which it never was.
    expect(budget.changesDuringWalk).toBeUndefined();
  });

  it('derives the soft deadline from the caller deadline and returns a partial with counts', async () => {
    let clock = 0;
    const target = node('1', 'FRAME', [node('2', 'TEXT'), node('3', 'TEXT')]);
    const reply = await opGetContext({ nodeId: '1', deadlineMs: 10 }, env({
      nodeById: async () => target,
      now: () => clock,
      hop: async () => { clock += 50; },
    })) as Record<string, unknown>;
    const budget = reply.budget as Record<string, number> & { omitted: Record<string, number> };
    expect(budget.omitted.deadline).toBe(2);
    expect(budget.complete).toBe(false);
    expect(budget.visited).toBe(budget.emitted + budget.omitted.deadline);
    expect(budget.emitted).toBe((reply.nodes as Fixture[]).length);
  });
});
