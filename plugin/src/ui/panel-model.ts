import type { ConnectionState } from '../../../shared/protocol';

export type Tone = 'success' | 'warning' | 'info' | 'muted';
/** The rail is ONE row that hugs its content. 240 is the floor because the host draws the
 *  window title itself and truncates "design:os by JANG" below it; 560 is the ceiling so a
 *  long sentence ellipses instead of eating the canvas. Height never changes. */
export const RAIL_MIN_WIDTH = 240;
export const RAIL_MAX_WIDTH = 560;
export const RAIL_HEIGHT = 44;
export const SYNC_STUCK_TIMEOUT_MS = 30_000;
export type SyncSource = 'manual' | 'auto';

/** Edits the relay had to drop because the offline buffer was full. Never hidden: a
 *  lost edit the user is not told about is the one failure this panel must not have. */
export function droppedNote(frames: number): string {
  return `${frames} edit${frames === 1 ? '' : 's'} lost while offline`;
}

export type ConnectionTrouble = 'probe-timeout' | 'connection-lost' | 'never-connected';

/** The three connection states worth spending the single rail line on. Every other state
 *  (connected, connecting, an early probe after a healthy session) is carried by the orb
 *  and its tooltip, so the line stays free for the work the user asked for. */
export function connectionTrouble(
  state: ConnectionState,
  ageMs: number,
  hadConnection: boolean,
): ConnectionTrouble | null {
  if (state === 'probing' && ageMs >= 10_000) return 'probe-timeout';
  if (state === 'disconnected' && hadConnection) return 'connection-lost';
  if (showOnboarding(state, hadConnection)) return 'never-connected';
  return null;
}

const TROUBLE_SENTENCE: Record<ConnectionTrouble, { text: string; tone: Tone }> = {
  'probe-timeout': { text: 'Broker not running — run figma-agent status.', tone: 'warning' },
  'connection-lost': { text: 'Connection lost — reconnecting.', tone: 'muted' },
  // The first-run guidance the removed onboarding card used to carry, said in one line.
  'never-connected': { text: 'Not connected — your first command starts the broker.', tone: 'muted' },
};

export interface RailLayer { text: string; tone: Tone }
export interface RailSentenceInput {
  state: ConnectionState;
  ageMs: number;
  hadConnection: boolean;
  droppedFrames?: number;
  /** Pending count, "Syncing", or the result of the last sync. */
  sync?: RailLayer | null;
  /** The current activity's own sentence. */
  activity?: RailLayer | null;
}
/** The line split where the row is allowed to break it. `lead` is the lost-edit note (empty
 *  when nothing was lost) and never shrinks; `rest` is everything ranked below it, separator
 *  included, and is the only half the ellipsis may reach. `text === lead + rest`, always. */
export interface RailSentence { lead: string; rest: string; text: string; tone: Tone; title: string }

function layerOf(layer: RailLayer | null | undefined): RailLayer | null {
  if (!layer) return null;
  const text = layer.text.trim();
  return text ? { text, tone: layer.tone } : null;
}

/** The whole panel in one line. Strict priority — the edits the relay lost, then connection
 *  trouble, then sync, then the current activity, then 'Idle' — with two rules the row may
 *  never break: a lost edit is never hidden (it leads the line, so the row's ellipsis can
 *  only ever cut what ranks below it), and whatever the line had no room for is still
 *  readable in `title`, never dropped. */
export function railSentence(input: RailSentenceInput): RailSentence {
  const raw = input.droppedFrames;
  const dropped = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
  const trouble = connectionTrouble(input.state, input.ageMs, input.hadConnection);
  const layers: RailLayer[] = [];
  if (dropped > 0) layers.push({ text: droppedNote(dropped), tone: 'warning' });
  if (trouble) layers.push(TROUBLE_SENTENCE[trouble]);
  const sync = layerOf(input.sync);
  if (sync) layers.push(sync);
  const activity = layerOf(input.activity);
  if (activity) layers.push(activity);
  if (layers.length === 0) return { lead: '', rest: 'Idle', text: 'Idle', tone: 'muted', title: 'Idle' };
  // Trouble is the one layer that rides along with a lost edit; everything else waits in `title`.
  const shown = layers.slice(0, dropped > 0 && trouble ? 2 : 1);
  const lead = dropped > 0 ? (shown[0]?.text ?? '') : '';
  const tail = shown.slice(lead ? 1 : 0).map((layer) => layer.text).join(' · ');
  const rest = lead && tail ? ` · ${tail}` : tail;
  return {
    lead,
    rest,
    text: `${lead}${rest}`,
    tone: layers[0]?.tone ?? 'muted',
    title: layers.map((layer) => layer.text).join(' · '),
  };
}

/** Whatever the iframe measured is a request, not an instruction: main clamps it into the
 *  band and never reads a height off the wire. A fractional content width rounds UP —
 *  rounding down clips the last pixel of the sentence and fires the ellipsis. */
export function clampRailWidth(requested: unknown): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return RAIL_MIN_WIDTH;
  return Math.min(RAIL_MAX_WIDTH, Math.max(RAIL_MIN_WIDTH, Math.ceil(requested)));
}

/** The only viewport message main accepts. Anything else resizes nothing. */
export function resolveViewportRequest(message: unknown): { width: number; height: number } | null {
  const request = message as { type?: unknown; mode?: unknown; width?: unknown } | null;
  if (!request || typeof request !== 'object') return null;
  if (request.type !== 'PANEL_VIEWPORT' || request.mode !== 'hug') return null;
  return { width: clampRailWidth(request.width), height: RAIL_HEIGHT };
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

export function fileNote(count: number, active: boolean, pinned = false): string {
  if (count <= 1) return active ? (pinned ? 'pinned target' : 'command target') : '';
  const others = count - 1;
  const files = others === 1 ? 'file' : 'files';
  if (!active) return `${others} other ${files} — commands go elsewhere`;
  return pinned ? `pinned target · ${others} other ${files}` : `command target · ${others} other ${files}`;
}

export function targetButtonLabel(pinned: boolean): string { return pinned ? 'Targeted' : 'Target this plugin'; }

/** The row's text is the acknowledgement control, so its tooltip has to say so — the chip
 *  alone cannot explain what clicking does. Only ever appended while a failure is unresolved. */
export function acknowledgeHint(count: number): string {
  const value = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  return `click to mark ${value} unresolved failure${value === 1 ? '' : 's'} as seen`;
}

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
