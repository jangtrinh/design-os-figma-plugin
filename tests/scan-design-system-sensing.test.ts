// SCAN_DESIGN_SYSTEM additionally senses (1) the variables bound inside each component and
// (2) the component instances each top-level frame is built from. Both fields are additive:
// every pre-existing field keeps its shape. The mock refuses what Figma refuses under
// documentAccess: dynamic-page — the sync mainComponent getter throws, an unloaded page
// cannot be searched, getMainComponentAsync may resolve null.
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeNode, installMockFigma } from './helpers/mock-figma.ts';
import { serializeComponentEntries, serializeDesignSystem } from '../plugin/src/main/serialize-node.ts';
import { boundVariableIdsOf, serializeFrames } from '../plugin/src/main/scan-design-system-sensing.ts';

const alias = (id: string) => ({ type: 'VARIABLE_ALIAS', id });
const as = (n: FakeNode) => n as unknown as SceneNode;

function node(type: string, name: string, w = 0, h = 0): FakeNode {
  const n = new FakeNode(type);
  n.name = name; n.width = w; n.height = h;
  return n;
}
function page(name: string): FakeNode { return node('PAGE', name); }
function instanceOf(main: FakeNode | null): FakeNode {
  const i = node('INSTANCE', 'inst');
  i.mainComponent = main as never;
  return i;
}

describe('components[].boundVariables', () => {
  beforeEach(() => { installMockFigma(); });

  it('collects scalar, paint, effect and descendant bindings once each, sorted; skips nested instance internals', () => {
    const set = node('COMPONENT_SET', 'Button');
    const v1 = node('COMPONENT', 'State=Default');
    const v2 = node('COMPONENT', 'State=Hover');
    set.appendChild(v1); set.appendChild(v2);
    v1.boundVariables = { cornerRadius: alias('V:9'), itemSpacing: alias('V:3') };
    v1.fills = [{ type: 'SOLID', boundVariables: { color: alias('V:2') } }];
    const label = node('TEXT', 'label');
    label.fills = [{ type: 'SOLID', boundVariables: { color: alias('V:2') } }];
    label.effects = [{ type: 'DROP_SHADOW', boundVariables: { radius: alias('V:7') } }];
    v1.appendChild(label);
    v2.boundVariables = { fills: [alias('V:1')] }; // field-level array form
    const nested = instanceOf(null);
    nested.appendChild(Object.assign(node('FRAME', 'inner'), { boundVariables: { itemSpacing: alias('V:99') } }));
    v2.appendChild(nested);

    expect(boundVariableIdsOf(as(set))).toEqual(['V:1', 'V:2', 'V:3', 'V:7', 'V:9']);
  });

  it('a component with no bindings reports an empty list (sensed, none) — and the entry keeps its old fields', () => {
    const ds = page('DS'); const c = node('COMPONENT', 'Plain'); ds.appendChild(c);
    const [e] = serializeComponentEntries([as(c)]);
    expect(e).toMatchObject({ id: c.id, name: 'Plain', type: 'COMPONENT', page: { id: ds.id, name: 'DS' }, boundVariables: [] });
  });

  it('a throwing or mixed binding read never aborts the scan', () => {
    const c = node('COMPONENT', 'Odd');
    Object.defineProperty(c, 'fills', { get() { throw new Error('boom'); } });
    c.boundVariables = { cornerRadius: alias('V:5') };
    expect(boundVariableIdsOf(as(c))).toEqual(['V:5']);
  });
});

describe('frames[]', () => {
  beforeEach(() => { installMockFigma(); });

  function fixture() {
    const lib = page('Library');
    const set = node('COMPONENT_SET', 'Card'); const variant = node('COMPONENT', 'Size=L');
    set.appendChild(variant); lib.appendChild(set);
    const btn = node('COMPONENT', 'Button'); lib.appendChild(btn);
    const remoteBtn = node('COMPONENT', 'Badge'); remoteBtn.remote = true; remoteBtn.key = 'KEY-BADGE';
    const screens = page('Screens');
    const home = node('FRAME', 'Home', 1440.126, 900); screens.appendChild(home);
    const group = node('FRAME', 'Group', 10, 10); home.appendChild(group);
    group.appendChild(instanceOf(btn)); home.appendChild(instanceOf(btn)); home.appendChild(instanceOf(variant));
    home.appendChild(instanceOf(remoteBtn));
    screens.appendChild(node('RECTANGLE', 'not-a-frame'));
    return { lib, screens, home, set, btn };
  }

  it('lists top-level frames per page with instance counts; variants fold into their set; library components use their key', async () => {
    const f = fixture();
    const frames = await serializeFrames([f.lib, f.screens] as unknown as PageNode[]);
    const expected = [
      { component: 'KEY-BADGE', count: 1 }, { component: f.btn.id, count: 2 }, { component: f.set.id, count: 1 },
    ].sort((x, y) => (x.component < y.component ? -1 : 1));
    expect(frames).toEqual([{
      id: f.home.id, name: 'Home', page: { id: f.screens.id, name: 'Screens' }, w: 1440.13, h: 900, instances: expected,
    }]);
  });

  it('an instance whose main component resolves to null is counted as unresolved, not dropped or guessed', async () => {
    const s = page('Screens'); const fr = node('FRAME', 'F', 1, 1); s.appendChild(fr);
    fr.appendChild(instanceOf(null));
    const [frame] = await serializeFrames([s] as unknown as PageNode[]);
    expect(frame.instances).toEqual([]);
    expect(frame.unresolvedInstances).toBe(1);
  });

  it('never touches the sync mainComponent getter (it throws under dynamic-page)', async () => {
    const s = page('Screens'); const fr = node('FRAME', 'F', 1, 1); s.appendChild(fr);
    const c = node('COMPONENT', 'C'); const i = instanceOf(c); fr.appendChild(i);
    expect(() => i.mainComponent).toThrow(/dynamic-page/); // the mock refuses, as Figma does
    const [frame] = await serializeFrames([s] as unknown as PageNode[]);
    expect(frame.instances).toEqual([{ component: c.id, count: 1 }]);
  });

  it('an unloaded page refuses the search and the failure propagates (no silently skipped page)', async () => {
    const s = page('Screens'); s.pageLoaded = false;
    const fr = node('FRAME', 'F', 1, 1); s.appendChild(fr);
    await expect(serializeFrames([s] as unknown as PageNode[])).rejects.toThrow(/unloaded page/);
  });
});

describe('serializeDesignSystem — end to end', () => {
  it('loads every page first, keeps the old fields and adds frames next to them', async () => {
    const figma = installMockFigma();
    const lib = page('Library'); const c = node('COMPONENT', 'Button'); c.boundVariables = { cornerRadius: alias('V:1') };
    lib.appendChild(c);
    const screens = page('Screens'); const fr = node('FRAME', 'Home', 10, 20); screens.appendChild(fr);
    fr.appendChild(instanceOf(c));
    for (const p of [lib, screens]) { p.pageLoaded = false; figma.root.appendChild(p); }
    const out = await serializeDesignSystem() as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(['components', 'counts', 'frames', 'styles', 'tokens']);
    expect(out.counts).toEqual({ components: 1, tokens: 0, styles: 0 });
    expect((out.components as Array<Record<string, unknown>>)[0].boundVariables).toEqual(['V:1']);
    expect((out.frames as Array<Record<string, unknown>>)[0]).toMatchObject({ name: 'Home', instances: [{ component: c.id, count: 1 }] });
  });
});
