// The plugin-side wrapper around `shared/editor-surface.ts`'s pure `editorRefusal`
// (absorption phase-02, first wired here in phase-03) — reads `figma.editorType`
// DIRECTLY (never inferred, never defaulted), and is the ONE place a `ui.*` helper
// throws a wrong-editor-type refusal. Every `ui.figjam.*` helper's first line is
// `requireEditor('ui.figjam.<name>', ['figjam'])` — no hand-written refusal string
// anywhere else in this codebase.
import { editorRefusal, type EditorType } from '../../../shared/editor-surface';
import { withCode } from './executor-styles';

/**
 * Throws `E_INVALID_ARGS` naming the capability, the editor type found, the editor
 * type(s) required, and the next action, when the currently open file's editor type
 * does not satisfy `required`. `E_INVALID_ARGS` — not a new error code: the caller
 * asked for something the open file cannot do, which is an argument problem, and a
 * new `ErrorCode` is a protocol decision this phase is not authorised to make (per
 * phase-02's own spec).
 */
export function requireEditor(capability: string, required: readonly EditorType[]): void {
  const found = (figma.editorType ?? null) as EditorType;
  const message = editorRefusal({ capability, required, found });
  if (message !== null) throw withCode(new Error(message), 'E_INVALID_ARGS');
}
