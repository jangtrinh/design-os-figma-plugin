import type { ConnectionState } from '../../../shared/protocol';
import type { OrbState } from 'thinking-orbs/engine';
import { commandOrbPresentation } from './orb-command-state';
import { paintThinkingOrb } from './thinking-orb-painter';
import { mountThinkingOrbWorker } from './thinking-orb-worker-host';

declare const __THINKING_ORB_WORKER__: string;

export interface OrbSignals {
  connection: ConnectionState;
  connectionFailure: boolean;
  syncFailure: boolean;
  activityFailure: boolean;
  pendingTools: readonly string[];
  syncPending: boolean;
}

export interface OrbPresentation {
  state: OrbState;
  paused: boolean;
  dimmed: boolean;
  status: string;
}

export function orbPresentation(signals: OrbSignals): OrbPresentation {
  if (signals.connectionFailure || signals.syncFailure || signals.activityFailure) {
    return { state: 'shaping', paused: true, dimmed: false, status: 'Needs attention' };
  }
  if (signals.connection === 'probing' || signals.connection === 'handshake') {
    return { state: 'connecting', paused: false, dimmed: false, status: 'Connecting' };
  }
  if (signals.connection === 'disconnected') {
    return { state: 'connecting', paused: true, dimmed: true, status: 'Disconnected' };
  }
  const syncRepresented = signals.pendingTools.includes('RECONCILE');
  const pendingCount = signals.pendingTools.length + (signals.syncPending && !syncRepresented ? 1 : 0);
  if (pendingCount >= 2) {
    return { state: 'weaving', paused: false, dimmed: false, status: `${pendingCount} tasks running` };
  }
  if (signals.syncPending) {
    return { state: 'weaving', paused: false, dimmed: false, status: 'Syncing' };
  }
  if (signals.pendingTools.length === 1) {
    return { ...commandOrbPresentation(signals.pendingTools[0] ?? ''), paused: false, dimmed: false };
  }
  return { state: 'breathing', paused: false, dimmed: false, status: 'Connected' };
}

export interface ThinkingOrbController {
  update(presentation: OrbPresentation): void;
  dispose(): void;
}

interface ThinkingOrbOptions {
  workerSource?: string;
}

function bundledWorkerSource(): string {
  return typeof __THINKING_ORB_WORKER__ === 'string' ? __THINKING_ORB_WORKER__ : '';
}

export function mountThinkingOrb(
  target: HTMLElement,
  options: ThinkingOrbOptions = {},
): ThinkingOrbController {
  const canvas = document.createElement('canvas');
  canvas.className = 'thinking-orb';
  canvas.setAttribute('aria-hidden', 'true');
  target.append(canvas);

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let presentation = orbPresentation({
    connection: 'disconnected', connectionFailure: false, syncFailure: false,
    activityFailure: false, pendingTools: [], syncPending: false,
  });
  canvas.dataset.dimmed = String(presentation.dimmed);
  const isDark = (): boolean => !document.documentElement.classList.contains('figma-light');
  const workerSource = options.workerSource ?? bundledWorkerSource();
  const workerController = mountThinkingOrbWorker({
    canvas, source: workerSource, reducedMotion,
    getPresentation: () => presentation,
    setPresentation: (next) => { presentation = next; },
    isDark,
    mountFallback: () => mountThinkingOrb(target, { workerSource: '' }),
  });
  if (workerController) return workerController;

  const context = canvas.getContext('2d');
  if (!context) {
    canvas.remove();
    return { update: () => {}, dispose: () => {} };
  }
  const drawingContext = context;
  let frameId: number | null = null;
  let disposed = false;
  const isAnimated = (): boolean => !presentation.paused && !reducedMotion.matches && !document.hidden;

  function paint(now: number): void {
    paintThinkingOrb(canvas, drawingContext, presentation, now, isDark(), isAnimated(), window.devicePixelRatio || 1);
  }

  function stop(): void {
    if (frameId === null) return;
    cancelAnimationFrame(frameId);
    frameId = null;
  }

  function schedule(): void {
    if (disposed || !isAnimated() || frameId !== null) return;
    frameId = requestAnimationFrame((now) => {
      frameId = null;
      paint(now);
      schedule();
    });
  }

  function refresh(): void {
    stop();
    paint(performance.now());
    schedule();
  }

  const onVisibilityChange = (): void => refresh();
  const onMotionChange = (): void => refresh();
  document.addEventListener('visibilitychange', onVisibilityChange);
  reducedMotion.addEventListener('change', onMotionChange);
  const themeObserver = new MutationObserver(refresh);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

  refresh();
  return {
    update(next): void {
      if (next.state === presentation.state && next.paused === presentation.paused
          && next.dimmed === presentation.dimmed && next.status === presentation.status) return;
      presentation = next;
      canvas.dataset.dimmed = String(next.dimmed);
      refresh();
    },
    dispose(): void {
      disposed = true;
      stop();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      reducedMotion.removeEventListener('change', onMotionChange);
      themeObserver.disconnect();
      canvas.remove();
    },
  };
}
