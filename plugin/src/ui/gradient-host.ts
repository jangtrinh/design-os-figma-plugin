// Offscreen ShaderGradient render host: draws one gradient field at a given size in a
// hidden iframe and returns PNG bytes for main to turn into an image fill.
//
// Runs in the plugin UI iframe — pure DOM + WebGL, no Figma Plugin API here. Same shape
// as render-host.ts (HTML_TO_FIGMA), and deliberately so: an offscreen iframe is already
// this repo's proven way to run untrusted-ish rendering without touching the panel.
//
// The renderer is upstream's published ESM, fetched at render time from a CDN the plugin
// manifest ALREADY allows for the html-to-figma iframe. It is not vendored, because
// vendoring three + R3F + the renderer would add roughly a megabyte to a UI bundle that
// is otherwise inlined into the plugin, for a feature most sessions never invoke.
//
// What this file will NOT do: follow upstream's own Figma plugin, which loads its whole
// renderer UI from `shadergradient.co/figma-plugin` in a nested iframe. That makes the
// feature a live dependency on a third party's marketing site — it breaks when their page
// changes, and it sends the user's config off-machine. Pinned package, pinned version,
// loud failure is the trade we take instead.

import type { ShaderGradientProps } from '../../../shared/shader-gradient-presets';

/**
 * Pinned exactly. A range would let a background republish change what a bake produces.
 *
 * This is the PUBLISHED version, which is NOT the version in upstream's package.json at
 * the revision the presets were read from. That file says 2.4.24; changesets bumped it
 * in-repo without a release, so 2.4.24 exists only as source and 404s on every registry
 * and CDN. Read the source version from the repo, but always render with a version that
 * was actually published — see THIRD-PARTY.md for the full record.
 */
const RENDERER_VERSION = '2.4.20';

/**
 * esm.sh, not a plain CDN bundle, and this is load-bearing rather than a preference.
 *
 * A per-package ESM bundle resolves its OWN copy of react. Import the renderer and react
 * as separate bundles and the page ends up with two react instances, so the renderer's
 * hooks read from an instance that was never mounted and the first render dies on
 * `Cannot read properties of null (reading 'useState')`. esm.sh's `?deps=` pins the
 * shared dependencies so every module resolves to ONE build of each.
 *
 * `@react-three/fiber` is pinned for a second, separate reason: unpinned, esm.sh resolves
 * the latest major (v9), which requires React 19 and dies against React 18 with an equally
 * opaque internal error. 8.17.10 is the pair upstream itself develops against.
 */
const CDN_BASE = 'https://esm.sh';
const REACT_VERSION = '18.3.1';
const DEPS = `react@${REACT_VERSION},react-dom@${REACT_VERSION},three@0.169.0,@react-three/fiber@8.17.10`;

const IFRAME_LOAD_TIMEOUT_MS = 15_000;
const RENDER_TIMEOUT_MS = 45_000;
/** Frames to let the field settle before reading pixels — a first frame is often mid-compile. */
const SETTLE_FRAMES = 8;

export interface GradientRenderRequest {
  readonly props: ShaderGradientProps;
  /** Target pixel size of the baked image. */
  readonly width: number;
  readonly height: number;
  /** Device-pixel multiplier; the produced image is width*scale by height*scale. */
  readonly scale: number;
  /** Freeze the field at its current uTime rather than animating before capture. */
  readonly staticFrame: boolean;
}

export class GradientRenderError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'GradientRenderError';
  }
}

/**
 * The document rendered inside the offscreen iframe. It imports the pinned renderer,
 * mounts one field at the exact bake size, waits for it to settle, then posts either
 * a data URL or a structured failure back to this frame.
 *
 * Everything the field needs is passed in as JSON — the iframe never reads outer scope.
 */
function buildRenderDocument(req: GradientRenderRequest, token: string): string {
  const w = Math.round(req.width * req.scale);
  const h = Math.round(req.height * req.scale);
  const config = JSON.stringify({ props: req.props, staticFrame: req.staticFrame, settle: SETTLE_FRAMES });

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:transparent;overflow:hidden}
  #stage{width:${w}px;height:${h}px}
</style></head>
<body><div id="stage"></div>
<script type="module">
const TOKEN = ${JSON.stringify(token)};
const CFG = ${config};
const send = (msg) => parent.postMessage({ __gradientToken: TOKEN, ...msg }, '*');
const fail = (code, message) => send({ ok: false, code, message: String(message) });

// A module-level error (a failed import, a bad specifier) never reaches the try/catch
// below, so it is caught here — otherwise the bake would hang until its timeout with
// no reason recorded, which is the failure mode this whole file exists to avoid.
window.addEventListener('error', (e) => fail('E_RENDER_SCRIPT', e.message || 'render script error'));
window.addEventListener('unhandledrejection', (e) => fail('E_RENDER_SCRIPT', (e.reason && e.reason.message) || 'render promise rejected'));

(async () => {
  try {
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl2') || probe.getContext('webgl');
    if (!gl) { fail('E_NO_WEBGL', 'this environment provides no WebGL context'); return; }

    const [React, ReactDOMClient, SG] = await Promise.all([
      import(${JSON.stringify(`${CDN_BASE}/react@${REACT_VERSION}`)}),
      import(${JSON.stringify(`${CDN_BASE}/react-dom@${REACT_VERSION}/client?deps=react@${REACT_VERSION}`)}),
      import(${JSON.stringify(`${CDN_BASE}/@shadergradient/react@${RENDERER_VERSION}?deps=${DEPS}`)}),
    ]);

    const { ShaderGradientCanvas, ShaderGradient } = SG;
    if (!ShaderGradientCanvas || !ShaderGradient) {
      fail('E_RENDERER_SHAPE', 'the pinned renderer did not export ShaderGradientCanvas/ShaderGradient');
      return;
    }

    const props = { ...CFG.props };
    if (CFG.staticFrame) props.animate = 'off';

    const el = React.createElement(
      ShaderGradientCanvas,
      {
        style: { width: '100%', height: '100%' },
        pixelDensity: 1,
        fov: props.fov,
        // Required to read pixels back at all: without it the drawing buffer may be
        // cleared before toDataURL runs and the capture comes back empty.
        preserveDrawingBuffer: true,
        lazyLoad: false,
      },
      React.createElement(ShaderGradient, props),
    );

    ReactDOMClient.createRoot(document.getElementById('stage')).render(el);

    // Settle: let the renderer compile, upload, and draw a few frames. A single rAF
    // routinely captures a black frame mid shader-compile.
    await new Promise((resolve) => {
      let n = 0;
      const tick = () => { if (++n >= CFG.settle) resolve(); else requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });

    const canvas = document.querySelector('#stage canvas');
    if (!canvas) { fail('E_NO_CANVAS', 'the renderer mounted no canvas'); return; }

    const dataUrl = canvas.toDataURL('image/png');
    if (!dataUrl || dataUrl.length < 128) { fail('E_EMPTY_CAPTURE', 'the captured frame was empty'); return; }
    send({ ok: true, dataUrl });
  } catch (err) {
    fail('E_RENDER_FAILED', (err && err.message) || err);
  }
})();
</script></body></html>`;
}

/** Decode a `data:image/png;base64,...` URL into raw bytes. */
export function decodePngDataUrl(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',');
  if (!dataUrl.startsWith('data:image/png') || comma === -1) {
    throw new GradientRenderError('E_EMPTY_CAPTURE', 'capture was not a PNG data URL');
  }
  const b64 = dataUrl.slice(comma + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Render one gradient field offscreen and return its PNG bytes.
 *
 * Throws GradientRenderError with a specific code on every failure path. It never
 * returns a blank or placeholder image: a silent empty bake would land on the canvas
 * looking like a deliberate design choice, and the user would have no way to tell.
 */
export async function renderGradientToPng(req: GradientRenderRequest): Promise<Uint8Array> {
  if (!(req.width > 0) || !(req.height > 0)) {
    throw new GradientRenderError('E_INVALID_ARGS', 'gradient bake needs a positive width and height');
  }

  // Correlates replies to THIS render. Two bakes in flight would otherwise resolve
  // each other's promises, and the mismatch would be invisible — both produce an image.
  const token = `gr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.position = 'absolute';
  iframe.style.left = '-100000px';
  iframe.style.top = '0';
  iframe.style.width = `${Math.round(req.width * req.scale)}px`;
  iframe.style.height = `${Math.round(req.height * req.scale)}px`;
  iframe.style.border = '0';
  document.body.appendChild(iframe);

  let onMessage: ((e: MessageEvent) => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  try {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new GradientRenderError('E_TIMEOUT', `gradient render exceeded ${RENDER_TIMEOUT_MS}ms`)),
        RENDER_TIMEOUT_MS,
      );

      onMessage = (e: MessageEvent): void => {
        const d = e.data as { __gradientToken?: string; ok?: boolean; dataUrl?: string; code?: string; message?: string };
        if (!d || d.__gradientToken !== token) return; // not ours
        if (d.ok === true && typeof d.dataUrl === 'string') resolve(d.dataUrl);
        else reject(new GradientRenderError(d.code ?? 'E_RENDER_FAILED', d.message ?? 'gradient render failed'));
      };
      window.addEventListener('message', onMessage);

      const loadGuard = setTimeout(() => {
        // srcdoc never fired load. Proceed anyway is WRONG here (unlike the HTML
        // converter, which can still walk a partial DOM) — there is nothing to read.
        reject(new GradientRenderError('E_IFRAME_LOAD', 'the render iframe never loaded'));
      }, IFRAME_LOAD_TIMEOUT_MS);
      iframe.addEventListener('load', () => clearTimeout(loadGuard), { once: true });

      iframe.srcdoc = buildRenderDocument(req, token);
    });

    return decodePngDataUrl(dataUrl);
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (onMessage !== null) window.removeEventListener('message', onMessage);
    // Teardown always runs: an orphaned iframe keeps its WebGL context alive, and
    // Figma's UI frame has a small, shared context budget.
    iframe.remove();
  }
}
