import type { ConnectionState } from '../../../shared/protocol';
import { MODE_DRAWS, resolvePreset, type OrbState } from 'thinking-orbs/engine';

const ORB_SIZE = 20;
const STATIC_TIME = 0.75;

export interface OrbSignals {
  connection: ConnectionState;
  connectionFailure: boolean;
  syncFailure: boolean;
  activityFailure: boolean;
  activityPending: boolean;
  syncPending: boolean;
}

export interface OrbPresentation {
  state: OrbState;
  paused: boolean;
  dimmed: boolean;
  status: 'Connected' | 'Processing' | 'Connecting' | 'Disconnected' | 'Needs attention';
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
  if (signals.activityPending || signals.syncPending) {
    return { state: 'working', paused: false, dimmed: false, status: 'Processing' };
  }
  return { state: 'breathing', paused: false, dimmed: false, status: 'Connected' };
}

export interface ThinkingOrbController {
  update(presentation: OrbPresentation): void;
  dispose(): void;
}

export function mountThinkingOrb(target: HTMLElement): ThinkingOrbController {
  const canvas = document.createElement('canvas');
  canvas.className = 'thinking-orb';
  canvas.setAttribute('aria-hidden', 'true');
  target.append(canvas);

  const context = canvas.getContext('2d');
  if (!context) {
    canvas.remove();
    return { update: () => {}, dispose: () => {} };
  }
  const drawingContext: CanvasRenderingContext2D = context;

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let presentation = orbPresentation({
    connection: 'disconnected', connectionFailure: false, syncFailure: false,
    activityFailure: false, activityPending: false, syncPending: false,
  });
  canvas.dataset.dimmed = String(presentation.dimmed);
  let frameId: number | null = null;
  let disposed = false;

  const isDark = (): boolean => !document.documentElement.classList.contains('figma-light');
  const isAnimated = (): boolean => !presentation.paused && !reducedMotion.matches && !document.hidden;

  function prepareCanvas(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pixels = Math.round(ORB_SIZE * dpr);
    if (canvas.width !== pixels || canvas.height !== pixels) {
      canvas.width = pixels;
      canvas.height = pixels;
    }
    drawingContext.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function paint(now: number): void {
    prepareCanvas();
    drawingContext.clearRect(0, 0, ORB_SIZE, ORB_SIZE);
    const preset = resolvePreset(presentation.state, ORB_SIZE);
    const time = isAnimated() ? now / 1000 * preset.speed : STATIC_TIME * preset.speed;
    MODE_DRAWS[preset.mode](drawingContext, ORB_SIZE, time, isDark(), preset.opts);
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
