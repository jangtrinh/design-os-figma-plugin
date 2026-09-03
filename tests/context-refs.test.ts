// The reply's identity tables. This IS the honest dedup: 40 nodes bound to one token carry
// the same variable ID and the reply names that token ONCE. What it must never do is
// resolve a VALUE off `modes[0]` and label it "the value" — on a multi-mode collection
// that is a different mode's value wearing the collection's name. `modeCount` is the fact;
// the value is a question the caller asks with a mode named.
import { describe, expect, it, vi } from 'vitest';
import { collectRefIds, resolveContextRefs } from '../plugin/src/main/context-refs.ts';

const records = [
  { id: '1', bindings: { itemSpacing: 'V:1', fills: 'V:2' }, styles: { fill: 'S:1' } },
  { id: '2', bindings: { fills: 'V:2' }, styles: { fill: 'S:1', text: 'S:2' } },
  { id: '3', mainComponent: { key: 'k1', name: 'Button' } },
  { id: '4', mainComponent: { key: 'k1', name: 'Button' } },
  { id: '5' },
];

function deps() {
  const variableById = vi.fn(async (id: string) => ({ name: `var/${id}`, variableCollectionId: 'C:1' }));
  const collectionById = vi.fn(async (_id: string) => ({ name: 'Theme', modes: [{ modeId: 'm1' }, { modeId: 'm2' }] }));
  const styleById = vi.fn(async (id: string) => ({ name: `style/${id}`, type: 'PAINT' }));
  return { variableById, collectionById, styleById };
}

describe('context refs — collection', () => {
  it('gathers each distinct variable id, style id and component key once', () => {
    expect(collectRefIds(records)).toEqual({
      variables: ['V:1', 'V:2'],
      styles: ['S:1', 'S:2'],
      components: [{ key: 'k1', name: 'Button' }],
    });
  });
});

describe('context refs — resolution', () => {
  it('resolves every id EXACTLY once no matter how many nodes bind it', async () => {
    const d = deps();
    const refs = await resolveContextRefs(records, d);
    expect(d.variableById.mock.calls.map((c) => c[0])).toEqual(['V:1', 'V:2']);
    expect(d.styleById.mock.calls.map((c) => c[0])).toEqual(['S:1', 'S:2']);
    // Both variables live in the same collection: one collection lookup, not two.
    expect(d.collectionById).toHaveBeenCalledTimes(1);
    expect(refs.variables).toEqual({
      'V:1': { name: 'var/V:1', collection: 'Theme', modeCount: 2 },
      'V:2': { name: 'var/V:2', collection: 'Theme', modeCount: 2 },
    });
    expect(refs.styles).toEqual({
      'S:1': { name: 'style/S:1', type: 'PAINT' },
      'S:2': { name: 'style/S:2', type: 'PAINT' },
    });
    expect(refs.components).toEqual({ k1: { name: 'Button' } });
  });

  it('emits modeCount and NEVER a value', async () => {
    const refs = await resolveContextRefs([records[0]], deps());
    expect(JSON.stringify(refs)).not.toContain('value');
    expect(refs.variables['V:1'].modeCount).toBe(2);
  });

  it('an id nothing answers to is reported unresolved, never dropped and never guessed', async () => {
    const d = deps();
    d.variableById.mockImplementation(async () => null as never);
    d.styleById.mockImplementation(async () => { throw new Error('style read refused'); });
    const refs = await resolveContextRefs(records, d);
    expect(refs.variables['V:1']).toEqual({ unresolved: 'no variable answers to this id' });
    expect(refs.styles['S:1']).toEqual({ unresolved: 'style read refused' });
  });

  it('a modes read that refuses reports null, never a fabricated count of 0', async () => {
    const d = deps();
    d.collectionById.mockImplementation(async () => {
      const collection: Record<string, unknown> = { name: 'Theme' };
      Object.defineProperty(collection, 'modes', {
        get() { throw new Error('modes refused'); }, enumerable: true,
      });
      return collection as never;
    });
    const refs = await resolveContextRefs([records[0]], d);
    // No collection has zero modes. `0` invites the exact multi-mode misread the design
    // forbids — an agent reading `modeCount: 1` reasons "single mode, safe to inline a
    // value", and `0` is worse than absent.
    expect(refs.variables['V:1']).toEqual({ name: 'var/V:1', collection: 'Theme', modeCount: null });
  });

  it('a variable whose collection cannot be read still names the variable', async () => {
    const d = deps();
    d.collectionById.mockImplementation(async () => null as never);
    const refs = await resolveContextRefs([records[0]], d);
    expect(refs.variables['V:1']).toEqual({ name: 'var/V:1', collection: null, modeCount: null });
  });

  it('a reply with no refs at all carries three empty tables, not absent keys', async () => {
    const refs = await resolveContextRefs([{ id: '1' }], deps());
    expect(refs).toEqual({ variables: {}, styles: {}, components: {} });
  });
});
