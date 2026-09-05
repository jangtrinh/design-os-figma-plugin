// Opaque-origin HTML renderer. The child owns its DOM; the panel receives one bounded result.
import type { FigmaExportPayload } from '../../../shared/figma-payload-types';
import { validateImportPayload } from '../../../shared/figma-payload-validation';
import { HTML_RENDER_CHANNEL, HTML_RENDER_VERSION, MAX_CHILD_ERROR_LENGTH } from './render-child-protocol';

declare const __HTML_RENDER_CHILD__: string;
const IFRAME_LOAD_TIMEOUT_MS = 10_000;
const RENDER_TIMEOUT_MS = 15_000;
const DEFAULT_RENDER_HEIGHT_PX = 4000;
type ChildReply = { channel?: unknown; version?: unknown; renderId?: unknown; type?: unknown; payload?: unknown; error?: unknown };
const randomId = (): string => typeof crypto?.randomUUID === 'function' ? crypto.randomUUID() : `render_${Date.now()}_${Math.random().toString(36).slice(2)}`;

function escapedChildSource(): string {
  if (typeof __HTML_RENDER_CHILD__ !== 'string' || __HTML_RENDER_CHILD__ === '') throw new Error('HTML renderer child bundle is unavailable');
  return __HTML_RENDER_CHILD__.replace(/<\/script/gi, '<\\/script');
}

export async function renderHtmlToPayload(html: string, width: number, name: string): Promise<FigmaExportPayload> {
  if (!html || typeof html !== 'string') throw new Error('renderHtmlToPayload: html must be a non-empty string');
  const childSource = escapedChildSource();
  const iframe = document.createElement('iframe');
  const renderId = randomId();
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.setAttribute('aria-hidden', 'true');
  Object.assign(iframe.style, { position: 'fixed', left: '0', top: '0', opacity: '0', pointerEvents: 'none', width: `${width}px`, height: `${DEFAULT_RENDER_HEIGHT_PX}px`, border: '0' });

  return new Promise<FigmaExportPayload>((resolve, reject) => {
    let settled = false;
    let requested = false;
    let loadAttached = false;
    let messageAttached = false;
    let loadTimer: ReturnType<typeof setTimeout> | null = null;
    let renderTimer: ReturnType<typeof setTimeout> | null = null;
    const clearLoad = () => {
      if (loadTimer !== null) { clearTimeout(loadTimer); loadTimer = null; }
      if (loadAttached) { iframe.removeEventListener('load', onLoad); loadAttached = false; }
    };
    const finish = (value?: FigmaExportPayload, error?: Error) => {
      if (settled) return;
      settled = true;
      clearLoad();
      if (renderTimer !== null) { clearTimeout(renderTimer); renderTimer = null; }
      if (messageAttached) { window.removeEventListener('message', receive); messageAttached = false; }
      iframe.remove();
      if (error) { error.message = error.message.slice(0, MAX_CHILD_ERROR_LENGTH); reject(error); }
      else resolve(value!);
    };
    const receive = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow || event.origin !== 'null') return;
      const reply = event.data as ChildReply | null;
      if (!reply || reply.channel !== HTML_RENDER_CHANNEL || reply.version !== HTML_RENDER_VERSION || reply.renderId !== renderId) return;
      if (reply.type === 'result') {
        try { finish(validateImportPayload({ payload: reply.payload }).payload); }
        catch (error) { finish(undefined, error instanceof Error ? error : new Error('HTML renderer returned invalid payload')); }
      } else if (reply.type === 'error') {
        finish(undefined, new Error(typeof reply.error === 'string' ? reply.error.slice(0, MAX_CHILD_ERROR_LENGTH) : 'HTML renderer failed'));
      }
    };
    const onLoad = () => {
      if (settled || requested) return;
      requested = true;
      clearLoad();
      try {
        if (!iframe.contentWindow) throw new Error('HTML renderer window is unavailable');
        iframe.contentWindow.postMessage({ channel: HTML_RENDER_CHANNEL, version: HTML_RENDER_VERSION, renderId, type: 'render', width, name }, '*');
      } catch (error) {
        finish(undefined, error instanceof Error ? error : new Error('HTML renderer request failed'));
      }
    };

    try {
      renderTimer = setTimeout(() => { renderTimer = null; finish(undefined, new Error('HTML renderer timed out')); }, RENDER_TIMEOUT_MS);
      window.addEventListener('message', receive);
      messageAttached = true;
      document.body.appendChild(iframe);
      loadTimer = setTimeout(() => { loadTimer = null; onLoad(); }, IFRAME_LOAD_TIMEOUT_MS);
      iframe.addEventListener('load', onLoad);
      loadAttached = true;
      iframe.srcdoc = `${html}<script>${childSource}</script>`;
    } catch (error) {
      finish(undefined, error instanceof Error ? error : new Error('HTML renderer setup failed'));
    }
  });
}
