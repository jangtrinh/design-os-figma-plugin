// Opaque ShaderGradient host: the sandboxed child owns WebGL; the panel accepts one
// correlated, bounded PNG and never reads the child DOM.
import type { ShaderGradientProps } from '../../../shared/shader-gradient-presets';
import {
  decodeGradientPngDataUrl,
  GradientImageAdmissionError,
  validateGradientDimensions,
} from '../../../shared/gradient-image-admission';
import { buildRenderDocument } from './gradient-render-document';
import {
  boundedGradientErrorCode,
  boundedGradientErrorMessage,
  isGradientRenderReply,
} from './gradient-render-protocol';

const IFRAME_LOAD_TIMEOUT_MS = 15_000;
const RENDER_TIMEOUT_MS = 45_000;
const randomRenderId = (): string => typeof globalThis.crypto?.randomUUID === 'function'
  ? globalThis.crypto.randomUUID()
  : `gradient_${Date.now()}_${Math.random().toString(36).slice(2)}`;

export interface GradientRenderRequest {
  readonly props: ShaderGradientProps;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly staticFrame: boolean;
}

export class GradientRenderError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(boundedGradientErrorMessage(message));
    this.code = boundedGradientErrorCode(code);
    this.name = 'GradientRenderError';
  }
}

export { buildRenderDocument } from './gradient-render-document';

/** Decode and admit the exact PNG representation emitted by canvas.toDataURL. */
export function decodePngDataUrl(
  dataUrl: unknown,
  expected?: { width: number; height: number },
): Uint8Array {
  try { return decodeGradientPngDataUrl(dataUrl, expected); }
  catch (error) {
    if (error instanceof GradientImageAdmissionError) {
      throw new GradientRenderError('E_INVALID_IMAGE', error.message);
    }
    throw error;
  }
}

/** Render one gradient in an opaque child and return an admitted PNG. */
export async function renderGradientToPng(req: GradientRenderRequest): Promise<Uint8Array> {
  let size: { width: number; height: number };
  try { size = validateGradientDimensions(req.width, req.height, req.scale); }
  catch (error) {
    const message = error instanceof Error ? error.message : 'gradient bake dimensions are invalid';
    throw new GradientRenderError('E_INVALID_ARGS', message);
  }
  const renderId = randomRenderId();
  let source: string;
  try { source = buildRenderDocument(req, renderId); }
  catch (error) {
    throw new GradientRenderError(
      'E_RENDER_SETUP',
      error instanceof Error ? error.message : 'gradient renderer document setup failed',
    );
  }
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.setAttribute('aria-hidden', 'true');
  Object.assign(iframe.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    opacity: '0',
    pointerEvents: 'none',
    width: `${size.width}px`,
    height: `${size.height}px`,
    border: '0',
  });

  return new Promise<Uint8Array>((resolve, reject) => {
    let settled = false;
    let loadAttached = false;
    let messageAttached = false;
    let loadTimer: ReturnType<typeof setTimeout> | null = null;
    let renderTimer: ReturnType<typeof setTimeout> | null = null;
    const clearLoad = (): void => {
      if (loadTimer !== null) { clearTimeout(loadTimer); loadTimer = null; }
      if (loadAttached) { iframe.removeEventListener('load', onLoad); loadAttached = false; }
    };
    const finish = (bytes?: Uint8Array, error?: GradientRenderError): void => {
      if (settled) return;
      settled = true;
      clearLoad();
      if (renderTimer !== null) { clearTimeout(renderTimer); renderTimer = null; }
      if (messageAttached) { window.removeEventListener('message', receive); messageAttached = false; }
      iframe.remove();
      if (error) reject(error);
      else resolve(bytes!);
    };
    const onLoad = (): void => clearLoad();
    const receive = (event: MessageEvent): void => {
      if (event.source !== iframe.contentWindow || event.origin !== 'null') return;
      if (!isGradientRenderReply(event.data, renderId)) return;
      if (event.data.type === 'error') {
        finish(undefined, new GradientRenderError(
          boundedGradientErrorCode(event.data.code),
          boundedGradientErrorMessage(event.data.message),
        ));
        return;
      }
      try { finish(decodePngDataUrl(event.data.dataUrl, size)); }
      catch (error) {
        finish(undefined, error instanceof GradientRenderError
          ? error
          : new GradientRenderError('E_INVALID_IMAGE', 'gradient renderer returned invalid image data'));
      }
    };

    try {
      renderTimer = setTimeout(() => {
        renderTimer = null;
        finish(undefined, new GradientRenderError('E_TIMEOUT', `gradient render exceeded ${RENDER_TIMEOUT_MS}ms`));
      }, RENDER_TIMEOUT_MS);
      window.addEventListener('message', receive);
      messageAttached = true;
      loadTimer = setTimeout(() => {
        loadTimer = null;
        finish(undefined, new GradientRenderError('E_IFRAME_LOAD', 'the render iframe never loaded'));
      }, IFRAME_LOAD_TIMEOUT_MS);
      iframe.addEventListener('load', onLoad);
      loadAttached = true;
      iframe.srcdoc = source;
      document.body.appendChild(iframe);
    } catch (error) {
      finish(undefined, error instanceof GradientRenderError
        ? error
        : new GradientRenderError('E_RENDER_SETUP', error instanceof Error ? error.message : 'gradient renderer setup failed'));
    }
  });
}
