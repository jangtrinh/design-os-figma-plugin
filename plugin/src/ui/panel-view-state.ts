import type { ConnectionState } from '../../../shared/protocol';
import { pushActivity, resolveActivity, type ActivityRecord, type ActivityResult } from './activity-feed';

export const VIEW_KEY_LIMIT = 64;

export class BoundedKeySet {
  private readonly keys = new Set<string>();
  private overflow = 0;

  constructor(private readonly limit = VIEW_KEY_LIMIT) {}

  add(key: string): void {
    if (this.keys.has(key)) this.keys.delete(key);
    this.keys.add(key);
    while (this.keys.size > this.limit) {
      const oldest = this.keys.values().next().value as string | undefined;
      if (oldest === undefined) break;
      this.keys.delete(oldest);
      this.overflow += 1;
    }
  }

  delete(key: string): void { this.keys.delete(key); }
  has(key: string): boolean { return this.keys.has(key); }
  get size(): number { return this.keys.size; }
  get unresolvedCount(): number { return this.keys.size + this.overflow; }
  get overflowCount(): number { return this.overflow; }
  values(): string[] { return [...this.keys]; }
  acknowledge(): void { this.keys.clear(); this.overflow = 0; }
}

export function applyActivityOutcome(failures: BoundedKeySet, id: string, ok: boolean): void {
  if (ok) failures.delete(id);
  else failures.add(id);
}

export function currentActivity(records: readonly ActivityRecord[]): ActivityRecord | undefined {
  return records.find((record) => record.pending) ?? records[0];
}

export function unresolvedActivityCount(failures: BoundedKeySet): number {
  return failures.unresolvedCount;
}

export function landTerminalActivity(
  records: readonly ActivityRecord[],
  patch: ActivityResult,
  at = Date.now(),
): ActivityRecord[] {
  if (records.some((record) => record.id === patch.id)) return resolveActivity(records, patch);
  const outcome = patch.ok ? 'completed' : 'failed';
  const detail = patch.sentence ?? patch.result ?? outcome;
  return pushActivity(records, {
    id: patch.id, tool: 'REQUEST', pending: false, ok: patch.ok, ms: patch.ms, at,
    result: patch.result, errorCode: patch.code, nodeName: patch.nodeName,
    sentence: `Late result for request ${patch.id} — ${detail}`,
  });
}

export type ConnectionForceKind = 'onboarding' | 'probe-timeout' | 'connection-lost';
export interface ConnectionForce {
  key: string;
  kind: ConnectionForceKind;
}

/** Semantic keys make the 10-second threshold distinct from the earlier onboarding view. */
export function connectionForce(
  state: ConnectionState,
  ageMs: number,
  hadConnection: boolean,
  transitionId: number,
): ConnectionForce | null {
  if (state === 'probing' && ageMs >= 10_000) {
    return { key: `probe-timeout:${transitionId}`, kind: 'probe-timeout' };
  }
  if (state === 'disconnected' && hadConnection) {
    return { key: `connection-lost:${transitionId}`, kind: 'connection-lost' };
  }
  if (!hadConnection && (state === 'disconnected' || state === 'probing')) {
    return { key: `onboarding:${transitionId}`, kind: 'onboarding' };
  }
  return null;
}
