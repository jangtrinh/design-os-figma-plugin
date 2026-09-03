// The broker's own rows for the session coverage statement — the three facts a plugin
// cannot state about itself, turned into the same {kind, count, see} shape its main
// thread already produces (shared/session-coverage.ts does the folding).
//
// Pure: it reads the `plugins[]` rows a BROKER_HELLO already carried and nothing else.
import type { CoverageGap } from '../../../shared/protocol.ts';
import { coverageRow } from '../../../shared/session-coverage.ts';

/** Which list on the `status` reply actually holds the rows these counts came from.
 *  `--file` filters `plugins[]` and moves the full list to `pluginsAll[]`, so a row that
 *  pointed at `plugins` there would send the reader to a list its number is not in. */
export type PluginsField = 'plugins' | 'pluginsAll';

export interface BrokerCoverageInput {
  /** The `plugins[]` rows for the file this `status` call is about (the active file's
   *  connected sessions). Two windows open on ONE file are two sessions writing to the
   *  SAME per-file feed, so their losses are disjoint holes in one history and add up;
   *  attributing them to a single instance would be a guess about which window lost what,
   *  and dropping either would understate the hole. */
  fileRows: readonly { relayDroppedFrames?: number; replayedBatches?: number }[];
  /** How many DISTINCT other files are connected — not how many sessions: two windows on
   *  one other file are one other file whose edits are missing from this view. */
  otherFiles: number;
  pluginsField: PluginsField;
}

const sum = (
  rows: BrokerCoverageInput['fileRows'], field: 'relayDroppedFrames' | 'replayedBatches',
): number => rows.reduce((total, row) => total + (row[field] ?? 0), 0);

/**
 * Build the broker-side rows. Each is `null` when its count is zero, so the caller can
 * hand the whole list to `mergeCoverage` unfiltered. Every `see` points at a field on the
 * SAME reply the row is printed in — the counts already ride `plugins[]`/`pluginsAll[]`.
 */
export function brokerCoverageRows(
  { fileRows, otherFiles, pluginsField }: BrokerCoverageInput,
): (CoverageGap | null)[] {
  return [
    // The frames themselves are gone; this count is all that records them.
    coverageRow(
      'relay-dropped-frames', sum(fileRows, 'relayDroppedFrames'), `status.${pluginsField}[].relayDroppedFrames`,
    ),
    // These edits ARE in the feed, dated to capture; what the session could not account
    // for is the window while they were still buffered.
    coverageRow(
      'replayed-batches', sum(fileRows, 'replayedBatches'), `status.${pluginsField}[].replayedBatches`,
    ),
    coverageRow('other-files-connected', otherFiles, `status.${pluginsField}`),
  ];
}
