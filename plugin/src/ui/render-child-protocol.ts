import type { FigmaExportPayload } from '../../../shared/figma-payload-types';

export const HTML_RENDER_CHANNEL = 'design-os-html-render-v1';
export const HTML_RENDER_VERSION = 1;
export const MAX_CHILD_ERROR_LENGTH = 512;

export interface RenderRequest { channel: typeof HTML_RENDER_CHANNEL; version: 1; renderId: string; type: 'render'; width: number; name: string }
export interface RenderResult { channel: typeof HTML_RENDER_CHANNEL; version: 1; renderId: string; type: 'result'; payload: FigmaExportPayload }
export interface RenderError { channel: typeof HTML_RENDER_CHANNEL; version: 1; renderId: string; type: 'error'; error: string }

export function isRenderRequest(value: unknown): value is RenderRequest {
  const v = value as Partial<RenderRequest> | null;
  return !!v && v.channel === HTML_RENDER_CHANNEL && v.version === HTML_RENDER_VERSION && v.type === 'render' && typeof v.renderId === 'string' && typeof v.width === 'number' && Number.isFinite(v.width) && typeof v.name === 'string';
}

export function childError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, MAX_CHILD_ERROR_LENGTH);
}
