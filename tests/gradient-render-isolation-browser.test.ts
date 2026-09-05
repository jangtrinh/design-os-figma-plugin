import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import {
  buildGradientHostBundle,
  launchGradientChrome,
  openInstrumentedPage,
  PNG_DATA_URL,
} from './gradient-render-browser-fixture';

let browser: Browser;
let bundle: string;

beforeAll(async () => {
  bundle = await buildGradientHostBundle();
  browser = await launchGradientChrome();
}, 30_000);

afterAll(async () => { await browser?.close(); });

describe('opaque gradient renderer isolation', () => {
  it('prevents the render child from reading or changing parent DOM', async () => {
    const page = await openInstrumentedPage(browser, bundle);
    try {
      const result = await page.evaluate(async (dataUrl) => {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'srcdoc')!;
        Object.defineProperty(HTMLIFrameElement.prototype, 'srcdoc', {
          ...descriptor,
          set(source: string) {
            const token = /const (?:RENDER_ID|TOKEN) = ("[^"]+")/.exec(source)?.[1] ?? '"missing"';
            const child = `<script>let blocked=false;try{parent.document.getElementById('parent-marker').textContent='owned'}catch{blocked=true}parent.postMessage({channel:'design-os-gradient-render-v1',version:1,renderId:${token},type:'result',__gradientToken:${token},ok:true,dataUrl:${JSON.stringify(dataUrl)},blocked},'*')<\/script>`;
            descriptor.set!.call(this, child);
          },
        });
        const bytes = await (window as any).__renderGradient({ props: {}, width: 1, height: 1, scale: 1, staticFrame: true });
        return { bytes: Array.from(bytes), marker: document.getElementById('parent-marker')?.textContent };
      }, PNG_DATA_URL);
      expect(result.marker).toBe('safe');
      expect(result.bytes.length).toBeGreaterThan(32);
    } finally { await page.close(); }
  });

  it('rejects a same-origin sibling that knows the correlation token', async () => {
    const page = await openInstrumentedPage(browser, bundle);
    try {
      const result = await page.evaluate(async (dataUrl) => {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'srcdoc')!;
        Object.defineProperty(HTMLIFrameElement.prototype, 'srcdoc', {
          ...descriptor,
          set(source: string) {
            const token = /const (?:RENDER_ID|TOKEN) = ("[^"]+")/.exec(source)?.[1] ?? '"missing"';
            if ((this as HTMLIFrameElement).id !== 'attacker') {
              const attacker = document.createElement('iframe');
              attacker.id = 'attacker';
              descriptor.set!.call(attacker, `<script>parent.postMessage({channel:'design-os-gradient-render-v1',version:1,renderId:${token},type:'result',__gradientToken:${token},ok:true,dataUrl:${JSON.stringify(dataUrl.replace('Nk+A8', 'Nk+Q8'))}},'*')<\/script>`);
              document.body.appendChild(attacker);
            }
            descriptor.set!.call(this, `<script>setTimeout(()=>parent.postMessage({channel:'design-os-gradient-render-v1',version:1,renderId:${token},type:'result',__gradientToken:${token},ok:true,dataUrl:${JSON.stringify(dataUrl)}},'*'),50)<\/script>`);
          },
        });
        const bytes = await (window as any).__renderGradient({ props: {}, width: 1, height: 1, scale: 1, staticFrame: true });
        document.getElementById('attacker')?.remove();
        return Array.from(bytes);
      }, PNG_DATA_URL);
      const expected = Array.from(Uint8Array.from(atob(PNG_DATA_URL.split(',')[1]!), (char) => char.charCodeAt(0)));
      expect(result).toEqual(expected);
    } finally { await page.close(); }
  });
});
