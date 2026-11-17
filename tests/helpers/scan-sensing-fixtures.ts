// Fixture builders shared by the scan-sensing tests (built on the strict mock-figma).
import { FakeNode } from './mock-figma.ts';

export const alias = (id: string) => ({ type: 'VARIABLE_ALIAS', id });
export const sn = (n: FakeNode) => n as unknown as SceneNode;
export const pagesOf = (...p: FakeNode[]) => p as unknown as PageNode[];

export function node(type: string, name: string, w = 0, h = 0): FakeNode {
  const n = new FakeNode(type);
  n.name = name; n.width = w; n.height = h;
  return n;
}
export const page = (name: string): FakeNode => node('PAGE', name);

/** An INSTANCE whose main component is `main` (null = the lookup resolves nothing). */
export function instanceOf(main: FakeNode | null): FakeNode {
  const i = node('INSTANCE', 'inst');
  i.mainComponent = main as never;
  return i;
}

/** A local component placed on a page (so it has a parent, i.e. it is in the document). */
export function localComponent(pg: FakeNode, name: string): FakeNode {
  const c = node('COMPONENT', name);
  pg.appendChild(c);
  return c;
}

export function entryFor(n: FakeNode): Record<string, unknown> {
  return { id: n.id, name: n.name, type: n.type };
}
