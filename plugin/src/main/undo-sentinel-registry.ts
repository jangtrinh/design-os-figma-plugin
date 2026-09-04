// Tracks the undo-sentinel node ids executor-exec-js.ts's `figmaUndoBracket` creates, so
// document-change-capture.ts can recognize the sentinel's OWN CREATE/DELETE lifecycle and
// drop it from the edit feed — by ID, never by NAME, so a user frame that happens to share
// SENTINEL_NAME is never mistaken for the plugin's own bookkeeping node.
//
// Release is deliberately LAZY — there is no `releaseSentinel`. The sentinel's `remove()`
// call (`figmaUndoBracket.commit()`) runs synchronously, but the DELETE it causes arrives
// back through `documentchange` in a LATER, asynchronously batched task with no call site
// that could say "this id's own delete has now been filtered, forget it" — releasing at
// `remove()` time would unregister the id BEFORE the very delete it exists to catch.
//
// So membership only grows, capped to a bounded FIFO (last MAX_TRACKED ids, oldest evicted
// first): one exec-js `--undo-group` run registers exactly one id, and `begin()` also sweeps
// any stray sentinel from a PRIOR run before creating a new one, so an id surviving long
// enough to be evicted here would already have been reclaimed there. Reaching the eviction
// requires MAX_TRACKED more runs to complete, on the SAME open plugin session, before an
// old id's delete is delivered — `documentchange` only fires while the panel is open, and
// the next run's sweep independently removes any surviving stray node regardless of what
// this registry still remembers. Treated as a live but practically unreachable path, hence
// a comfortable bound rather than a tight one.
const MAX_TRACKED = 32;

const tracked = new Set<string>();

export function registerSentinel(id: string): void {
  if (tracked.has(id)) return;
  if (tracked.size >= MAX_TRACKED) {
    const oldest = tracked.values().next().value;
    if (oldest !== undefined) tracked.delete(oldest);
  }
  tracked.add(id);
}

export function isSentinelId(id: string): boolean {
  return tracked.has(id);
}

/** Test-only: main.ts never calls this — the registry is process-lifetime by design. */
export function resetSentinelRegistryForTest(): void {
  tracked.clear();
}
