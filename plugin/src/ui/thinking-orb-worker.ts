import type { OrbPresentation } from './thinking-orb';
import { paintThinkingOrb } from './thinking-orb-painter';

interface OrbWorkerState {
  canvas: OffscreenCanvas;
  presentation: OrbPresentation;
  dark: boolean;
  dpr: number;
  hidden: boolean;
  reducedMotion: boolean;
}

type OrbWorkerMessage =
  | ({ type: 'init' } & OrbWorkerState)
  | ({ type: 'update' } & Omit<OrbWorkerState, 'canvas'>);

let state: OrbWorkerState | null = null;
let context: OffscreenCanvasRenderingContext2D | null = null;
let frameId: number | null = null;
let announcedReady = false;

function isAnimated(): boolean {
  return Boolean(state && !state.presentation.paused && !state.hidden && !state.reducedMotion);
}

function stop(): void {
  if (frameId === null) return;
  cancelAnimationFrame(frameId);
  frameId = null;
}

function paint(now: number): void {
  if (!state || !context) return;
  paintThinkingOrb(state.canvas, context, state.presentation, now, state.dark, isAnimated(), state.dpr);
  if (!announcedReady) {
    announcedReady = true;
    self.postMessage({ type: 'ready' });
  }
}

function schedule(): void {
  if (!isAnimated() || frameId !== null) return;
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

self.onmessage = (event: MessageEvent<OrbWorkerMessage>): void => {
  const message = event.data;
  if (message.type === 'init') {
    state = message;
    context = message.canvas.getContext('2d');
  } else if (state) {
    state = { ...state, ...message };
  }
  refresh();
};
