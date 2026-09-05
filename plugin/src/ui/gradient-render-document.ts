import type { GradientRenderRequest } from './gradient-host';
import { validateGradientDimensions } from '../../../shared/gradient-image-admission';
import {
  GRADIENT_RENDER_CHANNEL,
  GRADIENT_RENDER_VERSION,
  MAX_GRADIENT_ERROR_CODE_LENGTH,
  MAX_GRADIENT_ERROR_MESSAGE_LENGTH,
} from './gradient-render-protocol';

const RENDERER_VERSION = '2.4.20';
const CDN_BASE = 'https://esm.sh';
const REACT_VERSION = '18.3.1';
const DEPS = `react@${REACT_VERSION},react-dom@${REACT_VERSION},three@0.169.0,@react-three/fiber@8.17.10`;
const SETTLE_FRAMES = 8;

function serializeInline(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => {
    switch (character) {
      case '<': return '\\u003c';
      case '>': return '\\u003e';
      case '&': return '\\u0026';
      case '\u2028': return '\\u2028';
      default: return '\\u2029';
    }
  });
}

/** The complete opaque child document, exported for the network verifier. */
export function buildRenderDocument(req: GradientRenderRequest, renderId: string): string {
  const size = validateGradientDimensions(req.width, req.height, req.scale);
  const config = serializeInline({
    props: req.props,
    staticFrame: req.staticFrame,
    settle: SETTLE_FRAMES,
  });

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:transparent;overflow:hidden}
  #stage{width:${size.width}px;height:${size.height}px}
</style></head>
<body><div id="stage"></div>
<script type="module">
const CHANNEL = ${serializeInline(GRADIENT_RENDER_CHANNEL)};
const VERSION = ${GRADIENT_RENDER_VERSION};
const RENDER_ID = ${serializeInline(renderId)};
const CFG = ${config};
let terminal = false;
const send = (message) => {
  if (terminal) return;
  terminal = true;
  parent.postMessage({ channel: CHANNEL, version: VERSION, renderId: RENDER_ID, ...message }, '*');
};
const fail = (code, message) => send({
  type: 'error',
  code: String(code || 'E_RENDER_FAILED').slice(0, ${MAX_GRADIENT_ERROR_CODE_LENGTH}),
  message: String(message || 'gradient render failed').slice(0, ${MAX_GRADIENT_ERROR_MESSAGE_LENGTH}),
});

window.addEventListener('error', (event) => fail('E_RENDER_SCRIPT', event.message || 'render script error'));
window.addEventListener('unhandledrejection', (event) => fail(
  'E_RENDER_SCRIPT',
  (event.reason && event.reason.message) || 'render promise rejected',
));

(async () => {
  try {
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl2') || probe.getContext('webgl');
    if (!gl) { fail('E_NO_WEBGL', 'this environment provides no WebGL context'); return; }

    const [React, ReactDOMClient, SG] = await Promise.all([
      import(${serializeInline(`${CDN_BASE}/react@${REACT_VERSION}`)}),
      import(${serializeInline(`${CDN_BASE}/react-dom@${REACT_VERSION}/client?deps=react@${REACT_VERSION}`)}),
      import(${serializeInline(`${CDN_BASE}/@shadergradient/react@${RENDERER_VERSION}?deps=${DEPS}`)}),
    ]);
    const { ShaderGradientCanvas, ShaderGradient } = SG;
    if (!ShaderGradientCanvas || !ShaderGradient) {
      fail('E_RENDERER_SHAPE', 'the pinned renderer did not export ShaderGradientCanvas/ShaderGradient');
      return;
    }

    const props = { ...CFG.props };
    if (CFG.staticFrame) props.animate = 'off';
    const element = React.createElement(
      ShaderGradientCanvas,
      {
        style: { width: '100%', height: '100%' },
        pixelDensity: 1,
        fov: props.fov,
        preserveDrawingBuffer: true,
        lazyLoad: false,
      },
      React.createElement(ShaderGradient, props),
    );
    ReactDOMClient.createRoot(document.getElementById('stage')).render(element);

    await new Promise((resolve) => {
      let frames = 0;
      const tick = () => { if (++frames >= CFG.settle) resolve(); else requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
    const canvas = document.querySelector('#stage canvas');
    if (!canvas) { fail('E_NO_CANVAS', 'the renderer mounted no canvas'); return; }
    const dataUrl = canvas.toDataURL('image/png');
    if (!dataUrl) { fail('E_EMPTY_CAPTURE', 'the captured frame was empty'); return; }
    send({ type: 'result', dataUrl });
  } catch (error) {
    fail('E_RENDER_FAILED', (error && error.message) || error);
  }
})();
</script></body></html>`;
}
