import type { ConnectionState } from '../../../shared/protocol';

export type Tone = 'success' | 'warning' | 'info' | 'muted';
export const RAIL_COMPACT_WIDTH = 200;
export const RAIL_ONE_ACTION_WIDTH = 220;
export const RAIL_TWO_ACTIONS_WIDTH = 240;
export const RAIL_HEIGHT = 44;
export const INSPECTOR_WIDTH = 288;
export const INSPECTOR_HEIGHT = 280;
export const SYNC_STUCK_TIMEOUT_MS = 30_000;
export type RailViewportMode = 'rail-compact' | 'rail-one-action' | 'rail-two-actions';
export type ViewportMode = RailViewportMode | 'inspector';
export type SyncSource = 'manual' | 'auto';

export function statusSentence(state: ConnectionState, ageMs: number, hadConnection: boolean): { text: string; tone: Tone } {
  if (state === 'connected') return { text: 'Connected', tone: 'success' };
  if (state === 'probing') return ageMs >= 10_000
    ? { text: 'Broker not running — run figma-agent status.', tone: 'warning' }
    : { text: 'Looking for the broker', tone: 'warning' };
  if (state === 'handshake') return { text: 'Connecting', tone: 'info' };
  return hadConnection
    ? { text: 'Connection lost — reconnecting.', tone: 'muted' }
    : { text: 'Not connected — your first command starts the broker.', tone: 'muted' };
}

export function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 1) return 'just now';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

export function showOnboarding(state: ConnectionState, hadConnection: boolean): boolean {
  return !hadConnection && (state === 'disconnected' || state === 'probing');
}

export function railViewportMode(targetVisible: boolean, syncVisible: boolean): RailViewportMode {
  const actions = Number(targetVisible) + Number(syncVisible);
  return actions === 0 ? 'rail-compact' : actions === 1 ? 'rail-one-action' : 'rail-two-actions';
}

export function viewportFor(mode: ViewportMode): { width: number; height: number } {
  if (mode === 'inspector') return { width: INSPECTOR_WIDTH, height: INSPECTOR_HEIGHT };
  const width = mode === 'rail-compact'
    ? RAIL_COMPACT_WIDTH
    : mode === 'rail-one-action' ? RAIL_ONE_ACTION_WIDTH : RAIL_TWO_ACTIONS_WIDTH;
  return { width, height: RAIL_HEIGHT };
}

export function shouldForceInspector(state: ConnectionState, ageMs: number, hadConnection: boolean): boolean {
  return showOnboarding(state, hadConnection) || (state === 'disconnected' && hadConnection) || (state === 'probing' && ageMs >= 10_000);
}

export function fileNote(count: number, active: boolean, pinned = false): string {
  if (count <= 1) return active ? (pinned ? 'pinned target' : 'command target') : '';
  const others = count - 1;
  const files = others === 1 ? 'file' : 'files';
  if (!active) return `${others} other ${files} — commands go elsewhere`;
  return pinned ? `pinned target · ${others} other ${files}` : `command target · ${others} other ${files}`;
}

export function targetButtonLabel(pinned: boolean): string { return pinned ? 'Targeted' : 'Target this plugin'; }

export function syncPromptLabel(count: number): string {
  const value = Number.isFinite(count) && count > 0 ? Math.floor(count) : 1;
  return `${value} change${value === 1 ? '' : 's'} ready`;
}

export function syncResultLabel(ok: boolean, summary: string, landed = true, unbound = false): string {
  const clean = summary.trim() || (ok ? 'done' : 'failed');
  if (unbound) return clean;
  if (!ok) return `Sync failed — ${clean}`;
  return landed ? `Synced — ${clean}` : `Nothing synced — ${clean}`;
}

export function syncNowLabel(unbound: boolean): string { return unbound ? 'Bind & retry' : 'Sync now'; }

export function syncStartSentence(source: SyncSource, fileLabel: string): string {
  return source === 'auto'
    ? `Auto-sync started — ${fileLabel} went idle, applying its pending changes`
    : `Sync started — checking ${fileLabel} for pending Figma changes to apply`;
}

export function syncResultSentence(ok: boolean, summary: string, landed: boolean, unbound: boolean, fileLabel: string): string {
  const clean = summary.trim() || (ok ? 'done' : 'failed');
  if (unbound) return clean;
  if (!ok) return `Sync failed for ${fileLabel} — ${clean}`;
  return landed ? `Synced ${fileLabel} — ${clean}` : `Nothing synced for ${fileLabel} — ${clean}`;
}

export function syncStuckSentence(): string { return 'Sync did not answer — the broker restarted mid-run; press Sync again'; }
export function syncSupersededSentence(): string { return 'Superseded by a newer sync'; }
export function shouldClearPendingCount(ok: boolean): boolean { return ok === true; }
