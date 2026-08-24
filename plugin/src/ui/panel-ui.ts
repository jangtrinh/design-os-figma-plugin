import { PORT_RANGE_START } from '../../../shared/protocol';
import type { ConnectionState, ConnectionStatePayload } from '../../../shared/protocol';
import { toActivityRecord, toActivityResult } from './activity-feed';
import { ActivityView, labelControl, replaceIcon } from './panel-activity-view';
import {
  fileNote, showOnboarding, statusSentence, syncNowLabel, syncPromptLabel,
  syncResultLabel, syncResultSentence, syncStartSentence, syncStuckSentence,
  syncSupersededSentence, targetButtonLabel, shouldClearPendingCount,
  SYNC_STUCK_TIMEOUT_MS, type ViewportMode,
} from './panel-model';
import { BoundedKeySet, connectionForce } from './panel-view-state';

declare const __BUILD_ID__: string;
const el = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;
const btn = (id: string): HTMLButtonElement => el(id) as HTMLButtonElement;
const panel = el('fga-panel');
const inspector = el('fga-inspector');
const connectionBtn = btn('fga-connection-btn');
const currentBtn = btn('fga-current-btn');
const targetRailBtn = btn('fga-target-rail-btn');
const syncRailBtn = btn('fga-sync-rail-btn');
const syncBadge = el('fga-sync-badge');
const toggleBtn = btn('fga-toggle-btn');
const sentence = el('fga-sentence');
const onboarding = el('fga-onboarding');
const syncPrompt = el('fga-sync');
const syncMsg = el('fga-sync-msg');
const syncNowBtn = btn('fga-sync-now');
const targetBtn = btn('fga-target-btn');
const activityView = new ActivityView(el('fga-activity'), currentBtn, el('fga-current-label'), el('fga-failure-count'));
type Tab = 'activity' | 'context' | 'details';
const tabNames: Tab[] = ['activity', 'context', 'details'];
const tabs = Object.fromEntries(tabNames.map((name) => [name, btn(`fga-tab-${name}`)])) as Record<Tab, HTMLButtonElement>;
const tabPanels = Object.fromEntries(tabNames.map((name) => [name, el(`fga-panel-${name}`)])) as Record<Tab, HTMLElement>;

let payload: ConnectionStatePayload | null = null;
let hadConnection = false;
let sceneFile = '', scenePage = '', selectionName: string | null = null, selectionCount = 0;
let peersCount = 1, peersIsActiveTarget = true, peersPinned = false, pendingSyncCount = 0;
let selectedTab: Tab = 'activity', inspectorOpen = false, userExpanded = false, forcedOnly = false;
let connectionFailure = false, syncFailure = false, connectionTransition = 0;
let previousConnectionState: ConnectionState | null = null;
const disclosed = new BoundedKeySet();

function viewport(mode: ViewportMode): void { parent.postMessage({ pluginMessage: { type: 'PANEL_VIEWPORT', mode } }, '*'); }
function selectTab(tab: Tab, focus = false): void {
  selectedTab = tab;
  for (const name of tabNames) {
    const selected = name === tab;
    tabs[name].setAttribute('aria-selected', String(selected));
    tabs[name].tabIndex = selected ? 0 : -1;
    tabPanels[name].hidden = !selected;
  }
  if (focus) tabs[tab].focus();
}
function setInspector(open: boolean, tab = selectedTab, intent = false): void {
  inspectorOpen = open;
  if (intent) { userExpanded = open; forcedOnly = false; }
  panel.dataset.view = open ? 'inspector' : 'rail';
  inspector.hidden = !open;
  toggleBtn.setAttribute('aria-expanded', String(open));
  labelControl(toggleBtn, open ? 'Close inspector' : 'Open inspector');
  replaceIcon(toggleBtn, open ? 'chevron-up' : 'chevron-down');
  if (open) selectTab(tab);
  viewport(open ? 'inspector' : 'rail');
}
function forceOnce(key: string, tab: Tab): void {
  if (disclosed.has(key)) return;
  disclosed.add(key);
  if (!userExpanded) forcedOnly = true;
  setInspector(true, tab);
}
function unresolved(): boolean { return connectionFailure || syncFailure || activityView.failures.unresolvedCount > 0; }
function updateSignal(): void { panel.dataset.unresolved = String(unresolved()); }
function acknowledgeActivity(): void { activityView.acknowledgeFailures(); updateSignal(); activityView.render(); }
function openUser(tab: Tab): void { if (tab === 'activity') acknowledgeActivity(); setInspector(true, tab, true); }
function context(): void {
  el('fga-ctx-file').textContent = sceneFile || '—'; el('fga-ctx-file').title = sceneFile;
  el('fga-ctx-file-note').textContent = fileNote(peersCount, peersIsActiveTarget, peersPinned);
  el('fga-ctx-page').textContent = scenePage || '—'; el('fga-ctx-page').title = scenePage;
  el('fga-ctx-selection').textContent = selectionCount <= 0 ? 'None' : `${selectionName ?? '(unnamed)'}${selectionCount > 1 ? ` +${selectionCount - 1} more` : ''}`;
  targetBtn.textContent = targetButtonLabel(peersPinned);
  targetRailBtn.hidden = peersCount <= 1;
  if (!targetRailBtn.hidden) {
    labelControl(targetRailBtn, `${peersCount} files. ${fileNote(peersCount, peersIsActiveTarget, peersPinned)}`);
    replaceIcon(targetRailBtn, peersPinned ? 'pin' : 'files');
    targetRailBtn.classList.toggle('tone-info', peersIsActiveTarget);
  }
}
function render(): void {
  const now = Date.now(), state: ConnectionState = payload?.state ?? 'disconnected', age = payload ? now - payload.since : 0;
  const view = statusSentence(state, age, hadConnection);
  sentence.textContent = view.text; sentence.dataset.tone = view.tone;
  onboarding.hidden = !showOnboarding(state, hadConnection);
  replaceIcon(connectionBtn, state === 'connected' ? 'circle-check' : state === 'probing' || state === 'handshake' ? 'loader-circle' : 'circle-off', state === 'probing' || state === 'handshake');
  connectionBtn.className = `rail-control tone-${view.tone}`; labelControl(connectionBtn, view.text);
  context(); activityView.render(now);
  const showSync = pendingSyncCount > 0 || syncFailure;
  syncRailBtn.hidden = !showSync;
  if (showSync) { syncBadge.textContent = String(Math.max(1, pendingSyncCount)); replaceIcon(syncRailBtn, syncFailure ? 'circle-x' : 'refresh-cw'); syncRailBtn.className = `rail-control tone-${syncFailure ? 'danger' : 'warning'}`; labelControl(syncRailBtn, syncFailure ? `${syncMsg.textContent || 'Sync failed'}. Open sync actions` : `${syncPromptLabel(pendingSyncCount)}. Open sync actions`); }
  const force = connectionForce(state, age, hadConnection, connectionTransition);
  connectionFailure = force?.kind === 'probe-timeout' || force?.kind === 'connection-lost';
  updateSignal(); if (force) forceOnce(force.key, 'details');
  if (state === 'connected' && forcedOnly && !userExpanded && !unresolved()) { forcedOnly = false; setInspector(false); }
}

connectionBtn.onclick = () => setInspector(true, 'details', true);
currentBtn.onclick = () => openUser('activity');
const toggleTarget = (): void => { try { window.dispatchEvent(new CustomEvent(peersPinned ? 'figma-agent:clear-target' : 'figma-agent:set-target')); } catch { /* DOM unavailable */ } };
targetRailBtn.onclick = toggleTarget; targetBtn.onclick = toggleTarget;
syncRailBtn.onclick = () => { syncPrompt.hidden = false; openUser('activity'); };
toggleBtn.onclick = () => { if (!inspectorOpen && selectedTab === 'activity') acknowledgeActivity(); setInspector(!inspectorOpen, selectedTab, true); };
for (const tab of tabNames) {
  tabs[tab].onclick = () => { if (tab === 'activity') acknowledgeActivity(); selectTab(tab); };
  tabs[tab].onkeydown = (event) => { const index = tabNames.indexOf(tab); const target = event.key === 'ArrowRight' ? tabNames[(index + 1) % 3] : event.key === 'ArrowLeft' ? tabNames[(index + 2) % 3] : event.key === 'Home' ? tabNames[0] : event.key === 'End' ? tabNames[2] : null; if (target) { event.preventDefault(); if (target === 'activity') acknowledgeActivity(); selectTab(target, true); } };
}
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && inspectorOpen) { event.preventDefault(); setInspector(false, selectedTab, true); toggleBtn.focus(); } });
window.addEventListener('figma-agent:conn-state', (event) => { const next = (event as CustomEvent).detail as ConnectionStatePayload | undefined; if (!next || typeof next.state !== 'string') return; if (next.state !== previousConnectionState) connectionTransition += 1; previousConnectionState = next.state; if (next.state === 'connected') hadConnection = true; payload = next; render(); });
window.addEventListener('figma-agent:activity', (event) => { const detail = (event as CustomEvent).detail as { phase?: unknown } | undefined; if (detail?.phase === 'done') { const patch = toActivityResult(detail); if (!patch) return; activityView.resolve(patch); if (!patch.ok) forceOnce(`activity-failure:${patch.id}`, 'activity'); } else { const record = toActivityRecord(detail); if (!record) return; activityView.push(record); } updateSignal(); render(); });
window.addEventListener('figma-agent:peers', (event) => { const data = (event as CustomEvent).detail as { count?: unknown; isActiveTarget?: unknown; pinned?: unknown } | undefined; if (typeof data?.count === 'number' && Number.isFinite(data.count)) peersCount = data.count; if (typeof data?.isActiveTarget === 'boolean') peersIsActiveTarget = data.isActiveTarget; peersPinned = data?.pinned === true; context(); });
window.addEventListener('message', (event: MessageEvent) => { const message = (event.data as { pluginMessage?: { type?: string; data?: Record<string, unknown> } } | null)?.pluginMessage; if (!message) return; if (message.type === 'IDLE_READY' && message.data) { pendingSyncCount = typeof message.data.count === 'number' ? Math.max(1, Math.floor(message.data.count)) : 1; syncFailure = false; syncMsg.textContent = syncPromptLabel(pendingSyncCount); syncNowBtn.textContent = syncNowLabel(false); syncPrompt.hidden = true; render(); return; } if (message.type === 'FILE_INFO' && message.data) { if (typeof message.data.fileName === 'string') sceneFile = message.data.fileName; if (typeof message.data.page === 'string') scenePage = message.data.page; selectionName = typeof message.data.selectionName === 'string' ? message.data.selectionName : null; selectionCount = typeof message.data.selectionCount === 'number' ? message.data.selectionCount : 0; context(); } });

let run: { id: string; at: number } | null = null, stuckTimer: ReturnType<typeof setTimeout> | null = null;
syncNowBtn.onclick = () => { const at = Date.now(), id = `reconcile_${at}`; syncMsg.textContent = 'Syncing'; if (run) { if (stuckTimer) clearTimeout(stuckTimer); activityView.resolve({ id: run.id, ok: false, ms: at - run.at, sentence: syncSupersededSentence() }, false); } run = { id, at }; activityView.push({ id, tool: 'RECONCILE', label: 'Reconcile · apply', pending: true, ok: true, ms: 0, at, sentence: syncStartSentence('manual', sceneFile || '(unnamed file)') }); render(); try { window.dispatchEvent(new CustomEvent('figma-agent:sync-request')); } catch { /* DOM unavailable */ } stuckTimer = setTimeout(() => { if (run?.id !== id) return; const now = Date.now(); activityView.resolve({ id, ok: false, ms: now - at, sentence: syncStuckSentence() }); run = null; stuckTimer = null; syncFailure = true; syncMsg.textContent = syncStuckSentence(); syncPrompt.hidden = false; forceOnce(`activity-failure:${id}`, 'activity'); render(); }, SYNC_STUCK_TIMEOUT_MS); };
btn('fga-sync-later').onclick = () => { syncPrompt.hidden = true; };
window.addEventListener('figma-agent:sync-result', (event) => { const data = (event as CustomEvent).detail as { ok?: boolean; summary?: string; landed?: boolean; code?: string } | undefined; const unbound = data?.code === 'E_UNBOUND', ok = data?.ok === true, summary = typeof data?.summary === 'string' ? data.summary : '', landed = data?.landed !== false; syncMsg.textContent = syncResultLabel(ok, summary, landed, unbound); syncNowBtn.textContent = syncNowLabel(unbound); const current = run; if (current) { if (stuckTimer) clearTimeout(stuckTimer); activityView.resolve({ id: current.id, ok, ms: Date.now() - current.at, sentence: syncResultSentence(ok, summary, landed, unbound, sceneFile || '(unnamed file)') }); run = null; stuckTimer = null; } const commit = shouldClearPendingCount(ok); parent.postMessage({ pluginMessage: { type: 'SYNC_DONE', commit } }, '*'); syncFailure = !ok; if (commit) pendingSyncCount = 0; syncPrompt.hidden = false; if (!ok) forceOnce(`activity-failure:${current?.id ?? Date.now()}`, 'activity'); if (commit) setTimeout(() => { syncPrompt.hidden = true; render(); }, 4000); render(); });

el('fga-version').textContent = `v0.1.0 · ${typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev'}`;
replaceIcon(targetRailBtn, 'files'); replaceIcon(syncRailBtn, 'refresh-cw'); replaceIcon(toggleBtn, 'chevron-down');
setInterval(render, 1000); render(); void PORT_RANGE_START;
