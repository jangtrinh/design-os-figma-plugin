// The one place a "wrong editor surface" refusal message is composed (absorption
// phase-02). Pure — no `figma` access — for the same reason mutating-commands.ts is
// pure: the CLI needs this too (a pre-flight refusal off `status` costs no round
// trip), and main.ts itself cannot be imported outside a live plugin sandbox.
//
// Phases 03 (FigJam) and 04 (Slides) both consume this + `STATUS.editorType` — built
// here, once, before either surface needs it (a rule patched into the first consumer
// that needed it resurfaces in the next one — this repo's own CLAUDE.md L1→L4 scar).

/** `figma.editorType`, as `STATUS` reports it. `null` when the host reports nothing —
 * NEVER defaulted to `'figma'` (the fork's own code.js:74 does that; a silent default
 * is exactly the guess this repo bans). The guard treats `null` as "unknown: refuse". */
export type EditorType = 'figma' | 'figjam' | 'slides' | 'dev' | null;

const EDITOR_LABEL: Record<Exclude<EditorType, null>, string> = {
  figma: 'a Figma design file',
  figjam: 'a FigJam board',
  slides: 'a Figma Slides deck',
  dev: 'Dev Mode',
};

const NEXT_ACTION: Record<Exclude<EditorType, null>, string> = {
  figma: 'open this file in Figma (design mode) and re-run',
  figjam: 'open this board in FigJam and re-run',
  slides: 'open this deck in Figma Slides and re-run',
  dev: 'switch to Dev Mode and re-run',
};

/**
 * Refuse (return a message) or allow (return null) a capability for the open file's
 * editor type. The message names exactly four things and nothing else: the
 * capability, the editor type found, the editor type(s) required, and the next
 * action — no hint arrays, no suggestion lists (the fork's `hints: [...]` shape,
 * slot-tools.ts:219-223, is MCP-shaped; this repo's channel is one JSON object plus a
 * stderr line, per the studio's tui-output-channel-a-b finding).
 */
export function editorRefusal(opts: {
  capability: string;
  required: readonly EditorType[];
  found: EditorType;
}): string | null {
  const { capability, required, found } = opts;
  // `found !== null` guards a caller mistake where `required` itself carries `null` —
  // an unknown host must never pass just because a capability's required-list was
  // authored sloppily. `null` never satisfies, full stop.
  if (found !== null && required.includes(found)) return null;

  const foundLabel = found === null ? 'the host did not report an editor type' : EDITOR_LABEL[found];
  const requiredLabels = required
    .filter((r): r is Exclude<EditorType, null> => r !== null)
    .map((r) => EDITOR_LABEL[r]);
  const requiredList = requiredLabels.length === 1
    ? requiredLabels[0]
    : `one of: ${requiredLabels.join(', ')}`;
  // Next action names the FIRST required type — a capability with more than one valid
  // surface still needs one concrete instruction, not a menu.
  const firstRequired = required.find((r): r is Exclude<EditorType, null> => r !== null);
  const nextAction = firstRequired ? NEXT_ACTION[firstRequired] : 'reopen the file the capability needs';

  return `${capability} needs ${requiredList}, but ${foundLabel} is open — ${nextAction}.`;
}
