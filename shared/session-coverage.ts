// The session coverage statement's pure core — shared because BOTH sides build one: the
// plugin's main thread states what it knows about its own session, and the CLI appends
// the rows only the broker can see before printing them as one answer.
//
// Everything here is a total function over plain data: no clock, no globals, no host API.
// That is what lets the same code run inside the Figma sandbox (DOM-less plugin main) and
// in the CLI process.
import { COVERAGE_GAP_KINDS, type CoverageGap, type CoverageGapKind, type SessionCoverage } from './protocol.ts';

const KNOWN_KINDS: ReadonlySet<string> = new Set<string>(COVERAGE_GAP_KINDS);

/**
 * Every `see` value a row is allowed to carry: a CLI command name, or a field path on the
 * `figma-agent status` reply the row is printed in (`[]` = "each row of that list").
 * Closed so a pointer can be drift-tested against the real reply — a row aiming at a
 * field that does not exist is worse than no pointer at all.
 *
 * `--file` filters `plugins[]` and moves the full list to `pluginsAll[]`, so both spellings
 * are legal; which one a row uses depends on how `status` was called.
 */
export const COVERAGE_SEE_TARGETS = [
  'changes',
  // Rooted at the `figma-agent status` REPLY, every one of them — the plugin's own STATUS
  // blocks arrive on the reply under `plugin`, so `status.gapfill` would send a reader to
  // a key that does not exist while the broker rows' `status.plugins[]…` resolved fine.
  // One prefix, one root.
  'status.plugin.gapfill',
  'status.plugin.captureErrors',
  'status.plugin.perf',
  'status.plugins',
  'status.pluginsAll',
  'status.plugins[].relayDroppedFrames',
  'status.pluginsAll[].relayDroppedFrames',
  'status.plugins[].replayedBatches',
  'status.pluginsAll[].replayedBatches',
] as const;

/** The `see` vocabulary as a TYPE, not just a list: `coverageRow` takes this, so a typo
 *  (`status.plugin.gapFill`) or a drifted template in a row builder fails `tsc` instead of
 *  shipping a pointer that resolves to nothing. */
export type CoverageSeeTarget = typeof COVERAGE_SEE_TARGETS[number];

/**
 * One coverage row, or `null` when there is nothing to report.
 *
 * Strict on purpose — this is the WRITE side. A kind outside the closed enum is a bug in
 * the caller, and emitting it anyway would hand agents a vocabulary they cannot branch
 * on; a fractional count is a computation error, not a count of things. `count <= 0`
 * returns null rather than throwing: "this did not happen" is the normal case, and every
 * feeder is allowed to hand in its zero.
 */
export function coverageRow(
  kind: CoverageGapKind, count: number, see: CoverageSeeTarget,
): CoverageGap | null {
  if (!KNOWN_KINDS.has(kind)) throw new Error(`unknown coverage gap kind: ${String(kind)}`);
  if (!Number.isFinite(count) || !Number.isInteger(count)) {
    throw new Error(`coverage gap count must be a whole number, got ${String(count)}`);
  }
  if (count <= 0) return null;
  return { kind, count, see };
}

/**
 * Assemble the statement. `booted` is the ONLY thing that can unlock a boolean: while a
 * session's boot is still running, every count is a partial measurement, so the answer is
 * `null` (unknown) — never `true`, and never a `false` that would read as a diagnosed
 * problem when it is really an unfinished one.
 */
export function sessionCoverage(
  rows: readonly (CoverageGap | null)[], opts: { booted: boolean },
): SessionCoverage {
  const gaps = rows.filter((row): row is CoverageGap => row !== null);
  return { complete: opts.booted ? gaps.length === 0 : null, gaps };
}

/**
 * Fold the broker's own rows into what the plugin reported.
 *
 * `plugin === null` means the STATUS reply carried no coverage block at all (an older
 * plugin bundle, or a reply that never came): the broker rows still stand on their own,
 * but nobody may claim completeness on behalf of a plugin that said nothing.
 */
export function mergeCoverage(
  plugin: SessionCoverage | null, brokerRows: readonly (CoverageGap | null)[],
): SessionCoverage {
  const gaps = [...(plugin?.gaps ?? []), ...brokerRows.filter((row): row is CoverageGap => row !== null)];
  if (plugin === null || plugin.complete === null) return { complete: null, gaps };
  return { complete: plugin.complete === true && gaps.length === 0, gaps };
}

function readRow(raw: unknown): CoverageGap | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { kind, count, see } = raw as { kind?: unknown; count?: unknown; see?: unknown };
  if (typeof kind !== 'string' || !kind) return null;
  if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) return null;
  if (typeof see !== 'string') return null;
  // An UNKNOWN kind is kept verbatim: it comes from a newer plugin build than this CLI,
  // and a gap silently dropped here would make the merged answer look better than the
  // session was. Reading is deliberately more permissive than writing.
  return { kind, count: Math.floor(count), see };
}

/**
 * Read a `coverage` block off a STATUS reply — untrusted input crossing the wire from a
 * plugin build this CLI does not control.
 *
 * `null` for anything that is not a well-formed statement (absent, wrong shape, wrong
 * `complete` type): "this build could not say" is a reading; guessing is not. A block
 * whose rows are well-formed is taken as-is; a block that LOST a malformed row can no
 * longer support a `true`, so its verdict degrades to `null` rather than claiming a
 * completeness the dropped row might have contradicted.
 */
export function readSessionCoverage(raw: unknown): SessionCoverage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { complete, gaps } = raw as { complete?: unknown; gaps?: unknown };
  if (complete !== null && typeof complete !== 'boolean') return null;
  if (!Array.isArray(gaps)) return null;
  const rows = gaps.map(readRow).filter((row): row is CoverageGap => row !== null);
  const lostRows = rows.length !== gaps.length;
  return { complete: lostRows ? null : complete, gaps: rows };
}
