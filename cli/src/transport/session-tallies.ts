// Per-instance session tallies the BROKER witnesses and nobody else does:
//   · `relayDroppedFrames` — what the relay lost before it could reach any broker. The
//     plugin's panel is the only other witness and it dies with the iframe.
//   · `replayedBatches` — capture BATCHES that arrived stamped `replayed` after an outage.
//     Every edit in them is in the feed, dated to capture; what this counts is that the
//     live view was blind while they were queued. One batch travels as TWO frames (a
//     DOC_CHANGE and an EDIT_FEED), so the caller counts it on one of them only.
//
// They live HERE rather than on the registry entry on purpose. A reconnect closes the
// socket first, and the daemon deletes the registry entry before the new PLUGIN_HELLO
// arrives — a tally on that entry would be erased by exactly the event it exists to
// survive, and the relay re-reports only when it has NEW loss to declare, so nothing
// would refill it. The result would be a session that dropped frames reporting
// `coverage.complete: true`.
//
// Keyed by `instanceId`, which the relay mints once per iframe load: one key IS one
// plugin session, so a re-report replaces rather than accumulates, and a genuinely new
// session starts from nothing.

/** One instance's broker-observed coverage counts. Zero means measured-zero. */
export interface SessionTally {
  relayDroppedFrames: number;
  replayedBatches: number;
}

export interface SessionTallies {
  /** Store the SESSION total a PLUGIN_RELAY_STATS frame reported. Replaces, never adds:
   *  the frame carries the whole session's total, so summing two reports would count the
   *  first report's frames twice. A non-finite or negative number is refused — a tally
   *  nobody measured is worse than no tally. */
  recordRelayDrops(instanceId: string, sessionTotalFrames: number): void;
  /** One capture batch arrived stamped as replayed. Called on the EDIT_FEED frame only —
   *  the DOC_CHANGE frame carries the SAME batch and counting both would double it. */
  countReplayedBatch(instanceId: string): void;
  /** This instance's tally, or null when it has never had one. */
  get(instanceId: string): SessionTally | null;
}

/** Instances retained. A tally is ~2 numbers; the cap exists so a long-lived broker that
 *  sees thousands of iframe loads cannot grow this map without bound, not to save bytes. */
export const SESSION_TALLY_MAX = 128;

export function createSessionTallies(
  opts: { max?: number; onEvict?: (instanceId: string, tally: SessionTally) => void } = {},
): SessionTallies {
  const max = opts.max ?? SESSION_TALLY_MAX;
  // Insertion-ordered (Map's own guarantee) — the oldest key is the first one out.
  const tallies = new Map<string, SessionTally>();

  function entryFor(instanceId: string): SessionTally {
    const existing = tallies.get(instanceId);
    if (existing) {
      // Re-insert so this instance moves to the young end: the cap must evict the least
      // recently USED session, not the oldest created one. A window left open while
      // another reloads the plugin repeatedly is precisely the session whose losses matter,
      // and dropping its tally would hand `status` a `complete: true` it did not earn.
      tallies.delete(instanceId);
      tallies.set(instanceId, existing);
      return existing;
    }
    const fresh: SessionTally = { relayDroppedFrames: 0, replayedBatches: 0 };
    tallies.set(instanceId, fresh);
    // Eviction is a deletion of a real record: whoever asks for the evicted instance's
    // coverage would otherwise be told zero. The daemon logs it.
    while (tallies.size > max) {
      const oldest = tallies.keys().next();
      if (oldest.done) break;
      const dropped = tallies.get(oldest.value);
      tallies.delete(oldest.value);
      if (dropped) opts.onEvict?.(oldest.value, dropped);
    }
    return fresh;
  }

  return {
    recordRelayDrops(instanceId, sessionTotalFrames) {
      if (!Number.isFinite(sessionTotalFrames) || sessionTotalFrames <= 0) return;
      entryFor(instanceId).relayDroppedFrames = Math.floor(sessionTotalFrames);
    },
    countReplayedBatch(instanceId) {
      entryFor(instanceId).replayedBatches += 1;
    },
    get(instanceId) {
      return tallies.get(instanceId) ?? null;
    },
  };
}
