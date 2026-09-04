// `figmaUndoBracket()` itself — untested until now (exec-undo-group.test.ts only exercises
// `runInUndoGroup` against an INJECTED `UndoBracket`, never the real one that talks to
// `figma`). Covers the sentinel-registry contract `begin()` must uphold:
//   1. the frame it creates is registered by id;
//   2. every STRAY sentinel the sweep finds (a leftover from a run whose commit() threw, or
//      one interrupted by a plugin reload — the registry is per plugin session, so a reload
//      forgets every id it held) is registered BEFORE `remove()` is called on it — otherwise
//      that stray's own DELETE documentchange, delivered asynchronously after this sweep,
//      would reach the feed as an uncounted "Deleted a FRAME node";
//   3. a lookalike-NAMED frame that lacks the plugin-data marker is identified by data, never
//      by name, so it is neither swept nor registered.
import { describe, it, expect, beforeEach } from 'vitest';
import { figmaUndoBracket } from '../plugin/src/main/executor-exec-js.ts';
import { isSentinelId, resetSentinelRegistryForTest } from '../plugin/src/main/undo-sentinel-registry.ts';

const SENTINEL_KEY = 'figmaAgentUndoSentinel';
const SENTINEL_NAME = '[figma-agent] undo sentinel';

interface FakeNode {
  id: string;
  name: string;
  removed: boolean;
  visible: boolean;
  x: number;
  y: number;
  pluginData: Record<string, string>;
  getPluginData: (key: string) => string;
  setPluginData: (key: string, value: string) => void;
  resize: (w: number, h: number) => void;
  remove: () => void;
}

function makeNode(id: string, name: string, marked: boolean): FakeNode {
  const node = {
    id, name, removed: false, visible: true, x: 0, y: 0,
    pluginData: marked ? { [SENTINEL_KEY]: '1' } : {},
  } as FakeNode;
  node.getPluginData = (key) => node.pluginData[key] ?? '';
  node.setPluginData = (key, value) => { node.pluginData[key] = value; };
  node.resize = () => {};
  node.remove = () => { node.removed = true; };
  return node;
}

/** Wraps a stray's `remove()` to record whether its id was ALREADY registered at the
 *  instant `remove()` was invoked — an order-sensitive spy, not just an end-state check. */
function watchRemoveOrder(node: FakeNode, log: Array<{ id: string; registeredBeforeRemove: boolean }>): void {
  const original = node.remove;
  node.remove = () => {
    log.push({ id: node.id, registeredBeforeRemove: isSentinelId(node.id) });
    original();
  };
}

function installFakeFigma(strays: FakeNode[]) {
  const created: FakeNode[] = [];
  const appended: FakeNode[] = [];
  let idSeq = 0;
  const page = {
    findChildren: (pred: (n: FakeNode) => boolean) => strays.filter(pred),
    appendChild: (n: FakeNode) => { appended.push(n); },
  };
  (globalThis as any).figma = {
    currentPage: page,
    commitUndo: () => {},
    createFrame: () => {
      idSeq += 1;
      const f = makeNode(`created-${idSeq}`, '', false);
      created.push(f);
      return f;
    },
  };
  return { created, appended };
}

beforeEach(() => {
  resetSentinelRegistryForTest();
});

describe('figmaUndoBracket().begin() — sentinel registration', () => {
  it('registers the newly created frame by id', () => {
    const { created } = installFakeFigma([]);
    const bracket = figmaUndoBracket();

    bracket.begin();

    expect(created).toHaveLength(1);
    expect(isSentinelId(created[0].id)).toBe(true);
  });

  it('registers a swept STRAY sentinel BEFORE remove() is called on it — RED against the pre-fix sweep', () => {
    const stray = makeNode('stray-1', SENTINEL_NAME, true);
    const removeLog: Array<{ id: string; registeredBeforeRemove: boolean }> = [];
    watchRemoveOrder(stray, removeLog);
    installFakeFigma([stray]);
    const bracket = figmaUndoBracket();

    bracket.begin();

    expect(stray.removed).toBe(true);
    expect(removeLog).toEqual([{ id: 'stray-1', registeredBeforeRemove: true }]);
    expect(isSentinelId('stray-1')).toBe(true); // still true after removal — lazy release
  });

  it('registers EVERY swept stray before its own remove(), in a multi-stray sweep', () => {
    const strayA = makeNode('stray-a', SENTINEL_NAME, true);
    const strayB = makeNode('stray-b', SENTINEL_NAME, true);
    const removeLog: Array<{ id: string; registeredBeforeRemove: boolean }> = [];
    watchRemoveOrder(strayA, removeLog);
    watchRemoveOrder(strayB, removeLog);
    installFakeFigma([strayA, strayB]);
    const bracket = figmaUndoBracket();

    bracket.begin();

    expect(removeLog).toEqual([
      { id: 'stray-a', registeredBeforeRemove: true },
      { id: 'stray-b', registeredBeforeRemove: true },
    ]);
  });

  it('a lookalike-NAMED frame withOUT the plugin-data marker is neither swept nor registered — identity is data, not name', () => {
    const lookalike = makeNode('lookalike-1', SENTINEL_NAME, false); // no SENTINEL_KEY marker
    const removeLog: Array<{ id: string; registeredBeforeRemove: boolean }> = [];
    watchRemoveOrder(lookalike, removeLog);
    installFakeFigma([lookalike]);
    const bracket = figmaUndoBracket();

    bracket.begin();

    expect(lookalike.removed).toBe(false); // never swept
    expect(removeLog).toEqual([]);
    expect(isSentinelId('lookalike-1')).toBe(false); // never registered
  });
});
