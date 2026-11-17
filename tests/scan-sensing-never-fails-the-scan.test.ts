// The sensing step can never fail the scan: on a throw or a time-budget overrun the scan
// returns exactly the pre-feature result plus `sensing: {status: "skipped", reason}`; with
// the new fields stripped, a complete scan is byte-identical to the pre-feature output.
import { beforeEach, describe, expect, it } from 'vitest';
import { installMockFigma } from './helpers/mock-figma.ts';
import { serializeDesignSystem } from '../plugin/src/main/serialize-node.ts';
import { applySensing } from '../plugin/src/main/scan-design-system-sensing.ts';
import { SensingBudget } from '../plugin/src/main/scan-sensing-budget.ts';
import { alias, entryFor, instanceOf, localComponent, node, page, pagesOf, sn } from './helpers/scan-sensing-fixtures.ts';

/** A small file with a set, a lone component, a variable and one screen frame. */
function buildFile() {
  const figma = installMockFigma();
  const lib = page('Library'); const screens = page('Screens');
  const set = node('COMPONENT_SET', 'Button'); lib.appendChild(set);
  set.componentPropertyDefinitions = { State: { type: 'VARIANT', variantOptions: ['Default', 'Hover'] } };
  for (const v of ['State=Default', 'State=Hover']) set.appendChild(node('COMPONENT', v));
  const badge = localComponent(lib, 'Badge'); badge.boundVariables = { cornerRadius: alias('V:1') };
  const col = figma.variables.createVariableCollection('Brand');
  const variable = figma.variables.createVariable('radius/md', col, 'FLOAT');
  const fr = node('FRAME', 'Home', 100, 50); screens.appendChild(fr); fr.appendChild(instanceOf(badge));
  for (const p of [lib, screens]) figma.root.appendChild(p);
  // What the scan returned BEFORE the sensing fields existed, written out key by key.
  const preFeature = {
    components: [
      { id: set.id, key: undefined, name: 'Button', type: 'COMPONENT_SET', page: { id: lib.id, name: 'Library' }, variantAxes: { State: ['Default', 'Hover'] } },
      { id: badge.id, key: undefined, name: 'Badge', type: 'COMPONENT', page: { id: lib.id, name: 'Library' } },
    ],
    tokens: [{ id: variable.id, name: 'radius/md', type: 'FLOAT', collection: 'Brand', value: null }],
    styles: [],
    counts: { components: 2, tokens: 1, styles: 0 },
  };
  return { figma, fr, preFeature };
}

const stripNew = (out: Record<string, unknown>): string => JSON.stringify(out, (k, v) =>
  k === 'frames' || k === 'sensing' || k === 'boundVariables' || k === 'instances' ? undefined : v);

describe('sensing can never fail the scan', () => {
  beforeEach(() => { installMockFigma(); });

  it('a complete scan, minus the new fields, is byte-identical to the pre-feature output', async () => {
    const { preFeature } = buildFile();
    const out = await serializeDesignSystem();
    expect(out.sensing).toEqual({ status: 'complete' });
    expect(stripNew(out)).toBe(JSON.stringify(preFeature));
  });

  it('a throw inside sensing returns the pre-feature output exactly, plus sensing.skipped with the reason', async () => {
    const { fr, preFeature } = buildFile();
    Object.defineProperty(fr, 'width', { get() { throw new Error('width refused'); } });
    const out = await serializeDesignSystem();
    expect(out.sensing).toEqual({ status: 'skipped', reason: 'width refused' });
    expect(JSON.stringify({ ...out, sensing: undefined })).toBe(JSON.stringify(preFeature));
    expect('frames' in out).toBe(false);
  });

  it('exceeding the time budget returns the components untouched and sensing.skipped; no partial lists', async () => {
    const lib = page('Lib'); const c = localComponent(lib, 'C'); c.boundVariables = { cornerRadius: alias('V:1') };
    const entries = [entryFor(c)];
    let t = 0; // each clock read advances 1000 ms
    const budget = new SensingBudget(1500, () => (t += 1000));
    const lookups = [instanceOf(c), instanceOf(c), instanceOf(c)];
    for (const i of lookups) c.appendChild(i);
    const r = await applySensing(entries, [sn(c)], pagesOf(lib), budget);
    expect(r.extra).toEqual({ sensing: { status: 'skipped', reason: 'time-budget-exceeded' } });
    expect(r.components).toBe(entries);
    expect(JSON.stringify(r.components)).toBe(JSON.stringify([entryFor(c)]));
  });

  it('reading children of an unloaded page throws (typings), which sensing turns into skipped', async () => {
    const pg = page('Screens'); pg.pageLoaded = false;
    expect(() => pg.children).toThrow(/unloaded page/);
    const r = await applySensing([], [], pagesOf(pg));
    expect(r.extra.sensing).toMatchObject({ status: 'skipped' });
  });

  it('the output carries no timing and no timestamp: two runs are byte-equal', async () => {
    buildFile();
    const a = JSON.stringify(await serializeDesignSystem());
    const b = JSON.stringify(await serializeDesignSystem());
    expect(a).toBe(b);
  });

  it('a lookup that never settles cannot hang the scan: it ends as skipped with the budget reason, inside the test deadline', async () => {
    const lib = page('Lib'); const c = localComponent(lib, 'C');
    const pg = page('Screens'); const fr = node('FRAME', 'F'); pg.appendChild(fr);
    const stuck = instanceOf(c); stuck.getMainComponentAsync = () => new Promise(() => {});
    fr.appendChild(stuck);
    const entries = [entryFor(c)];
    const r = await applySensing(entries, [sn(c)], pagesOf(pg), new SensingBudget(50));
    expect(r.extra).toEqual({ sensing: { status: 'skipped', reason: 'time-budget-exceeded' } });
    expect(r.components).toBe(entries);
  });

  it('a never-settling lookup inside a component ends the sensing step the same way', async () => {
    const c = node('COMPONENT', 'C');
    const stuck = instanceOf(null); stuck.getMainComponentAsync = () => new Promise(() => {});
    c.appendChild(stuck);
    const r = await applySensing([entryFor(c)], [sn(c)], pagesOf(), new SensingBudget(50));
    expect(r.extra.sensing).toEqual({ status: 'skipped', reason: 'time-budget-exceeded' });
  });

  it('the walk itself checks the budget: a big subtree with no instance still ends as skipped', async () => {
    const c = node('COMPONENT', 'Big');
    for (let k = 0; k < 200; k++) c.appendChild(node('FRAME', `f${k}`));
    let t = 0;
    const r = await applySensing([entryFor(c)], [sn(c)], pagesOf(), new SensingBudget(1500, () => (t += 1000)));
    expect(r.extra).toEqual({ sensing: { status: 'skipped', reason: 'time-budget-exceeded' } });
  });
});
