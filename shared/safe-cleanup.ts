// Shared helper closing the "a throwing cleanup() masks the original error" class.
// That bug was written independently several times, each a local copy of the same
// pattern. The two sites where cleanup FULLY REPLACED the original error route
// through this helper: `writeFileAtomic` (broker-discovery.ts) and `componentSet`'s
// cleanup (exec-stdlib-component-set.ts).
//
// `addSlotProperty`'s rollback (exec-stdlib-slot-property.ts) is deliberately NOT
// routed here and is NOT a member of this class: on a cleanup failure it throws a
// NEW error that PRESERVES the original `code` (via `withCode`) and combines the
// original message with the cleanup detail — an intentional "fallback honesty" that
// surfaces the leftover-key detail in `.message`. Routing it through `safeCleanup`
// would move that detail out of `.message` into `.cleanupError`, a behavior change,
// so it keeps its own combine form.
//
// Contract: run `cleanupFn` in its own try. If it throws, attach the cleanup
// failure to `originalError` as `.cleanupError` — WITHOUT substituting — then
// throw `originalError` unchanged (code + message byte-preserved). If cleanup
// does not throw, `originalError` is thrown untouched.
//
// Airtight edge (PR #23 stage-4 review): `originalError` may be frozen or
// otherwise non-extensible (e.g. Object.freeze'd, or a proxy that forbids new
// properties). Assigning `.cleanupError` on such an object throws a TypeError
// in strict-mode ESM, which would itself replace the original error — exactly
// the bug this helper exists to prevent. The attachment is therefore guarded by
// `Object.isExtensible` AND wrapped in its own try; if it cannot be attached,
// the cleanup failure is only logged (never dropped silently, never allowed to
// re-mask), and the original error still propagates unchanged.
export function safeCleanup(originalError: unknown, cleanupFn: () => void): never {
  try {
    cleanupFn();
  } catch (cleanupError) {
    attachCleanupError(originalError, cleanupError);
  }
  throw originalError;
}

/** Attach `cleanupError` to `originalError` as `.cleanupError` when it is safe to do
 *  so, otherwise log it — never lets the attachment itself throw and never drops
 *  the cleanup failure on the floor. */
function attachCleanupError(originalError: unknown, cleanupError: unknown): void {
  const canAttach = originalError !== null
    && typeof originalError === 'object'
    && Object.isExtensible(originalError);
  if (!canAttach) {
    // eslint-disable-next-line no-console -- last-resort visibility; there is no
    // other channel once the target refuses the property.
    console.error('safeCleanup: cleanup failed and originalError is not extensible, logging instead of attaching:', cleanupError);
    return;
  }
  try {
    (originalError as { cleanupError?: unknown }).cleanupError = cleanupError;
  } catch (attachError) {
    // Belt-and-suspenders: isExtensible said yes but the assignment still threw
    // (a setter, a Proxy trap, a frozen prototype chain quirk) — log both rather
    // than let this throw and mask originalError.
    console.error('safeCleanup: failed to attach cleanupError despite isExtensible check:', cleanupError, attachError);
  }
}
