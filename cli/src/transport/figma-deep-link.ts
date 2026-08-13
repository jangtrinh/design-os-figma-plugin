// Pure: a bind-marker entry (or its absence) → a `figma://` deep link, or an honest
// `null` + a named reason. Never fabricates a link — a URL that opens nothing is worse
// than admitting there isn't one (house rule: honest reporting). Consumed by
// `status --wait` (cli/src/commands/status.ts), which does the (impure) lookup of
// WHICH entry applies; this module only turns one entry into a URL or a reason.

/** The one field this module actually needs — a structural subset of
 *  `BindMarkerEntry` (project-bind.ts) so this stays independently testable
 *  without importing that module's fs-touching neighbors. */
export interface DeepLinkEntry {
  fileKey: string | null;
}

export interface DeepLinkResult {
  url: string | null;
  reason: string | null;
}

const NO_BINDING_REASON = 'no file bound — run `figma-agent bind --file "<name>" --dir <projectDir>`';
const NO_FILE_KEY_REASON = 'file has no fileKey (Free plan) — open the file manually';

/**
 * `entry === null` → no binding at all was found for the file in question.
 * `entry.fileKey === null` → bound, but the file has never carried an org fileKey
 * (a plugin running without enablePrivatePluginApi, or a file bound before its first connect) — a deep link cannot be
 * built for it. `entry.fileKey` a string → `figma://file/<fileKey>`.
 */
export function buildDeepLink(entry: DeepLinkEntry | null): DeepLinkResult {
  if (entry === null) return { url: null, reason: NO_BINDING_REASON };
  // `entry.fileKey` is typed `string | null`, but the value crossed a trust boundary
  // (JSON parsed from a file a user or another tool can hand-edit) before it got here —
  // an `=== null` check alone is a type-level guard on a runtime value the type cannot
  // actually promise. A missing/wrong-typed/empty fileKey must land on the SAME honest
  // "no link" answer as the documented null case, never `figma://file/undefined` or
  // `figma://file/`.
  if (typeof entry.fileKey !== 'string' || entry.fileKey === '') return { url: null, reason: NO_FILE_KEY_REASON };
  return { url: `figma://file/${entry.fileKey}`, reason: null };
}
