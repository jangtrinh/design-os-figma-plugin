// Plain-object canvas trees for the concealed-text read-path tests: `parent` links like the
// live sandbox, `figma.mixed` as a symbol, and no `figma` global needed. Shared by the test
// and by the golden files it compares against, so a golden always describes THESE nodes.

type Fake = Record<string, unknown>;

export const BLACK_PAINT = { type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 1, visible: true, blendMode: 'NORMAL' };

export function link(parent: Fake, ...children: Fake[]): Fake {
  for (const child of children) child.parent = parent;
  parent.children = [...((parent.children as Fake[] | undefined) ?? []), ...children];
  return parent;
}

export function fakePage(): Fake {
  return { id: '0:1', type: 'PAGE', name: 'Page', parent: null, children: [] };
}

export function fakeFrame(over: Fake = {}): Fake {
  return {
    id: '10:1', type: 'FRAME', name: 'Card', visible: true, opacity: 1, clipsContent: false,
    width: 320, height: 200, layoutMode: 'VERTICAL', itemSpacing: 8,
    fills: [BLACK_PAINT], strokes: [],
    absoluteBoundingBox: { x: 0, y: 0, width: 320, height: 200 },
    getCSSAsync: async () => ({ display: 'flex', 'flex-direction': 'column', gap: '8px' }),
    ...over,
  };
}

export function fakeText(over: Fake = {}): Fake {
  return {
    id: '10:2', type: 'TEXT', name: 'Title', visible: true, opacity: 1, characters: 'Hello world',
    width: 120, height: 24, fontSize: 20, fontName: { family: 'Inter', style: 'Bold' },
    lineHeight: { unit: 'PIXELS', value: 24 }, letterSpacing: { unit: 'PERCENT', value: 0 },
    textAlignHorizontal: 'LEFT', textAutoResize: 'WIDTH_AND_HEIGHT', textDecoration: 'NONE', textCase: 'ORIGINAL',
    fills: [BLACK_PAINT], strokes: [], strokeWeight: 1,
    layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG',
    absoluteBoundingBox: { x: 16, y: 16, width: 120, height: 24 },
    getCSSAsync: async () => ({ color: '#000', 'font-size': '20px' }),
    ...over,
  };
}

/** page → visible frame → [visible text, visible multi-colour text]. Returns the frame. */
export function visibleCard(): Fake {
  const mixed = fakeText({
    id: '10:3', name: 'Mixed', characters: 'Red and black', fills: Symbol('figma.mixed'),
    getStyledTextSegments: (fields: string[]) => (fields[0] === 'fills'
      ? [{ start: 0, end: 3, fills: [{ ...BLACK_PAINT, color: { r: 1, g: 0, b: 0 } }] }, { start: 3, end: 13, fills: [BLACK_PAINT] }]
      : []),
  });
  const frame = fakeFrame();
  link(fakePage(), frame);
  link(frame, fakeText(), mixed);
  return frame;
}
