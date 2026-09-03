import { PORT_RANGE_START } from '../../../shared/protocol';
import type { ConnectionState, ConnectionStatePayload } from '../../../shared/protocol';
import { toActivityRecord, toActivityResult } from './activity-feed';
import { ActivityView, labelControl, replaceIcon } from './panel-activity-view';
import {
  acknowledgeHint, connectionTrouble, fileNote, railSentence, syncNowLabel, syncPromptLabel,
  syncResultLabel, syncResultSentence, syncStartSentence, syncStuckSentence,
  syncSupersededSentence, shouldClearPendingCount, SYNC_STUCK_TIMEOUT_MS, type RailLayer,
} from './panel-model';
import { mountThinkingOrb, orbPresentation } from './thinking-orb';

declare const __BUILD_ID__: string;
const el = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;
const btn = (id: string): HTMLButtonElement => el(id) as HTMLButtonElement;
const rail = el('fga-rail');
const orbHost = el('fga-orb');
const sentence = btn('fga-sentence');
const sentenceLead = el('fga-sentence-lead');
const sentenceRest = el('fga-sentence-rest');
const targetRailBtn = btn('fga-target-rail-btn');
const syncRailBtn = btn('fga-sync-rail-btn');
const syncBadge = el('fga-sync-badge');
const activityView = new ActivityView(el('fga-failure-count'));
const thinkingOrb = mountThinkingOrb(orbHost);
// The version row went with the inspector; the build identity stays reachable on the orb's
// tooltip (never its accessible name — a screen reader wants the status, not a hash).
const BUILD_LINE = `v0.1.0 · ${typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev'}`;
const SYNC_RESULT_HOLD_MS = 4_000;

let payload: ConnectionStatePayload | null = null;
let hadConnection = false;
let sceneFile = '';
let peersCount = 1, peersIsActiveTarget = true, peersPinned = false;
let pendingSyncCount = 0, syncFailure = false, syncUnbound = false;
let syncLine: RailLayer | null = null;
let syncHoldTimer: ReturnType<typeof setTimeout> | null = null;
let connectionFailure = false;
let droppedFrames = 0; // capture frames the relay lost while the broker socket was down
let lastWidth = 0;

function activityLine(): RailLayer | null {
  const text = activityView.currentSentence();
  if (!text) return null;
  const phase = activityView.railPhase();
  return { text, tone: phase === 'failed' ? 'warning' : phase === 'complete' ? 'success' : 'info' };
}

/** The hug: the row measures what it actually rendered and asks main for that width. Main
 *  owns the band and the height (panel-model.ts's `clampRailWidth`), so an unreasonable
 *  measurement can only ever be clamped, never obeyed. Posted only on a real change, since
 *  the render tick runs every second. */
function hugViewport(): void {
  const width = Math.ceil(rail.getBoundingClientRect().width);
  if (!Number.isFinite(width) || width <= 0 || Math.abs(width - lastWidth) < 1) return;
  lastWidth = width;
  parent.postMessage({ pluginMessage: { type: 'PANEL_VIEWPORT', mode: 'hug', width } }, '*');
}

function renderOrb(): void {
  const orb = orbPresentation({
    connection: payload?.state ?? 'disconnected', connectionFailure, syncFailure,
    activityFailure: activityView.failures.unresolvedCount > 0,
    pendingTools: activityView.pendingTools(),
    syncPending: pendingSyncCount > 0,
  });
  thinkingOrb.update(orb);
  orbHost.title = `${orb.status} · ${BUILD_LINE}`;
  orbHost.setAttribute('aria-label', orb.status);
}

function renderTarget(): void {
  targetRailBtn.hidden = peersCount <= 1;
  if (targetRailBtn.hidden) return;
  labelControl(targetRailBtn, `${peersCount} files. ${fileNote(peersCount, peersIsActiveTarget, peersPinned)}`);
  replaceIcon(targetRailBtn, peersPinned ? 'pin' : 'files');
  targetRailBtn.classList.toggle('tone-info', peersIsActiveTarget);
}

function renderSync(): void {
  const showSync = pendingSyncCount > 0 || syncFailure;
  syncRailBtn.hidden = !showSync;
  if (!showSync) return;
  syncBadge.textContent = String(Math.max(1, pendingSyncCount));
  replaceIcon(syncRailBtn, syncFailure ? 'circle-x' : 'refresh-cw', run !== null);
  syncRailBtn.className = `rail-control tone-${syncFailure ? 'danger' : 'warning'}`;
  const state = syncFailure ? (syncLine?.text ?? 'Sync failed') : syncPromptLabel(pendingSyncCount);
  labelControl(syncRailBtn, `${state}. ${syncNowLabel(syncUnbound)}`);
}

function render(): void {
  const now = Date.now(), state: ConnectionState = payload?.state ?? 'disconnected', age = payload ? now - payload.since : 0;
  const view = railSentence({
    state, ageMs: age, hadConnection, droppedFrames, sync: syncLine, activity: activityLine(),
  });
  // Two spans, because the ellipsis has to cut somewhere: the lead never shrinks, so a lost
  // edit survives at any width and only the tail below it can be cut (panel.html).
  sentenceLead.textContent = view.lead;
  sentenceLead.hidden = view.lead === '';
  sentenceRest.textContent = view.rest;
  sentence.dataset.tone = view.tone;
  sentence.title = view.title;
  const unresolved = activityView.failures.unresolvedCount;
  if (unresolved > 0) sentence.title += ` · ${acknowledgeHint(unresolved)}`;
  activityView.renderBadge();
  renderTarget();
  renderSync();
  const trouble = connectionTrouble(state, age, hadConnection);
  connectionFailure = trouble === 'probe-timeout' || trouble === 'connection-lost';
  renderOrb();
  hugViewport();
}

// Reading the line IS the acknowledgement: one click on the row's own text clears the count
// and the orb's "needs attention". Nothing vanishes — the failure stays in the edit feed and
// in `figma-agent errors` — and the next failure re-arms both.
sentence.onclick = () => { activityView.acknowledgeFailures(); render(); };
const toggleTarget = (): void => { try { window.dispatchEvent(new CustomEvent(peersPinned ? 'figma-agent:clear-target' : 'figma-agent:set-target')); } catch { /* DOM unavailable */ } };
targetRailBtn.onclick = toggleTarget;
window.addEventListener('pagehide', () => thinkingOrb.dispose(), { once: true });
window.addEventListener('figma-agent:conn-state', (event) => { const next = (event as CustomEvent).detail as ConnectionStatePayload | undefined; if (!next || typeof next.state !== 'string') return; if (next.state === 'connected') hadConnection = true; payload = next; render(); });
window.addEventListener('figma-agent:activity', (event) => { const detail = (event as CustomEvent).detail as { phase?: unknown } | undefined; if (detail?.phase === 'done') { const patch = toActivityResult(detail); if (!patch) return; activityView.resolve(patch); } else { const record = toActivityRecord(detail); if (!record) return; activityView.push(record); } render(); });
// Relay drop counter (ui-relay.ts): frames the pre-connect buffer had to evict. Shown
// in the rail sentence for as long as the panel lives — a lost edit does not expire.
window.addEventListener('figma-agent:dropped', (event) => { const detail = (event as CustomEvent).detail as { frames?: unknown } | undefined; if (typeof detail?.frames !== 'number' || !Number.isFinite(detail.frames)) return; droppedFrames = Math.max(droppedFrames, Math.floor(detail.frames)); render(); });
window.addEventListener('figma-agent:peers', (event) => { const data = (event as CustomEvent).detail as { count?: unknown; isActiveTarget?: unknown; pinned?: unknown } | undefined; if (typeof data?.count === 'number' && Number.isFinite(data.count)) peersCount = data.count; if (typeof data?.isActiveTarget === 'boolean') peersIsActiveTarget = data.isActiveTarget; peersPinned = data?.pinned === true; render(); });
window.addEventListener('message', (event: MessageEvent) => { const message = (event.data as { pluginMessage?: { type?: string; data?: Record<string, unknown> } } | null)?.pluginMessage; if (!message) return; if (message.type === 'IDLE_READY' && message.data) { pendingSyncCount = typeof message.data.count === 'number' ? Math.max(1, Math.floor(message.data.count)) : 1; syncFailure = false; syncUnbound = false; syncLine = { text: syncPromptLabel(pendingSyncCount), tone: 'warning' }; render(); return; } if (message.type === 'FILE_INFO' && message.data) { if (typeof message.data.fileName === 'string') sceneFile = message.data.fileName; render(); } });

let run: { id: string; at: number } | null = null, stuckTimer: ReturnType<typeof setTimeout> | null = null;
// The rail button IS the sync now: one click runs it, the sentence carries the outcome, and a
// failure keeps the button on the rail so the retry is the same gesture.
syncRailBtn.onclick = () => {
  const at = Date.now(), id = `reconcile_${at}`;
  if (syncHoldTimer) { clearTimeout(syncHoldTimer); syncHoldTimer = null; }
  syncFailure = false;
  syncLine = { text: 'Syncing', tone: 'info' };
  if (run) { if (stuckTimer) clearTimeout(stuckTimer); activityView.resolve({ id: run.id, ok: false, ms: at - run.at, sentence: syncSupersededSentence() }, false); }
  run = { id, at };
  activityView.push({ id, tool: 'RECONCILE', label: 'Reconcile · apply', pending: true, ok: true, ms: 0, at, sentence: syncStartSentence('manual', sceneFile || '(unnamed file)') });
  render();
  try { window.dispatchEvent(new CustomEvent('figma-agent:sync-request')); } catch { /* DOM unavailable */ }
  stuckTimer = setTimeout(() => { if (run?.id !== id) return; const now = Date.now(); activityView.resolve({ id, ok: false, ms: now - at, sentence: syncStuckSentence() }); run = null; stuckTimer = null; syncFailure = true; syncLine = { text: syncStuckSentence(), tone: 'warning' }; render(); }, SYNC_STUCK_TIMEOUT_MS);
};
window.addEventListener('figma-agent:sync-result', (event) => { const data = (event as CustomEvent).detail as { ok?: boolean; summary?: string; landed?: boolean; code?: string } | undefined; const unbound = data?.code === 'E_UNBOUND', ok = data?.ok === true, summary = typeof data?.summary === 'string' ? data.summary : '', landed = data?.landed !== false; syncUnbound = unbound; syncLine = { text: syncResultLabel(ok, summary, landed, unbound), tone: ok ? 'success' : 'warning' }; const current = run; if (current) { if (stuckTimer) clearTimeout(stuckTimer); activityView.resolve({ id: current.id, ok, ms: Date.now() - current.at, sentence: syncResultSentence(ok, summary, landed, unbound, sceneFile || '(unnamed file)') }); run = null; stuckTimer = null; } const commit = shouldClearPendingCount(ok); parent.postMessage({ pluginMessage: { type: 'SYNC_DONE', commit } }, '*'); syncFailure = !ok; if (commit) { pendingSyncCount = 0; syncHoldTimer = setTimeout(() => { syncHoldTimer = null; syncLine = null; render(); }, SYNC_RESULT_HOLD_MS); } render(); });

replaceIcon(targetRailBtn, 'files'); replaceIcon(syncRailBtn, 'refresh-cw');
setInterval(render, 1000); render(); void PORT_RANGE_START;
