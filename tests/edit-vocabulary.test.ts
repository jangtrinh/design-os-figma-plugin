// shared/edit-vocabulary.ts — scene-edit verbs, distinct from activity-sentence.ts's
// command vocabulary. One case per verb, the null-name honesty degrade, and the
// parentName-present/absent branch.
import { describe, it, expect } from 'vitest';
import { editSentence, sceneEditVerb, type SceneEditSentenceInput } from '../shared/edit-vocabulary.ts';

const base = (over: Partial<SceneEditSentenceInput> = {}): SceneEditSentenceInput => ({
  op: 'updated',
  nodeName: 'Hero card',
  nodeType: 'FRAME',
  parentName: null,
  changedProps: [],
  ...over,
});

describe('sceneEditVerb', () => {
  it('created → created, deleted → deleted, regardless of changedProps', () => {
    expect(sceneEditVerb('created', [])).toBe('created');
    expect(sceneEditVerb('deleted', ['fills'])).toBe('deleted');
  });

  it('updated with `name` in changedProps → renamed, even alongside other props', () => {
    expect(sceneEditVerb('updated', ['name'])).toBe('renamed');
    expect(sceneEditVerb('updated', ['fills', 'name', 'x'])).toBe('renamed');
  });

  it('updated with a position/layout prop (no name) → moved', () => {
    expect(sceneEditVerb('updated', ['x'])).toBe('moved');
    expect(sceneEditVerb('updated', ['relativeTransform'])).toBe('moved');
    expect(sceneEditVerb('updated', ['constraints'])).toBe('moved');
  });

  it('updated with neither name nor position → restyled (the residual bucket)', () => {
    expect(sceneEditVerb('updated', ['fills'])).toBe('restyled');
    expect(sceneEditVerb('updated', ['characters'])).toBe('restyled');
  });

  it('updated with an empty changedProps still resolves honestly (restyled), never throws', () => {
    expect(sceneEditVerb('updated', [])).toBe('restyled');
  });

  it('rename wins over move when both name and a position prop are present', () => {
    expect(sceneEditVerb('updated', ['x', 'name'])).toBe('renamed');
  });
});

describe('editSentence', () => {
  it('matches the spec A1 example verbatim: a delete with a known name + parent', () => {
    expect(editSentence({
      op: 'deleted', nodeName: 'Subtitle', nodeType: 'TEXT', parentName: 'Roles / Detail', changedProps: [],
    })).toBe('Deleted text "Subtitle" in "Roles / Detail"');
  });

  it('created, no parent', () => {
    expect(editSentence(base({ op: 'created', nodeName: 'Hero card', nodeType: 'FRAME', parentName: null })))
      .toBe('Created frame "Hero card"');
  });

  it('restyled, no parent', () => {
    expect(editSentence(base({ op: 'updated', nodeName: 'Button', nodeType: 'INSTANCE', changedProps: ['fills'] })))
      .toBe('Restyled instance "Button"');
  });

  it('moved, with a parent', () => {
    expect(editSentence(base({
      op: 'updated', nodeName: 'CTA', nodeType: 'FRAME', changedProps: ['x', 'y'], parentName: 'Screen 1',
    }))).toBe('Moved frame "CTA" in "Screen 1"');
  });

  it('renamed', () => {
    expect(editSentence(base({ op: 'updated', nodeName: 'New Name', nodeType: 'FRAME', changedProps: ['name'] })))
      .toBe('Renamed frame "New Name"');
  });

  it('degrades honestly to the raw type when nodeName is null — never invents one', () => {
    expect(editSentence({ op: 'deleted', nodeName: null, nodeType: 'TEXT', parentName: null, changedProps: [] }))
      .toBe('Deleted a TEXT node');
  });

  it('degrades honestly when nodeName is an empty string too', () => {
    expect(editSentence(base({ nodeName: '', nodeType: 'FRAME' }))).toBe('Restyled a FRAME node');
  });

  it('an empty parentName is treated as absent (no "in ..." clause)', () => {
    expect(editSentence(base({ parentName: '' }))).toBe('Restyled frame "Hero card"');
  });

  it('humanizes a multi-word type: COMPONENT_SET → "component set"', () => {
    expect(editSentence(base({ nodeType: 'COMPONENT_SET', changedProps: ['name'], op: 'updated' })))
      .toBe('Renamed component set "Hero card"');
  });

  // Stage-4 fix round (minor 9c) — the gap-fill truncation notice must never render as
  // "Restyled page ..." (the generic verb mapper's fallback for an unrecognized prop).
  describe('the gap-fill truncation notice gets its OWN sentence, never "Restyled"', () => {
    it('changedProps ["truncated"] never falls through to the generic restyled verb', () => {
      const sentence = editSentence(base({ nodeType: 'PAGE', changedProps: ['truncated'], op: 'updated' }));
      expect(sentence).not.toContain('Restyled');
      // States the ACTUAL current fact, never a speculative "some deletions may be
      // invisible". That fact CHANGED when the top-level signal shipped: gap-fill is no
      // longer off for an oversized page, it is top-level only — and "disabled" would now
      // be a wrong fact, which costs more than a vague one.
      expect(sentence).not.toContain('disabled');
      expect(sentence).toContain('top-level');
      expect(sentence).toContain('scan cap');
    });

    it('names the page via nodeName when present', () => {
      const sentence = editSentence(base({ nodeName: 'Screens', nodeType: 'PAGE', changedProps: ['truncated'], op: 'updated' }));
      expect(sentence).toContain('"Screens"');
    });
  });

  // The other gap-fill notice: no baseline existed for this file, so a whole session's
  // closed-window edits are unreported. Same "not an edit at all" problem as the
  // truncation notice — the generic verb mapper would render it as "Restyled".
  describe('the gap-fill baseline-missing notice gets its OWN sentence, never "Restyled"', () => {
    it('changedProps ["baseline-missing"] never falls through to the generic restyled verb', () => {
      const sentence = editSentence(base({ nodeName: 'VSF - PCP', nodeType: 'DOCUMENT', changedProps: ['baseline-missing'], op: 'updated' }));
      expect(sentence).not.toContain('Restyled');
      expect(sentence).toContain('no previous baseline');
      expect(sentence).toContain('"VSF - PCP"');
    });

    it('a frame with no file name degrades to "this file" rather than inventing one', () => {
      const sentence = editSentence(base({ nodeName: null, nodeType: 'DOCUMENT', changedProps: ['baseline-missing'], op: 'updated' }));
      expect(sentence).toContain('"this file"');
    });

    // A baseline that EXISTS but could not be read is a different fact from one that never
    // existed: the sentence must say "could not be read", never "no previous baseline".
    it('changedProps ["baseline-unreadable"] says the baseline could not be read, not that it was missing', () => {
      const sentence = editSentence(base({ nodeName: 'VSF - PCP', nodeType: 'DOCUMENT', changedProps: ['baseline-unreadable'], op: 'updated' }));
      expect(sentence).not.toContain('Restyled');
      expect(sentence).not.toContain('no previous baseline');
      expect(sentence).toContain('could not be read');
      expect(sentence).toContain('"VSF - PCP"');
    });
  });
});

// A page whose walk could not read every node. Not an edit at all — the generic verb path
// would render it as the actively wrong "Restyled page".
describe('the skipped-diff notice gets its OWN sentence', () => {
  const notice = (over: Partial<SceneEditSentenceInput> = {}): SceneEditSentenceInput => ({
    op: 'updated', nodeName: 'Screens', nodeType: 'PAGE', parentName: null,
    changedProps: ['walk-errors'], ...over,
  });

  it('names the page and says the diff was skipped, never claiming an edit happened', () => {
    const sentence = editSentence(notice());
    expect(sentence).not.toContain('Restyled');
    expect(sentence).toContain('"Screens"');
    expect(sentence).toContain('skipped');
  });

  it('degrades to a page-less phrasing rather than inventing a name', () => {
    expect(editSentence(notice({ nodeName: null }))).toContain('this page');
  });
});

describe('a size change reads as a resize, not as a restyle', () => {
  it('width and/or height alone → Resized', () => {
    const base: SceneEditSentenceInput = {
      op: 'updated', nodeName: 'Hero', nodeType: 'FRAME', parentName: null, changedProps: ['width'],
    };
    expect(editSentence(base)).toBe('Resized frame "Hero"');
    expect(editSentence({ ...base, changedProps: ['width', 'height'] })).toBe('Resized frame "Hero"');
  });

  it('a rename or a move alongside it still wins — the clearest fact about the frame', () => {
    const base: SceneEditSentenceInput = {
      op: 'updated', nodeName: 'Hero', nodeType: 'FRAME', parentName: null, changedProps: ['name', 'width'],
    };
    expect(editSentence(base)).toContain('Renamed');
    expect(editSentence({ ...base, changedProps: ['width', 'x'] })).toContain('Moved');
  });

  it('an unnamed node degrades to its raw type, same as every other verb', () => {
    expect(editSentence({
      op: 'updated', nodeName: null, nodeType: 'FRAME', parentName: null, changedProps: ['height'],
    })).toBe('Resized a FRAME node');
  });
});

// The top-level signal's own category. A page over the scan cap gets no per-node diff, so
// "something changed inside this frame" is the most this session can honestly say — and
// the generic verb mapper would render it as the actively wrong "Restyled frame".
describe('the top-level subtree signal gets its OWN sentence', () => {
  const base = (over: Partial<SceneEditSentenceInput> = {}): SceneEditSentenceInput => ({
    op: 'updated', nodeName: 'Hero', nodeType: 'FRAME', parentName: null, changedProps: ['subtree'], ...over,
  });

  it('names the frame and says WHEN, without claiming which node changed', () => {
    const sentence = editSentence(base());
    expect(sentence).not.toContain('Restyled');
    expect(sentence).toContain('"Hero"');
    expect(sentence).toContain('Contents');
    expect(sentence).toContain('plugin was closed');
  });

  it('a rename alongside it still reads as a rename — the clearest fact wins', () => {
    expect(editSentence(base({ changedProps: ['name', 'subtree'] }))).toContain('Renamed');
  });

  it('a move alongside it still reads as a move', () => {
    expect(editSentence(base({ changedProps: ['subtree', 'x', 'y'] }))).toContain('Moved');
  });
});
