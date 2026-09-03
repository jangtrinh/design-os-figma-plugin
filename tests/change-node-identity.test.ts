// The per-change identity helpers `documentchange` capture runs on every changed node,
// tested straight (they used to live inside main.ts, which no test can import — it calls
// `figma.showUI` at module load).
import { describe, it, expect } from 'vitest';
import {
  createEditIdentityCache, enclosingName, resolveComponentIdentity,
} from '../plugin/src/main/change-node-identity.ts';

interface FakeNode {
  id: string;
  name: string;
  type: string;
  parent: FakeNode | null;
  removed?: boolean;
}

const node = (id: string, type: string, name: string, parent: FakeNode | null = null): FakeNode =>
  ({ id, name, type, parent });

/* eslint-disable @typescript-eslint/no-explicit-any */
const asScene = (n: FakeNode) => n as any;

describe('enclosingName — where the owner was working', () => {
  it('finds the nearest FRAME/SECTION/COMPONENT above the node, never the node itself', () => {
    const frame = node('f1', 'FRAME', 'Card', node('p1', 'PAGE', 'Page 1'));
    expect(enclosingName(asScene(node('t1', 'TEXT', 'Label', frame)))).toBe('Card');
    expect(enclosingName(asScene(frame))).toBeNull(); // its parent is the page
  });
});

describe('resolveComponentIdentity — the canonical component container', () => {
  it('a variant resolves to its enclosing COMPONENT_SET', () => {
    const set = node('cs1', 'COMPONENT_SET', 'Button');
    const variant = node('c1', 'COMPONENT', 'State=Default', set);
    expect(resolveComponentIdentity(asScene(node('t1', 'TEXT', 'Label', variant))))
      .toEqual({ id: 'cs1', name: 'Button', type: 'COMPONENT_SET' });
  });

  it('an ordinary frame edit resolves to nothing (the component volume filter)', () => {
    expect(resolveComponentIdentity(asScene(node('f1', 'FRAME', 'Card', node('p1', 'PAGE', 'Page 1'))))).toBeNull();
  });

  it('a removed node keeps only whole-component deletions — a removed descendant has no parent to walk', () => {
    expect(resolveComponentIdentity({ id: 'c9', type: 'COMPONENT', removed: true } as any))
      .toEqual({ id: 'c9', name: null, type: 'COMPONENT' });
    expect(resolveComponentIdentity({ id: 't9', type: 'TEXT', removed: true } as any)).toBeNull();
  });
});

describe('the edit identity cache — bounded, oldest-out', () => {
  it('remembers a node so a later DELETE (id + type only) can still be described', () => {
    const cache = createEditIdentityCache(3);
    cache.remember('a', { name: 'Card', type: 'FRAME', parentName: 'Section', page: 'Page 1' });
    expect(cache.get('a')?.name).toBe('Card');
    expect(cache.get('missing')).toBeUndefined();
  });

  it('evicts the OLDEST entry past the cap — a long session must not leak', () => {
    const cache = createEditIdentityCache(2);
    for (const id of ['a', 'b', 'c']) {
      cache.remember(id, { name: id, type: 'FRAME', parentName: null, page: 'Page 1' });
    }
    expect(cache.size()).toBe(2);
    expect(cache.get('a')).toBeUndefined(); // oldest out
    expect(cache.get('c')?.name).toBe('c');
  });
});
