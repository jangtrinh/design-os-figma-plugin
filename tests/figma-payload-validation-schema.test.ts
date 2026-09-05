import { describe, expect, it } from 'vitest';
import { PayloadValidationError, validateImportPayload } from '../shared/figma-payload-validation.ts';

const sharedColor = { r: 0.1, g: 0.2, b: 0.3, a: 1 };
const emptyTokens = () => ({ colors: [], typography: [], spacing: [], radii: [], shadows: [] });

function completeNode(): Record<string, unknown> {
  return {
    type: 'INSTANCE', name: '', width: 0, height: 0,
    layoutMode: 'GRID', itemSpacing: 0, paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
    primaryAxisSizingMode: 'AUTO', counterAxisSizingMode: 'FIXED', primaryAxisAlignItems: 'SPACE_BETWEEN',
    counterAxisAlignItems: 'BASELINE', layoutWrap: 'WRAP', counterAxisSpacing: 0,
    layoutSizingHorizontal: 'FILL', layoutSizingVertical: 'HUG', layoutGrow: 0,
    maxWidth: 0, minWidth: 0, maxHeight: 0, minHeight: 0,
    gridColumnCount: 1, gridRowCount: 1, gridRowGap: 0, gridColumnGap: 0,
    fills: [
      { type: 'SOLID', color: sharedColor },
      {
        type: 'GRADIENT_LINEAR',
        gradientStops: [{ color: sharedColor, position: 0 }, { color: sharedColor, position: 1 }],
        gradientTransform: [[1, 0, 0], [0, 1, 0]],
      },
    ],
    cornerRadius: 0, cornerRadii: { tl: 0, tr: 0, br: 0, bl: 0 },
    effects: [
      { type: 'DROP_SHADOW', offset: { x: -1, y: 2 }, radius: 0, spread: -1, color: sharedColor },
      { type: 'LAYER_BLUR', radius: 0 },
    ],
    opacity: 0, backgroundImageUrl: 'data:image/png;base64,AA==', backgroundSize: 'future-value',
    backgroundPosition: 'future-value', strokes: [{ type: 'SOLID', color: sharedColor }],
    strokeWeight: 0, strokeWeights: { top: 0, right: 0, bottom: 0, left: 0 }, strokeAlign: 'CENTER',
    characters: '', fontFamily: '', fontStack: 'Inter, future-font', fontSize: 0, fontWeight: 0,
    fontStyle: 'italic', lineHeight: 0, letterSpacing: -1, wordSpacing: -1,
    textAlignHorizontal: 'JUSTIFIED', textAutoResize: 'TRUNCATE', textColor: sharedColor,
    textDecoration: 'STRIKETHROUGH', textCase: 'TITLE', textTruncation: 'ENDING',
    blendMode: 'FUTURE_BLEND_MODE', rotation: -45, counterAxisAlignContent: 'SPACE_BETWEEN',
    imageUrl: 'https://example.test/image.png', svgContent: '<svg/>',
    motion: {
      steps: [{ offset: 0, style: {} }, { offset: 1, style: { opacity: '1', transform: 'none' } }],
      durationSec: 0, easing: 'future-easing',
    },
    clipsContent: false, absolutePosition: true, x: -1, y: -2,
    textSegments: [{
      characters: '', fontFamily: '', fontSize: 0, fontWeight: 0, fontStyle: 'normal',
      lineHeight: 0, letterSpacing: -1, textColor: sharedColor, textDecoration: 'UNDERLINE', textCase: 'UPPER',
    }],
    keyedBindings: { fills: { key: 'published-key', name: '' } },
    tokenRefs: { fill: 'c', stroke: 'c', textColor: 'c', radius: 'r', gap: 's', padding: 's' },
    componentKey: '', componentId: '', componentName: '', componentProperties: { State: 'On', Enabled: false },
    innerOverrides: [{
      childKey: '0/1', fields: { name: '', width: 0 }, componentKey: '', componentId: '',
      componentProperties: { State: 'Off', Enabled: true }, figmaScanFillSize: { width: 0, height: 0 },
      visual: {
        fills: [], strokes: [], effects: [], effectStyleId: '', visible: false, opacity: 0,
        keyedBindings: { fills: { key: 'inner-key', name: '' } },
      },
    }],
    figmaScanUnreproducibleInner: ['width'], figmaScanBindings: { fontSize: 'VariableID:1' },
    figmaScanSourceType: 'FUTURE_SOURCE', figmaScanInnerOverrides: ['effects'],
    figmaScanUnbindable: ['maxWidth'], children: [],
  };
}

function completePayload(rootNode = completeNode()) {
  return {
    version: 1, name: '', width: 0, height: 0,
    tokens: {
      colors: [{ name: 'c', hex: '#19334d', color: sharedColor }],
      typography: [{ name: 't', family: '', size: 0, weight: 0, lineHeight: 0, letterSpacing: -1 }],
      spacing: [{ name: 's', value: -1 }], radii: [{ name: 'r', value: 0 }],
      shadows: [{ name: 'shadow', css: '', effect: { type: 'BACKGROUND_BLUR', radius: 0 } }],
    },
    rootNode,
  };
}

describe('IMPORT_PAYLOAD complete schema', () => {
  it('accepts every current optional field, scanner extension, empty visual, alias, and token shape', () => {
    expect(validateImportPayload(completePayload()).payload).toEqual(completePayload());
  });

  it('validates every declared node field by its runtime type', () => {
    const node = completeNode();
    for (const [field, value] of Object.entries(node)) {
      const wrong = typeof value === 'number' ? 'wrong'
        : typeof value === 'string' ? 5
          : typeof value === 'boolean' ? 'wrong'
            : Array.isArray(value) ? {} : 'wrong';
      expect(
        () => validateImportPayload(completePayload({ ...node, [field]: wrong })),
        `field ${field}`,
      ).toThrow(PayloadValidationError);
    }
  });

  it('rejects every node and text-segment enum outside its declared union', () => {
    const nodeEnums = [
      'type', 'layoutMode', 'primaryAxisSizingMode', 'counterAxisSizingMode', 'primaryAxisAlignItems',
      'counterAxisAlignItems', 'layoutWrap', 'layoutSizingHorizontal', 'layoutSizingVertical', 'strokeAlign',
      'fontStyle', 'textAlignHorizontal', 'textAutoResize', 'textDecoration', 'textCase', 'textTruncation',
      'counterAxisAlignContent',
    ];
    for (const field of nodeEnums) expect(
      () => validateImportPayload(completePayload({ ...completeNode(), [field]: 'NOT_IN_UNION' })),
      `enum ${field}`,
    ).toThrow(PayloadValidationError);
    for (const field of ['fontStyle', 'textDecoration', 'textCase']) expect(() => validateImportPayload(completePayload({
      type: 'TEXT', name: 'bad', textSegments: [{ characters: 'x', [field]: 'NOT_IN_UNION' }],
    }))).toThrow(PayloadValidationError);
  });

  it('rejects malformed nested unions, records, ranges, and unknown fields', () => {
    const rejects = [
      { fills: [{ type: 'SOLID' }] },
      { fills: [{ type: 'GRADIENT_LINEAR', gradientStops: [], gradientTransform: [[1, 0, 0], [0, 1, 0]] }] },
      { fills: [{ type: 'GRADIENT_LINEAR', gradientStops: [{ color: sharedColor, position: 0 }, { color: sharedColor, position: 2 }], gradientTransform: [[1, 0, 0], [0, 1, 0]] }] },
      { fills: [{ type: 'GRADIENT_LINEAR', gradientStops: [{ color: sharedColor, position: 0 }, { color: sharedColor, position: 1 }], gradientTransform: [[1, 0, 0]] }] },
      { opacity: 2 }, { tokenRefs: { unknown: 'x' } }, { keyedBindings: { fills: { key: 5 } } },
      { innerOverrides: [{ childKey: '0', fields: {}, visual: { unknown: true } }] },
      { figmaScanBindings: { fills: 5 } }, { children: [{ type: 'FRAME', name: 'bad', unknown: true }] },
    ];
    for (const fields of rejects) expect(
      () => validateImportPayload(completePayload({ type: 'FRAME', name: 'bad', ...fields })),
    ).toThrow(PayloadValidationError);
  });

  it('normalizes each partial token group but rejects malformed present token fields', () => {
    expect(validateImportPayload({ ...completePayload(), tokens: { colors: [] } }).payload.tokens).toEqual(emptyTokens());
    expect(() => validateImportPayload({
      ...completePayload(), tokens: { colors: [{ name: 'c', hex: '#fff', color: { ...sharedColor, a: 2 } }] },
    })).toThrow(PayloadValidationError);
  });
});
