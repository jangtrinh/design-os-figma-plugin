// SCAN_DESIGN_SYSTEM's component entries carry the PAGE each component lives on — the
// one fact `resolve-component` needs to prefer a design-system page over a stray copy on
// a screens page (the real file has two live `Table / Cell` sets). Additive: an older
// consumer that never read `page` sees the same entries plus one more field.
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeNode, installMockFigma } from './helpers/mock-figma.ts';
import { serializeComponentEntries } from '../plugin/src/main/serialize-node.ts';

function page(name: string): FakeNode {
  const p = new FakeNode('PAGE');
  p.name = name;
  return p;
}

function componentSet(name: string, variants: string[]): { set: FakeNode; children: FakeNode[] } {
  const set = new FakeNode('COMPONENT_SET');
  set.name = name;
  const children = variants.map((v) => {
    const c = new FakeNode('COMPONENT');
    c.name = v;
    set.appendChild(c);
    return c;
  });
  return { set, children };
}

describe('serializeComponentEntries — page attribution', () => {
  beforeEach(() => { installMockFigma(); });

  it('each component/set entry names its page by id AND name; variant children fold into their set', () => {
    const ds = page('01 Design System');
    const screens = page('02 Screens');
    const a = componentSet('Table / Cell', ['State=Default', 'State=Hover']);
    const b = componentSet('Table / Cell', ['State=Default']);
    ds.appendChild(a.set);
    screens.appendChild(b.set);

    const entries = serializeComponentEntries([a.set, ...a.children, b.set, ...b.children] as unknown as SceneNode[]);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ id: a.set.id, name: 'Table / Cell', type: 'COMPONENT_SET', page: { id: ds.id, name: '01 Design System' } });
    expect(entries[1]).toMatchObject({ id: b.set.id, name: 'Table / Cell', type: 'COMPONENT_SET', page: { id: screens.id, name: '02 Screens' } });
  });

  it('a component with no page in its parent chain reports page: null — never a guessed page', () => {
    const orphan = new FakeNode('COMPONENT');
    orphan.name = 'Detached';
    const [entry] = serializeComponentEntries([orphan as unknown as SceneNode]);
    expect(entry).toMatchObject({ id: orphan.id, name: 'Detached', type: 'COMPONENT', page: null });
  });
});
