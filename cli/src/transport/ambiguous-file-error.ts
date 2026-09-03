// The ONE place that knows the exact shape of the broker's "--file matched more than one
// connected file" refusal (broker-daemon.ts's ROUTE dispatch, `filter.source === 'flag' &&
// hits.length > 1`). It travels over the wire as an ordinary E_INVALID_ARGS — a dedicated
// wire error code would touch the documented contract of EVERY command that can hit this
// refusal (command-catalog.ts:346), not just `status`. `status` alone needs to tell this
// ONE E_INVALID_ARGS shape apart from a genuinely bad argument — status is a diagnosis
// tool that must never fail just because nobody can be routed to unambiguously —
// the marker below is the single source of truth the message-builder (broker-daemon.ts) and
// the predicate (status.ts) both use, so neither can drift from the other independently.
const AMBIGUOUS_FILE_MARKER = ' connected files [';

/** Built by broker-daemon.ts for the ROUTE dispatch's E_INVALID_ARGS reply. */
export function formatAmbiguousFileMessage(
  value: string,
  hits: ReadonlyArray<{ scene: { fileName?: string | null }; instanceId: string }>,
): string {
  const ids = hits.map((e) => `${e.scene.fileName ?? '(unnamed)'}#${e.instanceId}`).join(', ');
  return `--file "${value}" matches ${hits.length}${AMBIGUOUS_FILE_MARKER}${ids}] — close one panel, ` +
    `rename the files apart, or target one exactly with --instance <id> (e.g. --instance ${hits[0]!.instanceId})`;
}

/** True only for the exact E_INVALID_ARGS shape `formatAmbiguousFileMessage` builds — never
 *  a loose substring match a genuinely-bad-argument message could coincidentally contain. */
export function isAmbiguousFileErrorMessage(message: string): boolean {
  return message.includes(AMBIGUOUS_FILE_MARKER);
}
