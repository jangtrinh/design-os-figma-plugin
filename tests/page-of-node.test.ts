// The upward page walk both the connector layer and `documentchange` capture resolve a
// node's page with. One walk, one semantics: a second copy with a different bound is how a
// deep node ended up filed under whatever page the designer happened to be looking at.
import { describe, it, expect } from 'vitest';
import { pageOf } from '../plugin/src/main/page-of-node.ts';

interface FakeNode { id: string; name: string; type: string; parent: FakeNode | null }

const node = (id: string, type: string, name: string, parent: FakeNode | null = null): FakeNode =>
  ({ id, name, type, parent });

/** A chain of `depth` FRAMEs under one PAGE; returns the deepest node. */
function chainUnderPage(depth: number): FakeNode {
  const page = node('page-1', 'PAGE', 'Page 1');
  let current: FakeNode = page;
  for (let i = 0; i < depth; i++) current = node(`f${i}`, 'FRAME', `Frame ${i}`, current);
  return current;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const asBase = (n: FakeNode) => n as any;

describe('pageOf — the page a node lives on', () => {
  it('returns the enclosing PAGE node itself, so callers get its id AND its name', () => {
    const page = node('p2', 'PAGE', 'Components');
    const text = node('t1', 'TEXT', 'Label', node('f1', 'FRAME', 'Card', page));
    expect(pageOf(asBase(text))).toBe(page);
  });

  it('resolves a PAGE node to itself', () => {
    const page = node('p3', 'PAGE', 'Cover');
    expect(pageOf(asBase(page))).toBe(page);
  });

  it('returns null for an orphaned/detached node — it never invents a page', () => {
    expect(pageOf(asBase(node('x', 'FRAME', 'Detached')))).toBeNull();
  });

  it('is not hop-bounded: a parent chain is finite, so depth alone never loses the page', () => {
    expect(pageOf(asBase(chainUnderPage(21)))?.name).toBe('Page 1');
    expect(pageOf(asBase(chainUnderPage(500)))?.name).toBe('Page 1');
  });
});
