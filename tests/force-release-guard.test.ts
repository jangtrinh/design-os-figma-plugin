// The force-release guard: a HEALTHY still-running job is refused unless the requester
// passes `--force`; a watchdog-wedged job keeps unwedging with a bare `--force-release`.
// Pure logic only — `buildForceReleaseAuditLine` is exported from broker-daemon.ts
// specifically so the "every force-release is audited with the requester's activity"
// invariant is unit-testable without a live broker; the full handler wiring (queue
// mechanics, advanceQueue) is exercised by the daemon harness (tests/broker-daemon-
// harness.test.ts) instead, since it needs the real closures.
import { describe, expect, it } from 'vitest';
import { buildForceReleaseAuditLine, reservedForceReleaseReason } from '../cli/src/transport/broker-daemon.ts';

describe('reservedForceReleaseReason', () => {
  it('refuses a reserved queued head with the exact cancel command', () => {
    expect(reservedForceReleaseReason('j_1_1', 'queued', 'j_1_1')).toBe(
      "job 'j_1_1' is queued and has not been dispatched; use: figma-agent job j_1_1 --cancel",
    );
  });

  it('does not classify waiting, running, or terminal jobs as reserved', () => {
    expect(reservedForceReleaseReason('j_1_1', 'queued', 'j_other')).toBeNull();
    expect(reservedForceReleaseReason('j_1_1', 'running', 'j_1_1')).toBeNull();
    expect(reservedForceReleaseReason('j_1_1', 'failed', 'j_1_1')).toBeNull();
  });
});

describe('buildForceReleaseAuditLine — the requester is never silent', () => {
  it('includes the requester\'s activity label', () => {
    const line = buildForceReleaseAuditLine('j_1_1', 'EXEC_JS', 'fileA', false, 'Force-release · j_1_1');
    expect(line).toContain('Force-release · j_1_1');
    expect(line).toContain('j_1_1');
    expect(line).toContain('fileA');
  });

  it('an unlabeled request still names itself explicitly, never omitted', () => {
    const line = buildForceReleaseAuditLine('j_1_1', 'EXEC_JS', 'fileA', false, undefined);
    expect(line).toContain('unlabeled request');
  });

  it('marks a `--force` override distinctly from a bare (wedged-unwedge) force-release', () => {
    const overridden = buildForceReleaseAuditLine('j_1_1', 'EXEC_JS', 'fileA', true, 'Force-release · j_1_1');
    const bare = buildForceReleaseAuditLine('j_1_1', 'EXEC_JS', 'fileA', false, 'Force-release · j_1_1');
    expect(overridden).toContain('--force override');
    expect(bare).not.toContain('--force override');
  });
});
