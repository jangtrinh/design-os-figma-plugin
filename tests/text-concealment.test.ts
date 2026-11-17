// Concealed text: a TEXT node a human cannot see on the canvas is FLAGGED on every read
// path an agent uses (scan-node walker / `context` record / `ui.textConcealment`), and
// never stripped — the characters stay, the flag says "this is data a reviewer never saw".
//
// The fixtures are plain objects with `parent` links: the same seam the context reader is
// driven through. They are HOSTILE where the live sandbox is hostile — `figma.mixed` is a
// symbol, and under `documentAccess: "dynamic-page"` a getter can throw; a throw must read
// as `unknown`, never crash the read and never pass as "visible".
import { describe, expect, it } from 'vitest';
import { readConcealment } from '../plugin/src/main/text-concealment.ts';

const MIXED = Symbol('figma.mixed');
const BLACK = { type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 1, visible: true };

type Fake = Record<string, unknown>;

function page(children: Fake[] = []): Fake {
  return { id: '0:1', type: 'PAGE', name: 'Page', parent: null, children };
}

function attach(parent: Fake, child: Fake): Fake {
  child.parent = parent;
  const kids = (parent.children as Fake[] | undefined) ?? [];
  kids.push(child);
  parent.children = kids;
  return child;
}

function frame(over: Fake = {}): Fake {
  return {
    id: '1:1', type: 'FRAME', name: 'Frame', visible: true, opacity: 1, clipsContent: false,
    absoluteBoundingBox: { x: 0, y: 0, width: 400, height: 400 }, ...over,
  };
}

function text(over: Fake = {}): Fake {
  return {
    id: '1:2', type: 'TEXT', name: 'Label', characters: 'Hello', visible: true, opacity: 1,
    fills: [BLACK], strokes: [], strokeWeight: 1, fontSize: 14,
    absoluteBoundingBox: { x: 10, y: 10, width: 100, height: 20 }, ...over,
  };
}

/** page → frame(over) → text(textOver); returns the text. */
function inFrame(frameOver: Fake = {}, textOver: Fake = {}): Fake {
  const f = attach(page(), frame(frameOver));
  return attach(f, text(textOver));
}

const reasonsOf = (node: Fake): string[] | null => readConcealment(node, new WeakMap())?.reasons ?? null;

describe('readConcealment — each reason', () => {
  it('ordinary visible text → null', () => {
    expect(readConcealment(inFrame(), new WeakMap())).toBeNull();
  });

  it('invisible: the node itself has visible=false', () => {
    expect(reasonsOf(inFrame({}, { visible: false }))).toEqual(['invisible']);
  });

  it('invisible: an ANCESTOR up to the page has visible=false', () => {
    const outer = attach(page(), frame({ id: '1:0', visible: false }));
    const inner = attach(outer, frame({ id: '1:1' }));
    expect(reasonsOf(attach(inner, text()))).toEqual(['invisible']);
  });

  it('transparent: opacity multiplied through ancestors drops below 0.05', () => {
    const outer = attach(page(), frame({ id: '1:0', opacity: 0.2 }));
    const inner = attach(outer, frame({ id: '1:1', opacity: 0.2 }));
    expect(reasonsOf(attach(inner, text()))).toEqual(['transparent']); // 0.04
  });

  it('opacity product at the threshold is not transparent', () => {
    const outer = attach(page(), frame({ id: '1:0', opacity: 0.25 }));
    const inner = attach(outer, frame({ id: '1:1', opacity: 0.2 }));
    expect(reasonsOf(attach(inner, text()))).toBeNull(); // 0.05
  });

  it('transparent: empty fills and no strokes', () => {
    expect(reasonsOf(inFrame({}, { fills: [] }))).toEqual(['transparent']);
  });

  it('transparent: every fill has alpha 0 or is hidden', () => {
    const fills = [{ ...BLACK, opacity: 0 }, { ...BLACK, visible: false }];
    expect(reasonsOf(inFrame({}, { fills }))).toEqual(['transparent']);
  });

  it('a visible stroke with empty fills is visible paint → no flag', () => {
    expect(reasonsOf(inFrame({}, { fills: [], strokes: [BLACK], strokeWeight: 1 }))).toBeNull();
  });

  it('a zero-weight stroke is not visible paint', () => {
    expect(reasonsOf(inFrame({}, { fills: [], strokes: [BLACK], strokeWeight: 0 }))).toEqual(['transparent']);
  });

  it('a gradient whose every stop has alpha 0 is not visible paint', () => {
    const fills = [{
      type: 'GRADIENT_LINEAR', visible: true, opacity: 1,
      gradientStops: [{ position: 0, color: { r: 0, g: 0, b: 0, a: 0 } }, { position: 1, color: { r: 1, g: 1, b: 1, a: 0 } }],
    }];
    expect(reasonsOf(inFrame({}, { fills }))).toEqual(['transparent']);
  });

  it('mixed fills (figma.mixed): multi-colour visible text → no flag', () => {
    const t = inFrame({}, {
      fills: MIXED,
      getStyledTextSegments: (fields: string[]) => {
        expect(fields).toEqual(['fills']);
        return [
          { start: 0, end: 2, fills: [BLACK] },
          { start: 2, end: 5, fills: [{ ...BLACK, color: { r: 1, g: 0, b: 0 } }] },
        ];
      },
    });
    expect(reasonsOf(t)).toBeNull();
  });

  it('mixed fills: transparent only when EVERY run has no visible paint', () => {
    const oneVisible = inFrame({}, {
      fills: MIXED,
      getStyledTextSegments: () => [{ fills: [] }, { fills: [BLACK] }],
    });
    expect(reasonsOf(oneVisible)).toBeNull();
    const none = inFrame({}, {
      fills: MIXED,
      getStyledTextSegments: () => [{ fills: [] }, { fills: [{ ...BLACK, opacity: 0 }] }],
    });
    expect(reasonsOf(none)).toEqual(['transparent']);
  });

  it('tiny: fontSize 3.9 flags, 4 does not', () => {
    expect(reasonsOf(inFrame({}, { fontSize: 3.9 }))).toEqual(['tiny']);
    expect(reasonsOf(inFrame({}, { fontSize: 4 }))).toBeNull();
  });

  it('tiny: mixed fontSize uses the SMALLEST run', () => {
    const t = inFrame({}, {
      fontSize: MIXED,
      getStyledTextSegments: (fields: string[]) => {
        expect(fields).toEqual(['fontSize']);
        return [{ fontSize: 14 }, { fontSize: 2 }];
      },
    });
    expect(reasonsOf(t)).toEqual(['tiny']);
  });

  it('clipped: entirely outside a clipsContent ancestor', () => {
    const t = inFrame({ clipsContent: true }, { absoluteBoundingBox: { x: 500, y: 10, width: 100, height: 20 } });
    expect(reasonsOf(t)).toEqual(['clipped']);
  });

  it('partial overlap with a clipping ancestor is NOT clipped', () => {
    const t = inFrame({ clipsContent: true }, { absoluteBoundingBox: { x: 350, y: 10, width: 100, height: 20 } });
    expect(reasonsOf(t)).toBeNull();
  });

  it('outside a NON-clipping ancestor is not clipped', () => {
    const t = inFrame({ clipsContent: false }, { absoluteBoundingBox: { x: 500, y: 10, width: 100, height: 20 } });
    expect(reasonsOf(t)).toBeNull();
  });

  it('several reasons at once are all reported, in a fixed order', () => {
    expect(reasonsOf(inFrame({ visible: false }, { fills: [], fontSize: 1 }))).toEqual(['invisible', 'transparent', 'tiny']);
  });
});

describe('readConcealment — neutral defaults and refusals', () => {
  it('missing properties are neutral (opacity 1, not clipping, no parent)', () => {
    expect(reasonsOf({ type: 'TEXT', characters: 'x', fills: [BLACK], fontSize: 12 })).toBeNull();
  });

  it('a SECTION or GROUP ancestor is not flagged', () => {
    const section = attach(page(), { id: '2:1', type: 'SECTION', name: 'Section' });
    const group = attach(section, { id: '2:2', type: 'GROUP', name: 'Group' });
    expect(reasonsOf(attach(group, text({ absoluteBoundingBox: { x: 9000, y: 9000, width: 10, height: 10 } })))).toBeNull();
  });

  it('a null parent ends the chain', () => {
    expect(reasonsOf(text({ parent: null }))).toBeNull();
  });

  it('a getter that THROWS → unknown, never a crash', () => {
    const f = attach(page(), frame());
    Object.defineProperty(f, 'visible', { get() { throw new Error('The node is on an unloaded page'); } });
    expect(reasonsOf(attach(f, text()))).toEqual(['unknown']);
  });

  it('a throwing getter on the text itself → unknown', () => {
    const t = inFrame();
    Object.defineProperty(t, 'fontSize', { get() { throw new Error('refused'); } });
    expect(reasonsOf(t)).toEqual(['unknown']);
  });

  it('more than 64 ancestors → unknown', () => {
    let parent = page();
    for (let i = 0; i < 70; i += 1) parent = attach(parent, frame({ id: `3:${i}` }));
    expect(reasonsOf(attach(parent, text()))).toEqual(['unknown']);
  });

  it('exactly 64 ancestors below the page is still read', () => {
    let parent = page();
    for (let i = 0; i < 64; i += 1) parent = attach(parent, frame({ id: `3:${i}` }));
    expect(reasonsOf(attach(parent, text()))).toBeNull();
  });
});

describe('readConcealment — per-walk memo', () => {
  it('reads each ancestor property at most once across sibling texts in one walk', () => {
    const reads = new Map<string, number>();
    const counting = (id: string, props: Fake): Fake => {
      const node: Fake = { id, type: 'FRAME', name: id };
      for (const [key, value] of Object.entries(props)) {
        Object.defineProperty(node, key, {
          get() { reads.set(`${id}.${key}`, (reads.get(`${id}.${key}`) ?? 0) + 1); return value; },
          enumerable: true,
        });
      }
      return node;
    };
    const p = page();
    const outer = counting('outer', { visible: true, opacity: 1, clipsContent: true, absoluteBoundingBox: { x: 0, y: 0, width: 400, height: 400 }, parent: p });
    const inner = counting('inner', { visible: true, opacity: 0.5, clipsContent: false, parent: outer });
    const memo = new WeakMap<object, unknown>();
    for (let i = 0; i < 5; i += 1) {
      expect(readConcealment(text({ id: `4:${i}`, parent: inner }), memo)).toBeNull();
    }
    expect(reads.size).toBeGreaterThan(0);
    for (const [key, count] of reads) expect({ key, count }).toEqual({ key, count: 1 });
  });
});
