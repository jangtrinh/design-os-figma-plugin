// frames[]: which frames are listed (page and section children), the section name, the
// instance boundary, and how an instance resolves to a `component` (rule: async lookup only;
// anything that names nothing is counted in unresolvedInstances, never guessed).
import { beforeEach, describe, expect, it } from 'vitest';
import { installMockFigma } from './helpers/mock-figma.ts';
import { applySensing } from '../plugin/src/main/scan-design-system-sensing.ts';
import { instanceOf, localComponent, node, page, pagesOf } from './helpers/scan-sensing-fixtures.ts';

const framesOf = async (...p: ReturnType<typeof page>[]) => {
  const r = await applySensing([], [], pagesOf(...p));
  expect(r.extra.sensing).toEqual({ status: 'complete' });
  return r.extra.frames as Array<Record<string, unknown>>;
};
const refs = (f: Record<string, unknown>) => f.instances as Array<{ component: string; count: number }>;

describe('frames[] — which frames', () => {
  beforeEach(() => { installMockFigma(); });

  it('lists page frames and frames inside a section and a nested section, naming the innermost section', async () => {
    const pg = page('Screens');
    const direct = node('FRAME', 'Direct', 10, 20); pg.appendChild(direct);
    const outer = node('SECTION', 'Onboarding'); pg.appendChild(outer);
    const inOuter = node('FRAME', 'In outer'); outer.appendChild(inOuter);
    const inner = node('SECTION', 'Step 2'); outer.appendChild(inner);
    const inInner = node('FRAME', 'In inner'); inner.appendChild(inInner);
    const frames = await framesOf(pg);
    expect(frames.map((f) => [f.name, f.section])).toEqual([['Direct', undefined], ['In outer', 'Onboarding'], ['In inner', 'Step 2']]);
    expect('section' in frames[0]).toBe(false);
    expect(frames[0]).toMatchObject({ id: direct.id, page: { id: pg.id, name: 'Screens' }, w: 10, h: 20 });
  });

  it('does not list components, groups or loose shapes as frames, and does not look inside a group', async () => {
    const pg = page('P');
    localComponent(pg, 'C'); pg.appendChild(node('RECTANGLE', 'r'));
    const g = node('GROUP', 'g'); pg.appendChild(g); g.appendChild(node('FRAME', 'hidden-in-group'));
    expect(await framesOf(pg)).toEqual([]);
  });
});

describe('frames[] — instances', () => {
  beforeEach(() => { installMockFigma(); });

  it('counts instances through frames and groups, stops at an instance, counts hidden ones', async () => {
    const lib = page('Lib'); const btn = localComponent(lib, 'Button'); const icon = localComponent(lib, 'Icon');
    const pg = page('Screens'); const fr = node('FRAME', 'F', 1, 1); pg.appendChild(fr);
    const grp = node('GROUP', 'g'); fr.appendChild(grp);
    const outer = instanceOf(btn); grp.appendChild(outer);
    outer.appendChild(instanceOf(icon)); // inside an instance: not visited
    const hidden = instanceOf(btn); hidden.visible = false; fr.appendChild(hidden);
    const [f] = await framesOf(pg);
    expect(refs(f)).toEqual([{ component: btn.id, count: 2 }]);
  });

  it('a variant folds into its set; a library component is named by key, and by its set key when the lookup gives a set', async () => {
    const lib = page('Lib'); const set = node('COMPONENT_SET', 'Card'); lib.appendChild(set);
    const variant = node('COMPONENT', 'Size=L'); set.appendChild(variant);
    const remoteSet = node('COMPONENT_SET', 'RSet'); remoteSet.remote = true; remoteSet.key = 'aaaa1111';
    const remoteVariant = node('COMPONENT', 'V=1'); remoteVariant.remote = true; remoteVariant.key = 'bbbb2222'; remoteSet.appendChild(remoteVariant);
    const remoteLone = node('COMPONENT', 'Lone'); remoteLone.remote = true; remoteLone.key = 'cccc3333';
    const pg = page('Screens'); const fr = node('FRAME', 'F'); pg.appendChild(fr);
    for (const m of [variant, remoteVariant, remoteLone]) fr.appendChild(instanceOf(m));
    const [f] = await framesOf(pg);
    const expected = [{ component: 'aaaa1111', count: 1 }, { component: 'cccc3333', count: 1 }, { component: set.id, count: 1 }]
      .sort((a, b) => (a.component < b.component ? -1 : 1));
    expect(refs(f)).toEqual(expected);
    expect(f.unresolvedInstances).toBeUndefined();
  });

  it('a lookup that returns nothing, throws, or returns a removed local component is unresolved, never given a component', async () => {
    const pg = page('Screens'); const fr = node('FRAME', 'F'); pg.appendChild(fr);
    fr.appendChild(instanceOf(null));
    const rejecting = instanceOf(null);
    rejecting.getMainComponentAsync = async () => { throw new Error('lookup failed'); };
    fr.appendChild(rejecting);
    fr.appendChild(instanceOf(node('COMPONENT', 'Removed'))); // local, no parent: gone from the document
    const [f] = await framesOf(pg);
    expect(refs(f)).toEqual([]);
    expect(f.unresolvedInstances).toBe(3);
  });

  it('the lookup is asynchronous only: the sync getter throws in the mock, as under dynamic-page', async () => {
    const lib = page('Lib'); const c = localComponent(lib, 'C'); const i = instanceOf(c);
    expect(() => i.mainComponent).toThrow(/dynamic-page/);
    const pg = page('Screens'); const fr = node('FRAME', 'F'); pg.appendChild(fr); fr.appendChild(i);
    expect(refs((await framesOf(pg))[0])).toEqual([{ component: c.id, count: 1 }]);
  });

  it('runs lookups with bounded concurrency', async () => {
    const lib = page('Lib'); const c = localComponent(lib, 'C');
    const pg = page('Screens'); const fr = node('FRAME', 'F'); pg.appendChild(fr);
    let inFlight = 0; let peak = 0;
    for (let k = 0; k < 60; k++) {
      const i = instanceOf(c);
      i.getMainComponentAsync = async () => { inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 1)); inFlight--; return c; };
      fr.appendChild(i);
    }
    const [f] = await framesOf(pg);
    expect(refs(f)).toEqual([{ component: c.id, count: 60 }]);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(16);
  });
});
