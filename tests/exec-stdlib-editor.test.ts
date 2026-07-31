// `requireEditor` — the plugin-side wrapper around shared/editor-surface.ts's pure
// `editorRefusal`, first wired in absorption phase-03 (FigJam).
import { describe, it, expect } from 'vitest';
import { installMockFigma, setMockEditorType } from './helpers/mock-figma.ts';
import { requireEditor } from '../plugin/src/main/exec-stdlib-editor.ts';

describe('requireEditor', () => {
  it('allows a capability when figma.editorType satisfies the requirement', () => {
    installMockFigma();
    setMockEditorType('figjam');
    expect(() => requireEditor('ui.figjam.sticky', ['figjam'])).not.toThrow();
  });

  it('refuses with E_INVALID_ARGS naming capability, found, required, and next action', () => {
    installMockFigma();
    setMockEditorType('figma');
    try {
      requireEditor('ui.figjam.sticky', ['figjam']);
      expect.fail('expected requireEditor to throw');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('E_INVALID_ARGS');
      const message = (err as Error).message;
      expect(message).toContain('ui.figjam.sticky');
      expect(message).toContain('FigJam');
      expect(message).toContain('Figma');
    }
  });

  it('reads figma.editorType DIRECTLY — null never satisfies any requirement', () => {
    installMockFigma();
    setMockEditorType(null);
    expect(() => requireEditor('ui.figjam.sticky', ['figjam'])).toThrow(/did not report/);
  });
});
