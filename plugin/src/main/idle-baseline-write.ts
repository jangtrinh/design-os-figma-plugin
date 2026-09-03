// The idle baseline write's control flow, lifted out of main.ts so its two load-bearing
// rules are testable without a sandbox (main.ts calls `figma.showUI` at module load, so
// nothing can import it live — the same reason boot-capture.ts exists).
//
// The two rules, each a real cost paid before:
//   · only the pages an EDIT touched are re-walked. The re-walk used to cost the whole
//     document for one frame — 21 pages walked to refresh the one that changed.
//   · the dirty set is claimed BY VALUE and cleared in the SAME synchronous step, before
//     the walk. An edit arriving while the write is in flight then re-marks its page and
//     earns its own later write, instead of being swallowed by this write clearing the set
//     after it finishes.
//
// Host-agnostic by construction: the page type is a parameter and every figma touch is a
// dependency, so this module imports nothing from the plugin API.
import { createSingleFlightWriter } from './edit-gapfill';

export interface IdleBaselineWriteDeps<P> {
  /** The set the `documentchange` capture marks. Owned by the caller (main.ts holds the
   *  session state); this module only claims and clears it. */
  dirtyPageIds: Set<string>;
  /** Read when the write RUNS, never captured at wiring time — a page created after boot
   *  must be in the list its own edit triggers. */
  pages: () => readonly P[];
  /** The write itself. Free to reject: a refusal (quota) leaves the stored baseline older,
   *  which costs the next boot some duplicate reports and never a loss. */
  write: (pages: readonly P[], dirtyPageIds: ReadonlySet<string>) => Promise<void>;
}

/**
 * Returns the idle trigger: claim the dirty pages, clear the set, write once for them.
 *
 * The write is async, so two idle fires could otherwise overlap on the same storage key.
 * `createSingleFlightWriter` runs one at a time and re-arms once for anything that arrived
 * mid-flight — a request is never dropped, and two writes never race for the same key.
 */
export function createIdleBaselineWriter<P>(deps: IdleBaselineWriteDeps<P>): () => void {
  return createSingleFlightWriter(async () => {
    const dirty = new Set(deps.dirtyPageIds);
    deps.dirtyPageIds.clear();
    if (dirty.size === 0) return; // a re-armed run whose pages were already written
    await deps.write(deps.pages(), dirty);
  });
}
