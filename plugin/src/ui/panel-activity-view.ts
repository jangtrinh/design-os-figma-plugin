import { pushActivity, type ActivityRecord, type ActivityResult } from './activity-feed';
import { activitySentence } from './activity-sentence';
import { makeLucideIcon, type LucideIconName } from './lucide-icons';
import { applyActivityOutcome, BoundedKeySet, currentActivity, landTerminalActivity } from './panel-view-state';

export function replaceIcon(target: HTMLElement, name: LucideIconName, spinning = false): void {
  const kept = Array.from(target.children).filter((child) => child.classList.contains('rail-badge'));
  const icon = makeLucideIcon(name);
  if (spinning) icon.classList.add('is-spinning');
  target.replaceChildren(icon, ...kept);
}

export function labelControl(target: HTMLElement, label: string): void {
  target.title = label;
  target.setAttribute('aria-label', label);
}

export interface FailureBadgeTarget {
  hidden: boolean;
  textContent: string | null;
  setAttribute(name: string, value: string): void;
}

export type ActivityRailPhase = 'idle' | 'pending' | 'complete' | 'failed';

export function renderFailureBadge(target: FailureBadgeTarget, count: number): void {
  target.hidden = count === 0;
  target.textContent = count === 0 ? '' : String(count);
  target.setAttribute('aria-label', `${count} unresolved failure${count === 1 ? '' : 's'}`);
}

function sentence(record: ActivityRecord): string {
  return record.sentence ?? activitySentence({
    tool: record.tool, label: record.label, result: record.result,
    errorCode: record.errorCode, errorMessage: !record.ok ? record.result : undefined,
    nodeName: record.nodeName, pending: record.pending, ok: record.ok,
  });
}

/** The activity feed as the single rail row can carry it: the current request's own
 *  sentence, plus the count of failures nothing has resolved yet. The newest-first history
 *  the inspector used to list is not rendered here — `figma-agent changes / errors` is
 *  where a full log is read. */
export class ActivityView {
  private records: ActivityRecord[] = [];
  private readonly activeTools = new Map<string, string>();
  readonly failures = new BoundedKeySet();

  constructor(private readonly failureCount: FailureBadgeTarget) {}

  push(record: ActivityRecord): void {
    this.records = pushActivity(this.records, record);
    if (record.pending) this.activeTools.set(record.id, record.tool);
    else this.activeTools.delete(record.id);
  }

  resolve(patch: ActivityResult, trackFailure = true): void {
    this.records = landTerminalActivity(this.records, patch);
    this.activeTools.delete(patch.id);
    if (trackFailure) applyActivityOutcome(this.failures, patch.id, patch.ok);
  }

  acknowledgeFailures(): void { this.failures.acknowledge(); }

  railPhase(): ActivityRailPhase {
    const current = currentActivity(this.records);
    return !current ? 'idle' : current.pending ? 'pending' : current.ok ? 'complete' : 'failed';
  }

  /** What the rail says when nothing outranks the work itself. */
  currentSentence(): string | null {
    const current = currentActivity(this.records);
    return current ? sentence(current) : null;
  }

  pendingTools(): readonly string[] {
    return [...this.activeTools.values()];
  }

  renderBadge(): void {
    renderFailureBadge(this.failureCount, this.failures.unresolvedCount);
  }
}
