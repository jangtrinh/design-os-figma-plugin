export const GRADIENT_RENDER_CHANNEL = 'design-os-gradient-render-v1';
export const GRADIENT_RENDER_VERSION = 1;
export const MAX_GRADIENT_ERROR_CODE_LENGTH = 64;
export const MAX_GRADIENT_ERROR_MESSAGE_LENGTH = 512;

export type GradientRenderReply = {
  channel?: unknown;
  version?: unknown;
  renderId?: unknown;
  type?: unknown;
  dataUrl?: unknown;
  code?: unknown;
  message?: unknown;
};

export function isGradientRenderReply(value: unknown, renderId: string): value is GradientRenderReply {
  const reply = value as GradientRenderReply | null;
  return !!reply
    && reply.channel === GRADIENT_RENDER_CHANNEL
    && reply.version === GRADIENT_RENDER_VERSION
    && reply.renderId === renderId
    && (reply.type === 'result' || reply.type === 'error');
}

export function boundedGradientErrorCode(value: unknown): string {
  return typeof value === 'string' && value !== ''
    ? value.slice(0, MAX_GRADIENT_ERROR_CODE_LENGTH)
    : 'E_RENDER_FAILED';
}

export function boundedGradientErrorMessage(value: unknown): string {
  return typeof value === 'string' && value !== ''
    ? value.slice(0, MAX_GRADIENT_ERROR_MESSAGE_LENGTH)
    : 'gradient render failed';
}
