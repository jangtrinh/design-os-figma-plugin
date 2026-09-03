// Scene-edit verb vocabulary for the owner-edit change feed (wave 4.4). Distinct from
// plugin/src/ui/activity-sentence.ts's COMMAND vocabulary — that table's `humanizeTool`
// merely lowercases a wire cmd (CREATE_FRAME → "create frame") and has no moved/renamed/
// deleted verbs at all; reusing it here would emit nonsense like "create frame Subtitle".
// This table describes what happened to a NODE ON THE CANVAS: created / renamed / moved /
// restyled / deleted. Pure, no DOM, no figma API, no fs. `shared/` is the right home
// because THREE consumers read this one table: `figma-agent changes` (phase 02), the
// distill step (phase 03), and later a panel row — that is the DRY the brief asks for;
// copying the panel's command table would not be.
import type { EditOp } from './edit-feed';

export type SceneEditVerb = 'created' | 'renamed' | 'moved' | 'restyled' | 'deleted';

const VERB_TEXT: Record<SceneEditVerb, string> = {
  created: 'Created',
  renamed: 'Renamed',
  moved: 'Moved',
  restyled: 'Restyled',
  deleted: 'Deleted',
};

/** `updated`'s changedProps that mean "moved" — position/layout, never a paint/text prop. */
const POSITION_PROPS: ReadonlySet<string> = new Set([
  'x', 'y', 'relativeTransform', 'constraints', 'layoutAlign', 'layoutGrow', 'layoutPositioning',
]);
const NAME_PROP = 'name';

/**
 * Which scene-edit verb an `updated` op's changedProps set implies. `renamed` wins if
 * `name` is present (the single clearest fact); else `moved` if any position/layout prop
 * is present; else `restyled` — the residual bucket for everything else (fills, strokes,
 * effects, text content, corner radius, etc). Never invents a verb beyond what
 * changedProps actually lists — an `updated` frame with an EMPTY changedProps (should not
 * happen upstream, but this is untrusted wire data) still resolves, honestly, to `restyled`
 * rather than throwing.
 */
function updateVerb(changedProps: readonly string[]): 'renamed' | 'moved' | 'restyled' {
  if (changedProps.includes(NAME_PROP)) return 'renamed';
  if (changedProps.some((p) => POSITION_PROPS.has(p))) return 'moved';
  return 'restyled';
}

/** Which scene-edit verb an edit's {op, changedProps} implies. */
export function sceneEditVerb(op: EditOp, changedProps: readonly string[]): SceneEditVerb {
  if (op === 'created') return 'created';
  if (op === 'deleted') return 'deleted';
  return updateVerb(changedProps);
}

/** "TEXT" → "text", "COMPONENT_SET" → "component set". Only used when a real name is
 *  available to build flowing prose around — the null-name fallback keeps the raw type. */
function humanizeType(type: string): string {
  return type.toLowerCase().replace(/_/g, ' ');
}

/** The minimal shape `editSentence` needs — a structural subset of EditFrame, so callers
 *  (the CLI command, the distill step) can pass a frame straight through. */
export interface SceneEditSentenceInput {
  op: EditOp;
  nodeName: string | null;
  nodeType: string;
  parentName: string | null;
  changedProps: readonly string[];
}

/**
 * One English sentence describing an owner/agent edit — never inventing a name or
 * location the frame did not carry:
 *   `Deleted text "Subtitle" in "Roles / Detail"`
 *   `Created frame "Hero card"`
 *   `Restyled instance "Button"`
 * A frame with a null `nodeName` (an unobserved delete — the session never saw that node,
 * so the identity cache had nothing to offer) degrades honestly to the RAW type rather
 * than fabricating one: `Deleted a TEXT node`.
 */
export function editSentence(frame: SceneEditSentenceInput): string {
  // Stage-4 fix round (minor 9c) — the gap-fill truncation notice (edit-gapfill.ts) is an
  // `op: 'updated'` frame with `changedProps: ['truncated']`; the generic verb mapping
  // above falls through to `restyled` for it (nothing in POSITION_PROPS/NAME_PROP
  // matches), producing the actively WRONG "Restyled page ...". This is a distinct kind
  // of fact (a scan hit its node cap, not an edit at all) and gets its own sentence,
  // checked BEFORE the normal verb path.
  if (frame.changedProps.includes('truncated')) {
    // States the ACTUAL, current fact rather than a speculative one ("some deletions may be
    // invisible" implies a specific past miss this session cannot actually name). That fact
    // changed when the top-level signal shipped: an oversized page is no longer skipped
    // outright, it is covered at frame level only — so "gap-fill is disabled" became a
    // WRONG fact, and a wrong fact costs more than a coarse one.
    const label = frame.nodeName ?? frame.parentName ?? 'this page';
    return `Gap-fill covers only top-level frames on "${label}" while it exceeds the scan cap`;
  }
  // The other gap-fill notice, same shape and the same reason for existing: an
  // `op: 'updated'` frame carrying `changedProps: ['baseline-missing']` is not an edit at
  // all, and the generic verb path would render it as the actively wrong "Restyled ...".
  // It states only what is known — there was no baseline for this file, so whatever was
  // edited before this session cannot be listed. It never guesses that anything WAS
  // edited.
  if (frame.changedProps.includes('baseline-missing')) {
    const label = frame.nodeName ?? 'this file';
    return `Gap-fill had no previous baseline for "${label}" — edits made before this session are unreported`;
  }
  // A baseline EXISTS for this file but the store refused to read it this boot. The plugin
  // withholds its own write so that baseline survives, and the next successful boot diffs
  // against it — so the closed-window edits are delayed, not lost. Distinct from
  // "missing": claiming there was no baseline would be a wrong fact.
  if (frame.changedProps.includes('baseline-unreadable')) {
    const label = frame.nodeName ?? 'this file';
    return `Gap-fill skipped this session — the stored baseline for "${label}" could not be read; edits made before this session will be reported on the next successful boot`;
  }
  // A page whose walk could not read every node. Those nodes are absent from the walk, so
  // gap-fill skipped that page's diff rather than reporting them — and everything under
  // them — as deleted. Same shape and the same reason for existing as the notices above:
  // it is not an edit, and the generic verb path would call it "Restyled page …". How many
  // nodes were lost is in STATUS (`gapfill.pagesWithReadErrors`, `perf.propertyReadErrors`)
  // — this sentence states only what it can name.
  if (frame.changedProps.includes('walk-errors')) {
    const label = frame.nodeName ?? 'this page';
    return `Gap-fill could not read some nodes on "${label}" this session — its diff was skipped`;
  }
  const verb = sceneEditVerb(frame.op, frame.changedProps);
  // The top-level signal on an oversized page: this frame's contents changed while the
  // plugin was closed, and nothing narrower is knowable — the page was never walked node by
  // node. The generic mapper would call it "Restyled", which claims a paint/text change
  // this session cannot see. Checked AFTER the verb so a rename or a move — facts the
  // fingerprint states exactly — still read as themselves.
  if (verb === 'restyled' && frame.changedProps.includes('subtree')) {
    const label = frame.nodeName ?? 'this frame';
    return `Contents of "${label}" changed while the plugin was closed`;
  }
  // A size change is not a style change. `updateVerb`'s residual bucket calls everything
  // that is neither a rename nor a move `restyled`, which for a pure resize claims a
  // paint/text edit that did not happen — and a resize IS one of the facts the top-level
  // fingerprint states exactly. Checked after the verb, so a rename or a move alongside it
  // still reads as itself (both are facts about this same frame, and the clearest one
  // wins, with `width`/`height` still listed in changedProps).
  const resized = verb === 'restyled' && (frame.changedProps.includes('width') || frame.changedProps.includes('height'));
  const verbText = resized ? 'Resized' : VERB_TEXT[verb];
  if (frame.nodeName === null || frame.nodeName === '') {
    const rawType = frame.nodeType || 'NODE';
    return `${verbText} a ${rawType} node`;
  }
  const typeLabel = humanizeType(frame.nodeType || 'node');
  const base = `${verbText} ${typeLabel} "${frame.nodeName}"`;
  return frame.parentName ? `${base} in "${frame.parentName}"` : base;
}
