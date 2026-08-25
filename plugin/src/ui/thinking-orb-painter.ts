import { MODE_DRAWS, resolvePreset } from 'thinking-orbs/engine';
import type { OrbPresentation } from './thinking-orb';

export const ORB_SIZE = 20;
const STATIC_TIME = 0.75;

type OrbContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function paintThinkingOrb(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  context: OrbContext,
  presentation: OrbPresentation,
  now: number,
  dark: boolean,
  animated: boolean,
  dpr: number,
): void {
  const scale = Math.min(2, dpr || 1);
  const pixels = Math.round(ORB_SIZE * scale);
  if (canvas.width !== pixels || canvas.height !== pixels) {
    canvas.width = pixels;
    canvas.height = pixels;
  }
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.clearRect(0, 0, ORB_SIZE, ORB_SIZE);
  const preset = resolvePreset(presentation.state, ORB_SIZE);
  const time = (animated ? now / 1000 : STATIC_TIME) * preset.speed;
  MODE_DRAWS[preset.mode](context as CanvasRenderingContext2D, ORB_SIZE, time, dark, preset.opts);
}
