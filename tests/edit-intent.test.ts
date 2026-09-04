// shared/edit-intent.ts — the designer-intent block the edit feed carries alongside a
// property name. Two invariants drive every test here:
//   1. the prop list is CLOSED and is the only trigger — a feed frame gains an `intent`
//      key exactly when Figma named one of those properties as changed;
//   2. nothing vanishes silently — a capped description says it was cut, a capped
//      annotation list says how many there really were.
import { describe, it, expect } from 'vitest';
import {
  INTENT_PROPS, INTENT_TEXT_CAP, INTENT_ANNOTATION_CAP,
  capIntent, hasIntentProp, isValidEditIntent, mergeIntent, type EditIntent,
} from '../shared/edit-intent.ts';

describe('INTENT_PROPS — the closed trigger list', () => {
  it('is exactly the two property names Figma emits on a documentchange', () => {
    expect([...INTENT_PROPS].sort()).toEqual(['annotations', 'description']);
  });

  it('hasIntentProp is true for each listed prop and false for an ordinary edit', () => {
    for (const prop of INTENT_PROPS) expect(hasIntentProp([prop])).toBe(true);
    expect(hasIntentProp(['x', 'y', 'fills'])).toBe(false);
    expect(hasIntentProp([])).toBe(false);
  });

  // Figma names no `descriptionMarkdown` property on a documentchange — the markdown text
  // rides along as description's value, so it must never act as a trigger of its own.
  it('descriptionMarkdown is NOT a trigger — it is only ever a value', () => {
    expect(hasIntentProp(['descriptionMarkdown'])).toBe(false);
  });
});

describe('capIntent — a cut value says it was cut', () => {
  it('leaves a small intent untouched, with no truncation markers invented', () => {
    const intent: EditIntent = { description: 'Primary button', annotations: [{ label: 'a11y' }] };
    expect(capIntent(intent)).toEqual({ description: 'Primary button', annotations: [{ label: 'a11y' }] });
  });

  it('caps description and descriptionMarkdown and marks the frame truncated', () => {
    const long = 'x'.repeat(INTENT_TEXT_CAP + 500);
    const capped = capIntent({ description: long, descriptionMarkdown: long });
    expect(capped.description).toHaveLength(INTENT_TEXT_CAP);
    expect(capped.descriptionMarkdown).toHaveLength(INTENT_TEXT_CAP);
    expect(capped.intentTruncated).toBe(true);
  });

  it('marks truncation when only the markdown twin is over the cap', () => {
    const capped = capIntent({ description: 'short', descriptionMarkdown: 'y'.repeat(INTENT_TEXT_CAP + 1) });
    expect(capped.description).toBe('short');
    expect(capped.intentTruncated).toBe(true);
  });

  it('caps the annotation list and keeps the real total', () => {
    const many = Array.from({ length: INTENT_ANNOTATION_CAP + 7 }, (_, i) => ({ label: `a${i}` }));
    const capped = capIntent({ annotations: many });
    expect(capped.annotations).toHaveLength(INTENT_ANNOTATION_CAP);
    expect(capped.annotationsTotal).toBe(INTENT_ANNOTATION_CAP + 7);
    expect(capped.intentTruncated).toBeUndefined(); // the text cap's marker, not this one's
  });

  it('omits annotationsTotal when the list is complete — its presence MEANS partial', () => {
    expect(capIntent({ annotations: [{ label: 'one' }] }).annotationsTotal).toBeUndefined();
  });

  it('omits annotationsTotal at exactly the cap — a full list is not a cut one', () => {
    const exact = Array.from({ length: INTENT_ANNOTATION_CAP }, (_, i) => ({ label: `a${i}` }));
    const capped = capIntent({ annotations: exact });
    expect(capped.annotations).toHaveLength(INTENT_ANNOTATION_CAP);
    expect(capped.annotationsTotal).toBeUndefined();
  });

  it('an empty annotation list survives — the designer cleared them and that is the value', () => {
    expect(capIntent({ annotations: [] }).annotations).toEqual([]);
  });
});

describe('isValidEditIntent — untrusted wire input', () => {
  it('accepts every field shape the capture can produce', () => {
    expect(isValidEditIntent({})).toBe(true);
    expect(isValidEditIntent({ description: 'hi', descriptionMarkdown: '**hi**' })).toBe(true);
    expect(isValidEditIntent({ annotations: [{ label: 'a' }], annotationsTotal: 40 })).toBe(true);
    expect(isValidEditIntent({ intentTruncated: true })).toBe(true);
    expect(isValidEditIntent({ intentReadError: 'refused' })).toBe(true);
  });

  it('rejects null, non-objects and arrays', () => {
    expect(isValidEditIntent(null)).toBe(false);
    expect(isValidEditIntent('description')).toBe(false);
    expect(isValidEditIntent([])).toBe(false);
  });

  it('rejects a non-string description or markdown', () => {
    expect(isValidEditIntent({ description: 7 })).toBe(false);
    expect(isValidEditIntent({ descriptionMarkdown: {} })).toBe(false);
  });

  it('rejects annotations that are not a list of objects', () => {
    expect(isValidEditIntent({ annotations: 'one' })).toBe(false);
    expect(isValidEditIntent({ annotations: ['one'] })).toBe(false);
    expect(isValidEditIntent({ annotations: [null] })).toBe(false);
  });

  it('rejects a non-finite annotationsTotal and a non-true truncation marker', () => {
    expect(isValidEditIntent({ annotationsTotal: 'many' })).toBe(false);
    expect(isValidEditIntent({ annotationsTotal: Number.NaN })).toBe(false);
    expect(isValidEditIntent({ intentTruncated: false })).toBe(false);
  });

  it('rejects a non-string read error — a refusal is reported verbatim or not at all', () => {
    expect(isValidEditIntent({ intentReadError: 500 })).toBe(false);
  });
});

describe('capIntent — annotation TEXT is bounded too, not just the list length', () => {
  it('caps a label and its markdown twin at the same character cap', () => {
    const long = 'x'.repeat(50_000);
    const capped = capIntent({ annotations: [{ label: long, labelMarkdown: long, categoryId: 'a11y' }] });
    const entry = capped.annotations![0]!;
    expect(entry['label']).toHaveLength(INTENT_TEXT_CAP);
    expect(entry['labelMarkdown']).toHaveLength(INTENT_TEXT_CAP);
    expect(entry['categoryId']).toBe('a11y'); // a short field is untouched
    expect(capped.intentTruncated).toBe(true);
  });

  it('holds a 50 000-character label to a frame a feed can carry', () => {
    const capped = capIntent({ annotations: [{ label: 'x'.repeat(50_000), labelMarkdown: 'y'.repeat(50_000) }] });
    expect(JSON.stringify(capped).length).toBeLessThan(4_600);
  });

  it('does not mutate the caller\'s annotation objects', () => {
    const entry = { label: 'z'.repeat(INTENT_TEXT_CAP + 1) };
    capIntent({ annotations: [entry] });
    expect(entry.label).toHaveLength(INTENT_TEXT_CAP + 1);
  });

  it('keeps a read refusal through the cap — a capped block still reports it', () => {
    expect(capIntent({ intentReadError: 'description: refused' }))
      .toEqual({ intentReadError: 'description: refused' });
  });
});

describe('mergeIntent — a count never outlives the list it counted', () => {
  it('drops a stale annotationsTotal when the later read carried a complete list', () => {
    const merged = mergeIntent(
      { annotations: [{ label: 'a' }], annotationsTotal: 31 },
      { annotations: [{ label: 'b' }, { label: 'c' }] },
    );
    expect(merged).toEqual({ annotations: [{ label: 'b' }, { label: 'c' }] });
  });

  it('keeps the later read\'s OWN total when that list is the partial one', () => {
    const merged = mergeIntent(
      { annotations: [{ label: 'a' }] },
      { annotations: [{ label: 'b' }], annotationsTotal: 44 },
    );
    expect(merged.annotationsTotal).toBe(44);
  });

  it('leaves an untouched annotation block alone when the later read names another field', () => {
    const merged = mergeIntent(
      { annotations: [{ label: 'a' }], annotationsTotal: 31 },
      { description: 'words' },
    );
    expect(merged).toEqual({ annotations: [{ label: 'a' }], annotationsTotal: 31, description: 'words' });
  });
});

// `annotationsTotal` is not an independent number: it exists ONLY because the list beside it
// was cut. A block whose count contradicts its own list is not a coarse fact, it is a wrong
// one — and this guard is the last place that can tell.
describe('isValidEditIntent — the count must be consistent with the list it cut', () => {
  it('accepts a real cut', () => {
    expect(isValidEditIntent({ annotations: [{ label: 'a' }], annotationsTotal: 25 })).toBe(true);
  });

  it('refuses a total that is not bigger than the list it claims to have cut', () => {
    expect(isValidEditIntent({ annotations: [{ label: 'a' }, { label: 'b' }], annotationsTotal: 0 })).toBe(false);
    expect(isValidEditIntent({ annotations: [{ label: 'a' }], annotationsTotal: 1 })).toBe(false);
  });

  it('refuses a fractional or negative total — a count of annotations is a whole number', () => {
    expect(isValidEditIntent({ annotations: [{ label: 'a' }], annotationsTotal: -3.5 })).toBe(false);
    expect(isValidEditIntent({ annotations: [{ label: 'a' }], annotationsTotal: 2.5 })).toBe(false);
  });

  it('refuses a total with no list at all — there is nothing for it to be the total OF', () => {
    expect(isValidEditIntent({ annotationsTotal: 25 })).toBe(false);
  });
});

describe('capIntent — a producer\'s own total outranks a recount', () => {
  it('keeps a total the block already carried instead of recounting from a shorter list', () => {
    const many = Array.from({ length: INTENT_ANNOTATION_CAP + 5 }, (_, i) => ({ label: `a${i}` }));
    const capped = capIntent({ annotations: many, annotationsTotal: 100 });
    expect(capped.annotations).toHaveLength(INTENT_ANNOTATION_CAP);
    expect(capped.annotationsTotal).toBe(100); // never re-derived down to 25
  });

  it('is idempotent — capping an already-capped block changes nothing', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ label: `a${i}` }));
    const once = capIntent({ annotations: many, description: 'x'.repeat(INTENT_TEXT_CAP + 3) });
    expect(capIntent(once)).toEqual(once);
    expect(once.annotationsTotal).toBe(40);
  });
});
