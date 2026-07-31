// shared/editor-surface.ts — the one refusal-message builder for a wrong editor
// surface (absorption phase-02). Pure, no figma mock needed.
import { describe, it, expect } from 'vitest';
import { editorRefusal } from '../shared/editor-surface.ts';

describe('editorRefusal', () => {
  it('allows when the found editor type is in the required set (returns null)', () => {
    expect(editorRefusal({ capability: 'ui.slot.create', required: ['figma'], found: 'figma' })).toBeNull();
  });

  it('refuses with all four elements: capability, found, required, next action', () => {
    const msg = editorRefusal({ capability: 'ui.figjam.sticky', required: ['figjam'], found: 'figma' });
    expect(msg).not.toBeNull();
    expect(msg).toContain('ui.figjam.sticky');
    expect(msg).toContain('a Figma design file'); // found
    expect(msg).toContain('a FigJam board'); // required
    expect(msg).toMatch(/open this board in FigJam/); // next action
  });

  it('treats found:null as "unknown" — refuses and names it plainly, never a guess', () => {
    const msg = editorRefusal({ capability: 'ui.slot.create', required: ['figma'], found: null });
    expect(msg).toContain('the host did not report an editor type');
  });

  it('a multi-required capability lists every allowed type and still gives ONE next action', () => {
    const msg = editorRefusal({ capability: 'ui.thing', required: ['figma', 'dev'], found: 'figjam' });
    expect(msg).toContain('a Figma design file');
    expect(msg).toContain('Dev Mode');
    // Exactly one next-action instruction, not a menu — the first required type's.
    expect(msg?.match(/ — /g)?.length).toBe(1);
  });

  it('allows any of several required types, not only the first', () => {
    expect(editorRefusal({ capability: 'ui.thing', required: ['figma', 'dev'], found: 'dev' })).toBeNull();
  });

  it('never allows found:null even if null were (incorrectly) passed in required', () => {
    // Defensive: required should never legitimately contain null, but the guard must
    // not silently allow an unknown host just because of a caller mistake.
    const msg = editorRefusal({ capability: 'ui.thing', required: ['figma', null], found: null });
    expect(msg).not.toBeNull();
  });
});
