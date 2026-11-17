// components[].boundVariables and components[].instances: where a binding is read, the
// instance boundary, and the set union. Every read has its own test so dropping any one of
// them turns exactly that test red.
import { beforeEach, describe, expect, it } from 'vitest';
import { installMockFigma } from './helpers/mock-figma.ts';
import { applySensing } from '../plugin/src/main/scan-design-system-sensing.ts';
import { alias, entryFor, instanceOf, localComponent, node, page, pagesOf, sn } from './helpers/scan-sensing-fixtures.ts';

async function senseOne(c: ReturnType<typeof node>) {
  const r = await applySensing([entryFor(c)], [sn(c)], pagesOf());
  expect(r.extra.sensing).toEqual({ status: 'complete' });
  return r.components[0] as { boundVariables: string[]; instances: Array<{ component: string; count: number }>; unresolvedInstances?: number };
}

describe('components[].boundVariables — binding locations', () => {
  beforeEach(() => { installMockFigma(); });

  it('reads every node-level shape: alias, alias array, componentProperties, text ranges; sorted and unique', async () => {
    const c = node('COMPONENT', 'C');
    c.boundVariables = {
      cornerRadius: alias('V:9'), itemSpacing: alias('V:3'), fills: [alias('V:1')],
      componentProperties: { Label: alias('V:4') }, textRangeFills: [alias('V:3')],
    };
    expect((await senseOne(c)).boundVariables).toEqual(['V:1', 'V:3', 'V:4', 'V:9']);
  });

  for (const field of ['fills', 'strokes'] as const) {
    it(`reads ${field} paint by paint, with the node-level mirror off (the paint read is the only source)`, async () => {
      const c = node('COMPONENT', 'C');
      c.paintBindingMirror = false;
      c[field] = [{ type: 'SOLID' }, { type: 'SOLID', boundVariables: { color: alias(`V:${field}`) } }];
      expect((await senseOne(c)).boundVariables).toEqual([`V:${field}`]);
    });
  }

  it('reads gradient-stop bindings', async () => {
    const c = node('COMPONENT', 'C');
    c.paintBindingMirror = false;
    c.fills = [{ type: 'GRADIENT_LINEAR', gradientStops: [{ boundVariables: { color: alias('V:stop1') } }, { boundVariables: {} }, { boundVariables: { color: alias('V:stop2') } }] }];
    expect((await senseOne(c)).boundVariables).toEqual(['V:stop1', 'V:stop2']);
  });

  it('reads effect bindings', async () => {
    const c = node('COMPONENT', 'C');
    c.effects = [{ type: 'DROP_SHADOW', boundVariables: { radius: alias('V:fx') } }];
    expect((await senseOne(c)).boundVariables).toEqual(['V:fx']);
  });

  it('reads layout-grid bindings', async () => {
    const c = node('COMPONENT', 'C');
    c.layoutGrids = [{ pattern: 'GRID', boundVariables: { sectionSize: alias('V:grid') } }];
    expect((await senseOne(c)).boundVariables).toEqual(['V:grid']);
  });

  it('reads the default values of component property definitions (set-level; a variant child refuses the read)', async () => {
    const set = node('COMPONENT_SET', 'Btn');
    set.componentPropertyDefinitions = { 'Label#1': { type: 'TEXT', defaultValue: 'x', boundVariables: { defaultValue: alias('V:def') } } };
    const variant = node('COMPONENT', 'State=Default');
    Object.defineProperty(variant, 'componentPropertyDefinitions', {
      get() { throw new Error('in get_componentPropertyDefinitions: Can only get component property definitions of a component set or non-variant component'); },
    });
    set.appendChild(variant);
    expect((await senseOne(set)).boundVariables).toEqual(['V:def']);
  });

  it('a mixed value (figma.mixed) and a throwing getter read as "nothing bound", never abort', async () => {
    const c = node('COMPONENT', 'C');
    c.fills = (globalThis as unknown as { figma: { mixed: unknown } }).figma.mixed;
    Object.defineProperty(c, 'effects', { get() { throw new Error('boom'); } });
    c.boundVariables = { cornerRadius: alias('V:5') };
    expect((await senseOne(c)).boundVariables).toEqual(['V:5']);
  });

  it('an unbound component reports empty lists (sensed, none) and keeps its old fields', async () => {
    const ds = page('DS'); const c = localComponent(ds, 'Plain');
    const r = await senseOne(c);
    expect(r).toMatchObject({ id: c.id, name: 'Plain', type: 'COMPONENT', boundVariables: [], instances: [] });
  });
});

describe('instance boundary and sets', () => {
  beforeEach(() => { installMockFigma(); });

  it('stops at an instance: its own binding is read, what is inside it is not — for bindings AND instances', async () => {
    const lib = page('Lib');
    const button = localComponent(lib, 'Button'); const icon = localComponent(lib, 'Icon');
    const card = localComponent(lib, 'Card');
    const wrapper = node('FRAME', 'wrapper'); card.appendChild(wrapper);
    const inst = instanceOf(button); inst.boundVariables = { itemSpacing: alias('V:own') };
    wrapper.appendChild(inst);
    const inside = node('FRAME', 'inside-instance'); inside.boundVariables = { cornerRadius: alias('V:override') };
    inside.appendChild(instanceOf(icon));
    inst.appendChild(inside);
    const r = await senseOne(card);
    expect(r.boundVariables).toEqual(['V:own']);
    expect(r.instances).toEqual([{ component: button.id, count: 1 }]);
  });

  it('a set is the union of its variants for bindings and the sum for instances', async () => {
    const lib = page('Lib'); const icon = localComponent(lib, 'Icon');
    const set = node('COMPONENT_SET', 'Btn'); lib.appendChild(set);
    for (const [name, v] of [['State=A', 'V:a'], ['State=B', 'V:b']] as const) {
      const variant = node('COMPONENT', name); variant.boundVariables = { cornerRadius: alias(v) };
      variant.appendChild(instanceOf(icon)); set.appendChild(variant);
    }
    set.appendChild(Object.assign(node('COMPONENT', 'State=C'), { boundVariables: { cornerRadius: alias('V:a') } }));
    const r = await senseOne(set);
    expect(r.boundVariables).toEqual(['V:a', 'V:b']);
    expect(r.instances).toEqual([{ component: icon.id, count: 2 }]);
  });

  it('a component whose subtree holds unresolved instances reports their count; a set sums its variants; none writes no key', async () => {
    const lib = page('Lib'); const ok = localComponent(lib, 'Ok');
    const plain = localComponent(lib, 'Plain'); plain.appendChild(instanceOf(ok));
    expect('unresolvedInstances' in await senseOne(plain)).toBe(false);
    const set = node('COMPONENT_SET', 'Btn'); lib.appendChild(set);
    for (const name of ['State=A', 'State=B']) {
      const variant = node('COMPONENT', name); set.appendChild(variant);
      variant.appendChild(instanceOf(null));
      const throwing = instanceOf(null);
      throwing.getMainComponentAsync = async () => { throw new Error('lookup failed'); };
      variant.appendChild(throwing);
    }
    const r = await senseOne(set);
    expect(r.unresolvedInstances).toBe(4);
    expect(r.instances).toEqual([]);
  });

  it('a set never lists itself: a variant using a sibling variant is dropped by rule, not counted as unresolved', async () => {
    const lib = page('Lib'); const other = localComponent(lib, 'Other');
    const set = node('COMPONENT_SET', 'Tab'); lib.appendChild(set);
    const a = node('COMPONENT', 'On=true'); const b = node('COMPONENT', 'On=false'); set.appendChild(a); set.appendChild(b);
    a.appendChild(instanceOf(b)); a.appendChild(instanceOf(other));
    const r = await senseOne(set);
    expect(r.instances).toEqual([{ component: other.id, count: 1 }]);
    expect(r.unresolvedInstances).toBeUndefined();
  });

  it('reads property-definition defaults on a lone component that is not a set', async () => {
    const c = node('COMPONENT', 'Lone');
    c.componentPropertyDefinitions = { 'Label#1': { type: 'TEXT', defaultValue: 'x', boundVariables: { defaultValue: alias('V:lone') } } };
    expect((await senseOne(c)).boundVariables).toEqual(['V:lone']);
  });
});
