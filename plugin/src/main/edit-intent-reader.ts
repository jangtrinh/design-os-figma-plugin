// Reads what the designer SAID, at the only moment it is readable.
//
// Figma's `documentchange` names the property that changed (`description`, `annotations`)
// and never the new value. Nothing recovers it afterwards: the component-scoped change log
// stores property NAMES, and REST answers `description: ""` at every version. So this read
// happens inside the capture pass or it never happens at all.
//
// The field shapes come from the context readers (context-intent-readers.ts) — the same
// eyes `figma-agent context` uses, so the feed and a context call can never describe the
// same annotation differently. What this module adds is the three things a live capture
// needs and a context scan does not:
//   1. a REFUSAL that survives as a refusal (a context record drops a refused field and
//      moves on; here a swallowed refusal would read as "the designer cleared it");
//   2. an EMPTY value that survives as a value — clearing a description is an edit;
//   3. a cap, applied before the value crosses the wire.
// Each getter is read ONCE and under its OWN try, so one refusing field never costs another
// field that answered.
import { distinctMarkdown, shapeAnnotations } from './context-intent-readers';
import { messageOf } from './context-node-record';
import { capIntent, hasIntentProp, type EditIntent } from '../../../shared/edit-intent';

/** Kept in step with `INTENT_PROPS` by tests in both directions: the vocabulary must have a
 *  verb for each name, and the capture pass must actually read each one. */
const DESCRIPTION_PROP = 'description';
const MARKDOWN_FIELD = 'descriptionMarkdown';
const ANNOTATIONS_PROP = 'annotations';

/** A refusal names the FIELD it refused, so a reader of the feed knows which value is
 *  missing rather than only that something was. */
const refusal = (field: string, err: unknown): string => `${field}: ${messageOf(err)}`;

/**
 * The new value behind an intent property change, or `undefined` when there is nothing
 * honest to say (the batch named no intent prop, or this node type holds no such value).
 *
 * Never throws: the whole point is that bookkeeping about an edit must not cost the edit,
 * and this runs inside the `documentchange` pass.
 */
export function readEditIntent(
  node: Record<string, unknown>, changedProps: readonly string[],
): EditIntent | undefined {
  if (!hasIntentProp(changedProps)) return undefined;
  const intent: EditIntent = {};
  let readError: string | undefined;
  /** The FIRST refusal, verbatim — the one describing the cause rather than a cascade. */
  const note = (message: string): void => { if (readError === undefined) readError = message; };

  if (changedProps.includes(DESCRIPTION_PROP)) {
    // Read UNGUARDED by `safe()`, on purpose: `readComponentIntent` wraps every field, which
    // is right for a context scan (one refused field must not cost the record) and wrong
    // here. An EMPTY string is kept — that is the designer deleting their own words, and
    // dropping it would make a clearing indistinguishable from a refusal.
    let description: string | undefined;
    try {
      const raw = node[DESCRIPTION_PROP];
      if (typeof raw === 'string') { description = raw; intent.description = raw; }
    } catch (err) { note(refusal(DESCRIPTION_PROP, err)); }
    // Its own try: a component whose markdown getter refuses still has a description worth
    // carrying, and the earlier read already succeeded.
    try {
      const raw = node[MARKDOWN_FIELD];
      // Only when it says something the plain description does not — the same rule, from the
      // same function, that `figma-agent context` applies.
      const distinct = typeof raw === 'string' ? distinctMarkdown(raw, description ?? '') : undefined;
      if (distinct !== undefined) intent.descriptionMarkdown = distinct;
    } catch (err) { note(refusal(MARKDOWN_FIELD, err)); }
  }

  if (changedProps.includes(ANNOTATIONS_PROP)) {
    try {
      const raw = node[ANNOTATIONS_PROP];
      // An empty list is a VALUE — the designer removed the annotations. A node type with no
      // annotations FIELD is not the same statement and gets no key at all: it never held
      // any, so "cleared" would be a claim stronger than the evidence.
      if (Array.isArray(raw)) intent.annotations = shapeAnnotations(raw);
    } catch (err) { note(refusal(ANNOTATIONS_PROP, err)); }
  }

  if (readError !== undefined) intent.intentReadError = readError;
  return Object.keys(intent).length > 0 ? capIntent(intent) : undefined;
}
