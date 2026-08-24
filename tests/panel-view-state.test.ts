import { describe, expect, it } from 'vitest';
import {
  BoundedKeySet, VIEW_KEY_LIMIT, applyActivityOutcome, connectionForce,
  currentActivity, landTerminalActivity, unresolvedActivityCount,
} from '../plugin/src/ui/panel-view-state.ts';
import { renderFailureBadge } from '../plugin/src/ui/panel-activity-view.ts';
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

  it('accounts for the 65th failure until Activity acknowledges the aggregate', () => {
    const failures = new BoundedKeySet();
    for (let index = 0; index < VIEW_KEY_LIMIT + 1; index += 1) failures.add(`failure-${index}`);
    expect(failures.size).toBe(VIEW_KEY_LIMIT);
    expect(failures.overflowCount).toBe(1);
    expect(unresolvedActivityCount(failures)).toBe(65);
    failures.acknowledge();
    expect(unresolvedActivityCount(failures)).toBe(0);
    expect(failures.overflowCount).toBe(0);
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

  it('updates the visible and accessible failure badge on acknowledge', () => {
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

describe('semantic connection force keys', () => {
  it('reopens at the probe timeout after onboarding was already disclosed', () => {
    expect(connectionForce('probing', 9_999, false, 7)).toEqual({
      key: 'onboarding:7', kind: 'onboarding',
    });
    expect(connectionForce('probing', 10_000, false, 7)).toEqual({
      key: 'probe-timeout:7', kind: 'probe-timeout',
    });
  });

  it('distinguishes connection loss from first-run setup', () => {
    expect(connectionForce('disconnected', 0, true, 8)).toEqual({
      key: 'connection-lost:8', kind: 'connection-lost',
    });
    expect(connectionForce('connected', 0, true, 8)).toBeNull();
  });
});
