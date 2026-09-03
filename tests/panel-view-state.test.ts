import { describe, expect, it } from 'vitest';
import {
  BoundedKeySet, VIEW_KEY_LIMIT, applyActivityOutcome,
  currentActivity, landTerminalActivity, unresolvedActivityCount,
} from '../plugin/src/ui/panel-view-state.ts';
import { ActivityView, renderFailureBadge, type FailureBadgeTarget } from '../plugin/src/ui/panel-activity-view.ts';
import type { ActivityRecord } from '../plugin/src/ui/activity-feed.ts';

const record = (id: string, pending: boolean, ok: boolean, at: number): ActivityRecord => ({
  id, tool: 'EXEC_JS', pending, ok, ms: 0, at,
});

describe('keyed unresolved activity failures', () => {
  it('does not let an unrelated success clear a failed request', () => {
    let records = [record('A', true, true, 2), record('B', true, true, 1)];
    const failures = new BoundedKeySet();
    applyActivityOutcome(failures, 'B', false);
    records = records.map((item) => item.id === 'B' ? { ...item, pending: false, ok: false } : item);
    expect(currentActivity(records)?.id).toBe('A');
    expect(unresolvedActivityCount(failures)).toBe(1);

    applyActivityOutcome(failures, 'A', true);
    records = records.map((item) => item.id === 'A' ? { ...item, pending: false, ok: true } : item);
    expect(currentActivity(records)?.id).toBe('A');
    expect(unresolvedActivityCount(failures)).toBe(1);
    expect(failures.values()).toEqual(['B']);
  });

  it('clears only the matching request and bounds retained keys', () => {
    const failures = new BoundedKeySet();
    for (let index = 0; index < VIEW_KEY_LIMIT + 5; index += 1) failures.add(`request-${index}`);
    expect(failures.size).toBe(VIEW_KEY_LIMIT);
    expect(failures.has('request-0')).toBe(false);
    applyActivityOutcome(failures, `request-${VIEW_KEY_LIMIT + 4}`, true);
    expect(failures.size).toBe(VIEW_KEY_LIMIT - 1);
  });

  it('acknowledging clears the keys and the overflow they spilled into, and re-arms after', () => {
    const failures = new BoundedKeySet();
    for (let index = 0; index < VIEW_KEY_LIMIT + 3; index += 1) failures.add(`failure-${index}`);
    expect(failures.overflowCount).toBe(3);
    failures.acknowledge();
    expect(unresolvedActivityCount(failures)).toBe(0);
    expect(failures.overflowCount).toBe(0);
    applyActivityOutcome(failures, 'failure-next', false);
    expect(unresolvedActivityCount(failures)).toBe(1);
  });

  it('still counts the 65th failure after the key itself was evicted', () => {
    const failures = new BoundedKeySet();
    for (let index = 0; index < VIEW_KEY_LIMIT + 1; index += 1) failures.add(`failure-${index}`);
    expect(failures.size).toBe(VIEW_KEY_LIMIT);
    expect(failures.overflowCount).toBe(1);
    expect(unresolvedActivityCount(failures)).toBe(65);
    // Only a genuine resolution clears one: the rail has no "mark as seen" gesture left.
    applyActivityOutcome(failures, `failure-${VIEW_KEY_LIMIT}`, true);
    expect(unresolvedActivityCount(failures)).toBe(64);
  });

  it('synthesizes a readable failure row for a terminal result after eviction', () => {
    const records = Array.from({ length: 50 }, (_, index) => record(`new-${index}`, false, true, 100 - index));
    const landed = landTerminalActivity(records, {
      id: 'evicted-request', ok: false, ms: 42, result: 'Node no longer exists', code: 'E_NOT_FOUND',
    }, 200);
    expect(landed).toHaveLength(50);
    expect(landed[0]).toMatchObject({ id: 'evicted-request', pending: false, ok: false, at: 200 });
    expect(landed[0]?.sentence).toContain('Node no longer exists');
  });

  it('updates the visible and accessible failure badge as the count moves', () => {
    const attributes = new Map<string, string>();
    const badge = { hidden: true, textContent: '', setAttribute: (name: string, value: string) => attributes.set(name, value) };
    renderFailureBadge(badge, 65);
    expect(badge).toMatchObject({ hidden: false, textContent: '65' });
    expect(attributes.get('aria-label')).toBe('65 unresolved failures');
    renderFailureBadge(badge, 0);
    expect(badge).toMatchObject({ hidden: true, textContent: '' });
    expect(attributes.get('aria-label')).toBe('0 unresolved failures');
  });
});

describe('pending activity command snapshots', () => {
  const badge = (): FailureBadgeTarget => ({ hidden: true, textContent: '', setAttribute: () => {} });
  const view = (): ActivityView => new ActivityView(badge());

  it('includes every pending request without deduplicating command names', () => {
    const activity = view();
    activity.push(record('oldest', true, true, 1));
    activity.push(record('newest', true, true, 2));
    expect(activity.pendingTools()).toEqual(['EXEC_JS', 'EXEC_JS']);
  });

  it('keeps unrelated pending work through out-of-order completion', () => {
    const activity = view();
    activity.push({ ...record('oldest', true, true, 1), tool: 'AUDIT_DS' });
    activity.push({ ...record('newest', true, true, 2), tool: 'SET_TEXT' });
    activity.resolve({ id: 'newest', ok: true, ms: 1 });
    expect(activity.pendingTools()).toEqual(['AUDIT_DS']);
    activity.resolve({ id: 'oldest', ok: true, ms: 2 });
    expect(activity.pendingTools()).toEqual([]);
  });

  it('keeps the newer request when the oldest request resolves first', () => {
    const activity = view();
    activity.push({ ...record('oldest', true, true, 1), tool: 'AUDIT_DS' });
    activity.push({ ...record('newest', true, true, 2), tool: 'SET_TEXT' });
    activity.resolve({ id: 'oldest', ok: true, ms: 1 });
    expect(activity.pendingTools()).toEqual(['SET_TEXT']);
  });

  it('tracks every active request beyond the capped 50-row display history', () => {
    const activity = view();
    for (let index = 0; index < 65; index += 1) {
      activity.push(record(`request-${index}`, true, true, index));
    }
    expect(activity.pendingTools()).toHaveLength(65);
    activity.resolve({ id: 'request-0', ok: true, ms: 1 });
    expect(activity.pendingTools()).toHaveLength(64);
    activity.resolve({ id: 'request-64', ok: true, ms: 1 });
    expect(activity.pendingTools()).toHaveLength(63);
  });

  it('returns a fresh snapshot that cannot mutate the activity buffer', () => {
    const activity = view();
    activity.push(record('request', true, true, 1));
    const snapshot = activity.pendingTools() as string[];
    snapshot.length = 0;
    expect(activity.pendingTools()).toEqual(['EXEC_JS']);
  });
});
