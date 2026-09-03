import { describe, it, expect } from 'vitest';
import {
  formatAge, showOnboarding, fileNote,
  RAIL_MIN_WIDTH, RAIL_MAX_WIDTH, RAIL_HEIGHT,
  clampRailWidth, resolveViewportRequest, railSentence, connectionTrouble,
  syncPromptLabel, syncResultLabel, syncNowLabel, shouldClearPendingCount,
  syncStartSentence, syncResultSentence, syncStuckSentence, syncSupersededSentence, SYNC_STUCK_TIMEOUT_MS,
  targetButtonLabel, droppedNote, acknowledgeHint,
} from '../plugin/src/ui/panel-model.ts';
// The relay's offline buffer is bounded, so a long enough outage still loses edits.
// Whatever it lost has to reach the one human looking at this panel — see the
// railSentence table below for where it lands in the one-line rail.
describe('droppedNote — the count the panel may never swallow', () => {
  it('never fabricates a plural or a zero case it was not given', () => {
    expect(droppedNote(1)).toBe('1 edit lost while offline');
    expect(droppedNote(42)).toBe('42 edits lost while offline');
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
describe('clampRailWidth — the rail hugs its content, main still trusts no number', () => {
  it('keeps a width inside the band untouched', () => {
    expect(clampRailWidth(240)).toBe(240);
    expect(clampRailWidth(377)).toBe(377);
    expect(clampRailWidth(560)).toBe(560);
  });
  it('clamps both ends of the band — the title must fit, the canvas must survive', () => {
    expect(clampRailWidth(0)).toBe(RAIL_MIN_WIDTH);
    expect(clampRailWidth(-9_000)).toBe(RAIL_MIN_WIDTH);
    expect(clampRailWidth(239)).toBe(RAIL_MIN_WIDTH);
    expect(clampRailWidth(561)).toBe(RAIL_MAX_WIDTH);
    expect(clampRailWidth(100_000)).toBe(RAIL_MAX_WIDTH);
  });
  it('rounds a fractional content width UP — rounding down clips the last pixel of the sentence', () => {
    expect(clampRailWidth(300.2)).toBe(301);
    expect(clampRailWidth(559.6)).toBe(560);
    expect(Number.isInteger(clampRailWidth(412.5))).toBe(true);
  });
  it('falls back to the minimum for anything that is not a finite number', () => {
    expect(clampRailWidth(Number.NaN)).toBe(RAIL_MIN_WIDTH);
    expect(clampRailWidth(Number.POSITIVE_INFINITY)).toBe(RAIL_MIN_WIDTH);
    expect(clampRailWidth('420')).toBe(RAIL_MIN_WIDTH);
    expect(clampRailWidth(undefined)).toBe(RAIL_MIN_WIDTH);
    expect(clampRailWidth(null)).toBe(RAIL_MIN_WIDTH);
    expect(clampRailWidth({ width: 420 })).toBe(RAIL_MIN_WIDTH);
  });
  it('the band itself keeps the host title readable and the height fixed', () => {
    expect([RAIL_MIN_WIDTH, RAIL_MAX_WIDTH, RAIL_HEIGHT]).toEqual([240, 560, 44]);
  });
});

describe('resolveViewportRequest — the ONE viewport message main accepts', () => {
  it('answers a hug request with the clamped width and the fixed rail height', () => {
    expect(resolveViewportRequest({ type: 'PANEL_VIEWPORT', mode: 'hug', width: 412 }))
      .toEqual({ width: 412, height: RAIL_HEIGHT });
    expect(resolveViewportRequest({ type: 'PANEL_VIEWPORT', mode: 'hug', width: 9_000 }))
      .toEqual({ width: RAIL_MAX_WIDTH, height: RAIL_HEIGHT });
    expect(resolveViewportRequest({ type: 'PANEL_VIEWPORT', mode: 'hug', width: 'wide' }))
      .toEqual({ width: RAIL_MIN_WIDTH, height: RAIL_HEIGHT });
  });
  it('ignores every other message — a retired mode resizes nothing', () => {
    for (const message of [
      null, undefined, 'PANEL_VIEWPORT', 42,
      { type: 'PANEL_VIEWPORT' },
      { type: 'PANEL_VIEWPORT', mode: 'inspector', width: 288 },
      { type: 'PANEL_VIEWPORT', mode: 'rail-compact' },
      { type: 'SYNC_DONE', mode: 'hug', width: 300 },
      { mode: 'hug', width: 300 },
    ]) expect(resolveViewportRequest(message)).toBeNull();
  });
});

describe('connectionTrouble — the only connection states worth a whole sentence', () => {
  it('names first-run, a lost link, and a broker that never answered', () => {
    expect(connectionTrouble('disconnected', 0, false)).toBe('never-connected');
    expect(connectionTrouble('probing', 9_000, false)).toBe('never-connected');
    expect(connectionTrouble('disconnected', 0, true)).toBe('connection-lost');
    expect(connectionTrouble('probing', 10_000, true)).toBe('probe-timeout');
  });
  it('stays silent while the connection is merely working — the orb carries that', () => {
    expect(connectionTrouble('connected', 0, true)).toBeNull();
    expect(connectionTrouble('handshake', 0, false)).toBeNull();
    expect(connectionTrouble('probing', 9_000, true)).toBeNull();
  });
});

describe('railSentence — one line, strict priority, nothing hidden', () => {
  const sync = { text: '2 changes ready', tone: 'warning' } as const;
  const activity = { text: 'Created frame Hero', tone: 'info' } as const;

  it('connection trouble outranks sync and activity, which survive in the title', () => {
    expect(railSentence({ state: 'disconnected', ageMs: 0, hadConnection: true, sync, activity })).toEqual({
      lead: '',
      rest: 'Connection lost — reconnecting.',
      text: 'Connection lost — reconnecting.',
      tone: 'muted',
      title: 'Connection lost — reconnecting. · 2 changes ready · Created frame Hero',
    });
  });
  it('a healthy-but-slow connection is not trouble — the row belongs to the work', () => {
    expect(railSentence({ state: 'probing', ageMs: 9_000, hadConnection: true, activity }))
      .toEqual({ lead: '', rest: 'Created frame Hero', text: 'Created frame Hero', tone: 'info', title: 'Created frame Hero' });
  });
  it('a lost edit leads the line, so only the connection half can be ellipsed', () => {
    expect(railSentence({ state: 'probing', ageMs: 10_000, hadConnection: true, droppedFrames: 2, sync })).toEqual({
      lead: '2 edits lost while offline',
      rest: ' · Broker not running — run figma-agent status.',
      text: '2 edits lost while offline · Broker not running — run figma-agent status.',
      tone: 'warning',
      title: '2 edits lost while offline · Broker not running — run figma-agent status. · 2 changes ready',
    });
  });
  it('and outranks sync and activity on its own once the connection is healthy again', () => {
    expect(railSentence({ state: 'connected', ageMs: 0, hadConnection: true, droppedFrames: 1, sync, activity })).toEqual({
      lead: '1 edit lost while offline',
      rest: '',
      text: '1 edit lost while offline',
      tone: 'warning',
      title: '1 edit lost while offline · 2 changes ready · Created frame Hero',
    });
  });
  it('keeps text as exactly lead + rest, so the two spans read as one line', () => {
    const view = railSentence({ state: 'probing', ageMs: 10_000, hadConnection: true, droppedFrames: 3, sync, activity });
    expect(`${view.lead}${view.rest}`).toBe(view.text);
    expect(view.title.startsWith(view.text)).toBe(true);
  });
  it('sync outranks the current activity', () => {
    expect(railSentence({ state: 'connected', ageMs: 0, hadConnection: true, sync, activity }))
      .toEqual({ lead: '', rest: '2 changes ready', text: '2 changes ready', tone: 'warning', title: '2 changes ready · Created frame Hero' });
  });
  it('falls through to the activity label, then to Idle', () => {
    expect(railSentence({ state: 'connected', ageMs: 0, hadConnection: true, activity }))
      .toEqual({ lead: '', rest: 'Created frame Hero', text: 'Created frame Hero', tone: 'info', title: 'Created frame Hero' });
    expect(railSentence({ state: 'connected', ageMs: 0, hadConnection: true }))
      .toEqual({ lead: '', rest: 'Idle', text: 'Idle', tone: 'muted', title: 'Idle' });
  });
  it('never renders an empty or whitespace-only layer as the sentence', () => {
    expect(railSentence({
      state: 'connected', ageMs: 0, hadConnection: true, droppedFrames: 0,
      sync: { text: '   ', tone: 'info' }, activity: { text: '', tone: 'info' },
    })).toEqual({ lead: '', rest: 'Idle', text: 'Idle', tone: 'muted', title: 'Idle' });
  });
  it('refuses to invent a dropped-edit count from a broken number', () => {
    expect(railSentence({ state: 'connected', ageMs: 0, hadConnection: true, droppedFrames: Number.NaN }).text).toBe('Idle');
    expect(railSentence({ state: 'connected', ageMs: 0, hadConnection: true, droppedFrames: -3 }).text).toBe('Idle');
  });
  it('first-run onboarding is the sentence, not a card', () => {
    expect(railSentence({ state: 'probing', ageMs: 0, hadConnection: false }))
      .toEqual({
        lead: '',
        rest: 'Not connected — your first command starts the broker.',
        text: 'Not connected — your first command starts the broker.',
        tone: 'muted',
        title: 'Not connected — your first command starts the broker.',
      });
  });
});
describe('acknowledgeHint — the row\'s tooltip has to say what clicking it does', () => {
  it('pluralizes the count it was actually given', () => {
    expect(acknowledgeHint(1)).toBe('click to mark 1 unresolved failure as seen');
    expect(acknowledgeHint(4)).toBe('click to mark 4 unresolved failures as seen');
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
