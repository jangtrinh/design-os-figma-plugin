import {
  diffRowKeys, pushActivity, timeAgo, formatTimestamp,
  type ActivityRecord, type ActivityResult,
} from './activity-feed';
import { activitySentence } from './activity-sentence';
import { makeLucideIcon, type LucideIconName } from './lucide-icons';
import { applyActivityOutcome, BoundedKeySet, currentActivity, landTerminalActivity } from './panel-view-state';

export function replaceIcon(target: HTMLElement, name: LucideIconName, spinning = false): void {
  const kept = Array.from(target.children).filter((child) =>
    child.classList.contains('rail-badge') || child.classList.contains('current-label') || child.classList.contains('failure-count'));
  const icon = makeLucideIcon(name);
  if (spinning) icon.classList.add('is-spinning');
  target.replaceChildren(icon, ...kept);
}

export function labelControl(target: HTMLButtonElement, label: string): void {
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

function row(record: ActivityRecord, now: number, stale: boolean, fresh: boolean): HTMLElement {
  const item = document.createElement('li');
  item.className = ['activity-row', stale && 'is-stale', fresh && 'is-new'].filter(Boolean).join(' ');
  const state = record.pending ? 'running' : record.ok ? 'ok' : 'failed';
  const iconWrap = document.createElement('span');
  iconWrap.className = 'log-icon-wrap';
  iconWrap.dataset.state = state;
  iconWrap.setAttribute('aria-label', state);
  const icon = makeLucideIcon(record.pending ? 'loader-circle' : record.ok ? 'circle-check' : 'circle-x');
  if (record.pending) icon.classList.add('is-spinning');
  iconWrap.append(icon);
  const body = document.createElement('div');
  body.className = 'log-body';
  const text = document.createElement('div');
  text.className = record.pending || record.ok ? 'log-label' : 'log-label log-label--wrap';
  const agent = document.createElement('span');
  agent.className = 'log-agent';
  agent.textContent = `${record.agent ?? 'cli'} · `;
  const line = sentence(record);
  text.append(agent, document.createTextNode(line));
  text.title = line;
  const meta = document.createElement('div');
  meta.className = 'log-meta';
  meta.textContent = record.pending ? 'running' : timeAgo(now, record.at);
  meta.title = formatTimestamp(record.at);
  body.append(text, meta);
  item.append(iconWrap, body);
  return item;
}

export class ActivityView {
  private records: ActivityRecord[] = [];
  private previousKeys: string[] = [];
  readonly failures = new BoundedKeySet();

  constructor(
    private readonly list: HTMLElement,
    private readonly currentButton: HTMLButtonElement,
    private readonly currentLabel: HTMLElement,
    private readonly failureCount: HTMLElement,
  ) {}

  push(record: ActivityRecord): void { this.records = pushActivity(this.records, record); }

  resolve(patch: ActivityResult, trackFailure = true): void {
    this.records = landTerminalActivity(this.records, patch);
    if (trackFailure) applyActivityOutcome(this.failures, patch.id, patch.ok);
  }

  acknowledgeFailures(): void { this.failures.acknowledge(); }

  railPhase(): ActivityRailPhase {
    const current = currentActivity(this.records);
    return !current ? 'idle' : current.pending ? 'pending' : current.ok ? 'complete' : 'failed';
  }

  render(now = Date.now()): void {
    const shown = this.records.slice(0, 20);
    if (shown.length === 0) {
      this.previousKeys = [];
      if (this.list.children.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'activity-empty';
        empty.textContent = 'No activity yet';
        this.list.append(empty);
      }
    } else {
      const keys = shown.map((record) => record.id);
      const fresh = new Set(diffRowKeys(this.previousKeys, keys));
      this.list.replaceChildren(...shown.map((record, index) => row(record, now, index > 0, fresh.has(record.id))));
      this.previousKeys = keys;
    }
    this.renderRail();
  }

  private renderRail(): void {
    const current = currentActivity(this.records);
    const count = this.failures.unresolvedCount;
    renderFailureBadge(this.failureCount, count);
    const suffix = count === 0 ? '' : `. ${count} unresolved failure${count === 1 ? '' : 's'}`;
    if (!current) {
      this.currentLabel.textContent = 'Idle';
      this.currentButton.className = `rail-control current-control${count ? ' tone-danger' : ''}`;
      labelControl(this.currentButton, `Current activity: Idle${suffix}`);
      return;
    }
    const state = current.pending ? 'running' : current.ok ? 'complete' : 'failed';
    this.currentLabel.textContent = sentence(current);
    this.currentButton.className = `rail-control current-control${count ? ' tone-danger' : ''}`;
    labelControl(this.currentButton, `Current activity ${state}: ${sentence(current)}${suffix}`);
  }
}
