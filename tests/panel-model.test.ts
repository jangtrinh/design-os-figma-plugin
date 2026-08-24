import { describe, it, expect } from 'vitest';
import {
  statusSentence, formatAge, showOnboarding, fileNote,
  RAIL_WIDTH, RAIL_HEIGHT, INSPECTOR_WIDTH, INSPECTOR_HEIGHT,
  viewportFor, shouldForceInspector,
  syncPromptLabel, syncResultLabel, syncNowLabel, shouldClearPendingCount,
  syncStartSentence, syncResultSentence, syncStuckSentence, syncSupersededSentence, SYNC_STUCK_TIMEOUT_MS,
  targetButtonLabel,
} from '../plugin/src/ui/panel-model.ts';
describe('statusSentence — Block 1: the problem and the next action, six branches', () => {
  it('connected — success tone, minimal (the dot already signals it)', () => {
    expect(statusSentence('connected', 0, true)).toEqual({
      text: 'Connected', tone: 'success',
    });
  });
  it('probing under 10s — "looking", warning tone', () => {
    expect(statusSentence('probing', 9_000, false)).toEqual({
      text: 'Looking for the broker', tone: 'warning',
    });
  });
  it('probing at/after 10s — names the fix, trimmed (no "in a terminal" filler)', () => {
    expect(statusSentence('probing', 10_000, false)).toEqual({
      text: 'Broker not running — run figma-agent status.', tone: 'warning',
    });
  });
  it('handshake — info tone, no ellipsis', () => {
    expect(statusSentence('handshake', 0, false)).toEqual({ text: 'Connecting', tone: 'info' });
  });
  it('disconnected, never connected — first-run wait, muted, trimmed', () => {
    expect(statusSentence('disconnected', 0, false)).toEqual({
      text: 'Not connected — your first command starts the broker.', tone: 'muted',
    });
  });
  it('disconnected, was connected — names the drop, muted, trimmed', () => {
    expect(statusSentence('disconnected', 0, true)).toEqual({
      text: 'Connection lost — reconnecting.', tone: 'muted',
    });
  });
});
describe('formatAge', () => {
  it('formatAge steps just-now → seconds → minutes → hours', () => {
    expect(formatAge(0)).toBe('just now');
    expect(formatAge(8_000)).toBe('8s');
    expect(formatAge(125_000)).toBe('2m 05s');
    expect(formatAge(3_780_000)).toBe('1h 03m');
    expect(formatAge(-5)).toBe('—');
    expect(formatAge(Number.NaN)).toBe('—');
  });
});
describe('showOnboarding — first-run only (survives the IA v2 cut, priority-1 content)', () => {
  it('shows while waiting and never connected', () => {
    expect(showOnboarding('disconnected', false)).toBe(true);
    expect(showOnboarding('probing', false)).toBe(true);
  });
  it('hides once connected, forever', () => {
    expect(showOnboarding('connected', true)).toBe(false);
    expect(showOnboarding('disconnected', true)).toBe(false); // a later drop still hides it
    expect(showOnboarding('handshake', false)).toBe(false);
  });
});
describe('fileNote — Block 2: honest answer to "which file will my command hit?"', () => {
  it('single file, this one is the target → "command target"', () => {
    expect(fileNote(1, true)).toBe('command target');
  });
  it('single file, not the target → empty (cannot happen today; never guess)', () => {
    expect(fileNote(1, false)).toBe('');
  });
  it('multiple files, this one is the target → target + peer count', () => {
    expect(fileNote(3, true)).toBe('command target · 2 other files');
    expect(fileNote(2, true)).toBe('command target · 1 other file');
  });
  it('multiple files, another is the target → says where commands go', () => {
    expect(fileNote(3, false)).toBe('2 other files — commands go elsewhere');
    expect(fileNote(2, false)).toBe('1 other file — commands go elsewhere');
  });
});
describe('fileNote — pinned distinction (#35 P2)', () => {
  it('single file, pinned target → "pinned target" (never "command target")', () => {
    expect(fileNote(1, true, true)).toBe('pinned target');
  });
  it('multiple files, pinned target → pinned + peer count', () => {
    expect(fileNote(3, true, true)).toBe('pinned target · 2 other files');
  });
  it('not the target at all → the "elsewhere" wording, regardless of pinned (cannot happen today, but must never claim pinned falsely)', () => {
    expect(fileNote(3, false, true)).toBe('2 other files — commands go elsewhere');
  });
  it('pinned omitted defaults to false — identical to the pre-#35 wording', () => {
    expect(fileNote(2, true)).toBe(fileNote(2, true, false));
    expect(fileNote(1, true)).toBe('command target');
  });
});
describe('targetButtonLabel — the "Target this plugin" toggle (#35 P2)', () => {
  it('unpinned → invites the click', () => {
    expect(targetButtonLabel(false)).toBe('Target this plugin');
  });
  it('pinned → confirms state, doubles as the clear-it toggle', () => {
    expect(targetButtonLabel(true)).toBe('Targeted');
    expect(targetButtonLabel(true)).not.toBe(targetButtonLabel(false));
  });
});
describe('adaptive panel geometry', () => {
  it('maps named viewport modes to the only accepted dimensions', () => {
    expect(viewportFor('rail')).toEqual({ width: 240, height: 44 });
    expect(viewportFor('inspector')).toEqual({ width: 288, height: 280 });
    expect([RAIL_WIDTH, RAIL_HEIGHT, INSPECTOR_WIDTH, INSPECTOR_HEIGHT])
      .toEqual([240, 44, 288, 280]);
  });
  it('forces text-bearing recovery only when it is actionable', () => {
    expect(shouldForceInspector('disconnected', 0, false)).toBe(true);
    expect(shouldForceInspector('probing', 9_000, false)).toBe(true);
    expect(shouldForceInspector('probing', 10_000, true)).toBe(true);
    expect(shouldForceInspector('disconnected', 0, true)).toBe(true);
    expect(shouldForceInspector('handshake', 0, false)).toBe(false);
    expect(shouldForceInspector('connected', 0, true)).toBe(false);
  });
});
describe('idle-commit prompt labels (spec 004 P4)', () => {
  it('syncPromptLabel pluralizes and floors count at 1', () => {
    expect(syncPromptLabel(1)).toBe('1 change ready');
    expect(syncPromptLabel(3)).toBe('3 changes ready');
    expect(syncPromptLabel(0)).toBe('1 change ready'); // never shows "0 changes"
    expect(syncPromptLabel(2.9)).toBe('2 changes ready'); // floored
    expect(syncPromptLabel(Number.NaN)).toBe('1 change ready');
  });
  it('syncResultLabel marks success and surfaces the failure reason — no glyph, the icon carries the mark', () => {
    expect(syncResultLabel(true, 'synced — 2 updated, 1 deprecated, 0 pending'))
      .toBe('Synced — synced — 2 updated, 1 deprecated, 0 pending');
    expect(syncResultLabel(false, 'ui not runnable')).toBe('Sync failed — ui not runnable');
    expect(syncResultLabel(true, '')).toBe('Synced — done'); // empty summary → sane default
    expect(syncResultLabel(false, '   ')).toBe('Sync failed — failed');
  });
  it('syncResultLabel — unbound renders the bind command bare, not under a failure verdict', () => {
    const summary = 'No project bound for "VSF - PCP" — run: figma-agent bind --file "VSF - PCP" --dir <project>';
    expect(syncResultLabel(false, summary, true, true)).toBe(summary);
    expect(syncResultLabel(false, summary, true, true)).not.toContain('Sync failed');
  });
  it('syncNowLabel — swaps to the bind hint on E_UNBOUND, reverts once bound (fix round, finding 2)', () => {
    expect(syncNowLabel(false)).toBe('Sync now');
    expect(syncNowLabel(true)).toBe('Bind & retry');
    expect(syncNowLabel(true)).not.toBe(syncNowLabel(false)); // the state machine's two branches
  });
});
describe('syncStartSentence — the pending Activity row (task #145)', () => {
  it('manual click names the file and what is about to happen', () => {
    expect(syncStartSentence('manual', 'VSF - PCP')).toBe('Sync started — checking VSF - PCP for pending Figma changes to apply');
  });
  it('auto (backlog 4.4 P3, not yet triggered anywhere) has its own distinct wording', () => {
    expect(syncStartSentence('auto', 'VSF - PCP')).toBe('Auto-sync started — VSF - PCP went idle, applying its pending changes');
    expect(syncStartSentence('auto', 'X')).not.toBe(syncStartSentence('manual', 'X'));
  });
});
describe('syncResultSentence — the resolved Activity row, three required cases (task #145)', () => {
  it('success carries the KERNEL SUMMARY verbatim, never collapsing to a bare "Synced"', () => {
    const s = syncResultSentence(true, '3 added, 1 updated, 2 deprecated', true, false, 'VSF - PCP');
    expect(s).toBe('Synced VSF - PCP — 3 added, 1 updated, 2 deprecated');
    expect(s).not.toBe('Synced'); // the exact regression this field exists to stop
  });
  it('success with nothing landed says so, distinct from a real sync', () => {
    expect(syncResultSentence(true, 'every new component still pending re-ingest', false, false, 'VSF - PCP'))
      .toBe('Nothing synced for VSF - PCP — every new component still pending re-ingest');
  });
  it('failure carries the REASON, never collapsing to a bare "Reconcile failed"', () => {
    const s = syncResultSentence(false, 'ui not runnable', true, false, 'VSF - PCP');
    expect(s).toBe('Sync failed for VSF - PCP — ui not runnable');
    expect(s).not.toBe('Reconcile failed');
  });
  it('unbound passes syncResultLabel\'s own bare message through UNWRAPPED (never "Sync failed for…")', () => {
    const summary = 'No project bound for "VSF - PCP" — run: figma-agent bind --file "VSF - PCP" --dir <project>';
    const s = syncResultSentence(false, summary, true, true, 'VSF - PCP');
    expect(s).toBe(summary);
    expect(s).not.toContain('Sync failed');
  });
});
describe('syncStuckSentence — the bounded-timeout fallback (live-observed broker-restart gap)', () => {
  it('names the cause and the recovery action, never implies the sync itself is broken', () => {
    expect(syncStuckSentence()).toBe('Sync did not answer — the broker restarted mid-run; press Sync again');
  });
  it('SYNC_STUCK_TIMEOUT_MS is a real bound (not 0, not absurdly long)', () => {
    expect(SYNC_STUCK_TIMEOUT_MS).toBeGreaterThan(1_000);
    expect(SYNC_STUCK_TIMEOUT_MS).toBeLessThan(120_000);
  });
});
describe('syncSupersededSentence — a second click resolves the first row (stage-4 fix round, minor 9)', () => {
  it('names the fact plainly — never implies the first sync itself failed', () => {
    expect(syncSupersededSentence()).toBe('Superseded by a newer sync');
    expect(syncSupersededSentence()).not.toContain('failed');
  });
});
describe('shouldClearPendingCount', () => {
  it('ONLY a genuine success clears the pending counter (closing round, defect #2)', () => {
    expect(shouldClearPendingCount(true)).toBe(true);
    expect(shouldClearPendingCount(false)).toBe(false);
  });
});
