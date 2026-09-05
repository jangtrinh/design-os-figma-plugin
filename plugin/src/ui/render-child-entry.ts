import { buildPayloadFromDocument, waitForStylesReadyInDocument } from './converter/extract';
import { childError, HTML_RENDER_CHANNEL, HTML_RENDER_VERSION, isRenderRequest } from './render-child-protocol';

window.addEventListener('message', async (event: MessageEvent) => {
  if (event.source !== window.parent) return;
  const request = event.data;
  if (!isRenderRequest(request)) return;
  try {
    await waitForStylesReadyInDocument(document, window);
    const payload = buildPayloadFromDocument(document, window, request.name, request.width);
    window.parent.postMessage({ channel: HTML_RENDER_CHANNEL, version: HTML_RENDER_VERSION, renderId: request.renderId, type: 'result', payload }, '*');
  } catch (error) {
    window.parent.postMessage({ channel: HTML_RENDER_CHANNEL, version: HTML_RENDER_VERSION, renderId: request.renderId, type: 'error', error: childError(error) }, '*');
  }
});
