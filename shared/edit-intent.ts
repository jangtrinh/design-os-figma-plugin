// Designer INTENT in the owner-edit feed — the words a designer attaches to a node
// (a component's description, a node's annotations), carried as the NEW VALUE next to the
// property name the feed already lists.
//
// Why a closed prop list rather than "read whatever changed": a live probe on the owner's
// file set description, descriptionMarkdown, annotations, devStatus and documentationLinks
// on one COMPONENT inside a single undo group, and the coalesced `documentchange` named
// exactly two properties — `description` and `annotations`. Figma emits NO property name
// for `descriptionMarkdown` (it folds into `description`), for `devStatus`, or for
// `documentationLinks`. So `descriptionMarkdown` is read as an extra VALUE when
// `description` changed, and the other two are not reachable from this event at all —
// `figma-agent context` already reports their current value.
//
// Pure: no fs, no figma API, no DOM, no network. The plugin's reader
// (plugin/src/main/edit-intent-reader.ts) does the host reads and calls `capIntent`; the
// broker's `buildEditFrame` and the CLI's reader validate with `isValidEditIntent`.

/**
 * The ONLY `changedProps` names that make a frame carry `intent`. Closed on purpose: a
 * name that never appears on a `documentchange` cannot trigger a read, and a read this
 * list did not ask for would be a value nobody can tie to an event.
 */
export const INTENT_PROPS: readonly string[] = ['description', 'annotations'];

/** Per-text-field character cap. A designer's description is prose, not a payload; past
 *  this the feed keeps the head and SAYS it was cut (`intentTruncated`). */
export const INTENT_TEXT_CAP = 2_000;

/** Per-frame annotation cap. Past this the feed keeps the first N and states the real
 *  count (`annotationsTotal`), so a dropped entry always leaves a number behind. */
export const INTENT_ANNOTATION_CAP = 20;

/**
 * What the designer said, at capture time. Every field is present-only-when-known:
 * a missing `description` means the read produced nothing, NOT an empty description, and
 * an `annotations: []` means the designer cleared them — a fact this feed exists to carry.
 */
export interface EditIntent {
  description?: string;
  /** Only when it says something `description` does not (the P2 reader's own rule —
   *  Figma populates both on read). */
  descriptionMarkdown?: string;
  /** The annotation shape `figma-agent context` already emits, capped. */
  annotations?: Record<string, unknown>[];
  /** Present ONLY when `annotations` above is partial — its presence IS the "there were
   *  more than you can see here" signal, so a complete list never carries it. */
  annotationsTotal?: number;
  /** Present (and only ever `true`) when a text field was cut at `INTENT_TEXT_CAP`. */
  intentTruncated?: true;
  /** The FIRST read refusal's message, verbatim. The property name stays in
   *  `changedProps` — that the designer edited it is still a fact — while the value is
   *  absent, because a refused read must never read as "the designer cleared it". */
  intentReadError?: string;
}

/** Does this changed-property set name something the designer SAID? */
export function hasIntentProp(changedProps: readonly string[]): boolean {
  return changedProps.some((p) => INTENT_PROPS.includes(p));
}

function capText(value: string | undefined): { text?: string; cut: boolean } {
  if (value === undefined) return { cut: false };
  if (value.length <= INTENT_TEXT_CAP) return { text: value, cut: false };
  return { text: value.slice(0, INTENT_TEXT_CAP), cut: true };
}

/** The annotation fields that hold a designer's PROSE, and are therefore unbounded at the
 *  source. Capping the list length alone left a single 50 000-character label free to make
 *  a megabyte-sized frame, which is exactly the kind of silent growth this cap exists to
 *  stop. The structural fields (`categoryId`, `properties`) are Figma's own short enums. */
const ANNOTATION_TEXT_FIELDS = ['label', 'labelMarkdown'] as const;

/** One annotation with its prose bounded. Returns a NEW object — a caller's array of live
 *  annotation records is never rewritten under it. */
function capAnnotation(entry: Record<string, unknown>): { entry: Record<string, unknown>; cut: boolean } {
  let cut = false;
  let out = entry;
  for (const field of ANNOTATION_TEXT_FIELDS) {
    const value = entry[field];
    if (typeof value !== 'string' || value.length <= INTENT_TEXT_CAP) continue;
    out = { ...out, [field]: value.slice(0, INTENT_TEXT_CAP) };
    cut = true;
  }
  return { entry: out, cut };
}

/**
 * Bound one intent block to the caps above (pure, returns a new object). Every cut leaves a
 * counter or a marker behind — a truncated description is not silently a shorter
 * description, 40 annotations reported as 20 would be a wrong fact rather than a coarse
 * one, and a truncated LABEL says so through the same `intentTruncated` marker as the
 * description does.
 */
export function capIntent(intent: EditIntent): EditIntent {
  const description = capText(intent.description);
  const markdown = capText(intent.descriptionMarkdown);
  let truncated = description.cut || markdown.cut;
  const list = intent.annotations;
  let annotations: Record<string, unknown>[] | undefined;
  let total: number | undefined;
  if (Array.isArray(list)) {
    if (list.length > INTENT_ANNOTATION_CAP) total = list.length;
    annotations = list.slice(0, INTENT_ANNOTATION_CAP).map((entry) => {
      const capped = capAnnotation(entry);
      if (capped.cut) truncated = true;
      return capped.entry;
    });
  }
  return {
    ...intent,
    ...(description.text !== undefined && { description: description.text }),
    ...(markdown.text !== undefined && { descriptionMarkdown: markdown.text }),
    ...(annotations !== undefined && { annotations }),
    ...(total !== undefined && { annotationsTotal: total }),
    ...(truncated && { intentTruncated: true as const }),
  };
}

/**
 * Structural guard for untrusted wire input — same strictness as `isValidEditInput`'s
 * per-element `changedProps` check, and for the same reason: this block is the one part of
 * the frame that quotes a human being, so a field it cannot vouch for is not admitted.
 * An EMPTY block is structurally valid (it says nothing, which is not the same as being
 * malformed) — the capture never builds one, and rejecting it would cost the whole frame,
 * i.e. the edit itself.
 */
export function isValidEditIntent(v: unknown): v is EditIntent {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  if (r.description !== undefined && typeof r.description !== 'string') return false;
  if (r.descriptionMarkdown !== undefined && typeof r.descriptionMarkdown !== 'string') return false;
  if (r.annotations !== undefined) {
    if (!Array.isArray(r.annotations)) return false;
    if (!r.annotations.every((a) => a !== null && typeof a === 'object' && !Array.isArray(a))) return false;
  }
  if (r.annotationsTotal !== undefined
    && (typeof r.annotationsTotal !== 'number' || !Number.isFinite(r.annotationsTotal))) return false;
  if (r.intentTruncated !== undefined && r.intentTruncated !== true) return false;
  if (r.intentReadError !== undefined && typeof r.intentReadError !== 'string') return false;
  return true;
}

/**
 * Merge two intent blocks for the SAME node in one batch — the LAST value wins field by
 * field (the same rule `coalesceEdits` applies to `op`). A field the later read did not
 * carry keeps the earlier one, including `intentReadError`: a refusal that happened during
 * this batch stays reported even when a later read of another field succeeded.
 */
export function mergeIntent(prev: EditIntent | undefined, next: EditIntent): EditIntent {
  if (prev === undefined) return next;
  const merged: EditIntent = { ...prev, ...next };
  // `annotationsTotal` and `annotations` are ONE fact, not two fields: the count describes
  // the list it was cut from. A later read that carried a complete list therefore takes the
  // count away with it, or the frame would pair a fresh two-entry list with a stale "31".
  if (next.annotations !== undefined && next.annotationsTotal === undefined) delete merged.annotationsTotal;
  return merged;
}
