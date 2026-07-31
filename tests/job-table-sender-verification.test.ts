// Backlog 2.10 audit — `isReplyFromDispatchedInstance` is the pure decision core of
// the fix wired into `routeFromPlugin` (see tests/broker-daemon-harness.test.ts for the
// full-daemon spoofing scenario this closes). Unit-tested here in isolation because the
// identity-vs-socket-reference distinction — the exact nuance the issue's "esp. around
// reconnect with same instanceId, socket changed" called out — is deterministic and
// racy to prove through a real WebSocket reconnect (it competes with the unrelated,
// pre-existing `handleClose` disconnect-triggered job failure). `isReplyFromDispatchedInstance`
// did not exist before this fix.
import { describe, expect, it } from 'vitest';
import { isReplyFromDispatchedInstance } from '../cli/src/transport/job-table.ts';

describe('isReplyFromDispatchedInstance — identity-based, never socket-reference-based', () => {
  it('the dispatched instance replying is authorized', () => {
    expect(isReplyFromDispatchedInstance({ targetInstanceId: 'inst-x' }, 'inst-x')).toBe(true);
  });

  it('REGRESSION LOCK: a DIFFERENT instance replying with the same request id is rejected', () => {
    // This is the exact audit finding — pre-fix, routeFromPlugin never made this
    // comparison at all, so nothing distinguished this case from the one above.
    expect(isReplyFromDispatchedInstance({ targetInstanceId: 'inst-x' }, 'inst-y')).toBe(false);
  });

  it('an unrecognised sender (registry has no entry for that socket — e.g. a stale reference to an already-superseded pre-reconnect socket) is never authorized', () => {
    expect(isReplyFromDispatchedInstance({ targetInstanceId: 'inst-x' }, null)).toBe(false);
    expect(isReplyFromDispatchedInstance({ targetInstanceId: 'inst-x' }, undefined)).toBe(false);
  });

  it('reconnect resilience: the SAME instanceId is authorized regardless of which literal socket carries it — identity, not a ws-reference, is what is checked', () => {
    // Simulates PluginRegistry.register() replacing the ws for instanceId 'inst-x' on
    // reconnect: the job's targetInstanceId (pinned at admission, before the
    // reconnect) is unchanged, and the reconnected socket's registry entry reports the
    // SAME instanceId — this must read as authorized, not as "a different instance".
    const job = { targetInstanceId: 'inst-x' };
    expect(isReplyFromDispatchedInstance(job, 'inst-x')).toBe(true); // pre-reconnect socket
    expect(isReplyFromDispatchedInstance(job, 'inst-x')).toBe(true); // post-reconnect socket, same id
  });

  it('an unknown/expired job (nothing to verify against) is not this function\'s concern — routeFromPlugin\'s existing no-job handling already no-ops safely', () => {
    expect(isReplyFromDispatchedInstance(undefined, 'inst-x')).toBe(true);
    expect(isReplyFromDispatchedInstance(undefined, null)).toBe(true);
  });
});
