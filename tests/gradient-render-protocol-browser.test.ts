import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import {
  buildGradientHostBundle,
  cleanupState,
  instrumentGradientPage,
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

async function installChild(page: Page, body: string): Promise<void> {
  await page.evaluate(({ code, png }) => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'srcdoc')!;
    Object.defineProperty(HTMLIFrameElement.prototype, 'srcdoc', {
      ...descriptor,
      set(source: string) {
        const renderId = /const RENDER_ID = ("[^"]+")/.exec(source)?.[1] ?? '"missing"';
        (window as any).__frameSnapshot = {
          sandbox: this.getAttribute('sandbox'),
          style: this.getAttribute('style'),
        };
        descriptor.set!.call(this, `<script>${code.replaceAll('__ID__', renderId).replaceAll('__PNG__', JSON.stringify(png))}<\/script>`);
      },
    });
  }, { code: body, png: PNG_DATA_URL });
}

const resultReply = "{channel:'design-os-gradient-render-v1',version:1,renderId:__ID__,type:'result',dataUrl:__PNG__}";

describe('gradient renderer protocol and lifecycle', () => {
  it('refuses invalid dimensions before allocating an iframe or host resources', async () => {
    const page = await openInstrumentedPage(browser, bundle);
    try {
      const error = await page.evaluate(async () => {
        try { await (window as any).__renderGradient({ props: {}, width: Number.NaN, height: 1, scale: 1, staticFrame: true }); }
        catch (caught) { return { code: (caught as any).code, message: (caught as Error).message }; }
        return null;
      });
      expect(error).toEqual({ code: 'E_INVALID_ARGS', message: 'gradient bake needs finite positive width, height, and scale' });
      expect(await cleanupState(page)).toEqual({ iframes: 0, listeners: 0, timers: 0 });
    } finally { await page.close(); }
  });

  it('bounds document serialization failures before allocating host resources', async () => {
    const page = await openInstrumentedPage(browser, bundle);
    try {
      const error = await page.evaluate(async () => {
        const props: Record<string, unknown> = {};
        props.circular = props;
        try { await (window as any).__renderGradient({ props, width: 1, height: 1, scale: 1, staticFrame: true }); }
        catch (caught) { return { code: (caught as any).code, length: (caught as Error).message.length }; }
        return null;
      });
      expect(error?.code).toBe('E_RENDER_SETUP');
      expect(error?.length).toBeLessThanOrEqual(512);
      expect(await cleanupState(page)).toEqual({ iframes: 0, listeners: 0, timers: 0 });
    } finally { await page.close(); }
  });

  it('uses the opaque in-viewport placement and completes an eight-frame child', async () => {
    const page = await openInstrumentedPage(browser, bundle);
    try {
      await installChild(page, `let n=0;const tick=()=>{if(++n<8)requestAnimationFrame(tick);else parent.postMessage(${resultReply},'*')};requestAnimationFrame(tick)`);
      const bytes = await page.evaluate(() => (window as any).__renderGradient({ props: {}, width: 1, height: 1, scale: 1, staticFrame: true }).then(Array.from));
      expect(bytes.length).toBeGreaterThan(32);
      expect(await page.evaluate(() => (window as any).__frameSnapshot)).toEqual(expect.objectContaining({
        sandbox: 'allow-scripts',
        style: expect.stringMatching(/position: fixed;.*left: 0px;.*top: 0px;.*opacity: 0;.*pointer-events: none/),
      }));
      expect(await cleanupState(page)).toEqual({ iframes: 0, listeners: 0, timers: 0 });
    } finally { await page.close(); }
  });

  it('ignores wrong token and wrong-origin messages before the genuine result', async () => {
    const page = await openInstrumentedPage(browser, bundle);
    try {
      await page.evaluate((png) => {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'srcdoc')!;
        Object.defineProperty(HTMLIFrameElement.prototype, 'srcdoc', {
          ...descriptor,
          set(source: string) {
            const quoted = /const RENDER_ID = ("[^"]+")/.exec(source)?.[1] ?? '"missing"';
            const id = JSON.parse(quoted);
            const reply = { channel: 'design-os-gradient-render-v1', version: 1, renderId: id, type: 'result', dataUrl: png };
            queueMicrotask(() => {
              window.dispatchEvent(new MessageEvent('message', { source: this.contentWindow, origin: 'https://attacker.test', data: reply }));
            });
            descriptor.set!.call(this, `<script>parent.postMessage({...${JSON.stringify(reply)},renderId:'wrong'},'*');setTimeout(()=>parent.postMessage(${JSON.stringify(reply)},'*'),25)<\/script>`);
          },
        });
      }, PNG_DATA_URL);
      const bytes = await page.evaluate(() => (window as any).__renderGradient({ props: {}, width: 1, height: 1, scale: 1, staticFrame: true }).then(Array.from));
      expect(bytes.length).toBeGreaterThan(32);
      expect(await cleanupState(page)).toEqual({ iframes: 0, listeners: 0, timers: 0 });
    } finally { await page.close(); }
  });

  it('bounds child error code and message, settles once, and cleans resources', async () => {
    const page = await openInstrumentedPage(browser, bundle);
    try {
      await installChild(page, `parent.postMessage({channel:'design-os-gradient-render-v1',version:1,renderId:__ID__,type:'error',code:'E'.repeat(200),message:'x'.repeat(2000)},'*');parent.postMessage(${resultReply},'*')`);
      const error = await page.evaluate(async () => {
        try { await (window as any).__renderGradient({ props: {}, width: 1, height: 1, scale: 1, staticFrame: true }); }
        catch (caught) { return { code: (caught as any).code, message: (caught as Error).message }; }
        return null;
      });
      expect(error?.code).toHaveLength(64);
      expect(error?.message).toHaveLength(512);
      expect(await cleanupState(page)).toEqual({ iframes: 0, listeners: 0, timers: 0 });
    } finally { await page.close(); }
  });

  it('rejects a PNG whose header does not match the requested render size', async () => {
    const page = await openInstrumentedPage(browser, bundle);
    try {
      await installChild(page, `parent.postMessage(${resultReply},'*')`);
      const error = await page.evaluate(async () => {
        try { await (window as any).__renderGradient({ props: {}, width: 2, height: 1, scale: 1, staticFrame: true }); }
        catch (caught) { return { code: (caught as any).code, message: (caught as Error).message }; }
        return null;
      });
      expect(error).toEqual({ code: 'E_INVALID_IMAGE', message: 'gradient PNG dimensions 1x1 do not match requested 2x1' });
      expect(await cleanupState(page)).toEqual({ iframes: 0, listeners: 0, timers: 0 });
    } finally { await page.close(); }
  });

  it('cleans all resources when assigning the child document throws', async () => {
    const page = await openInstrumentedPage(browser, bundle);
    try {
      await page.evaluate(() => {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'srcdoc')!;
        Object.defineProperty(HTMLIFrameElement.prototype, 'srcdoc', { ...descriptor, set() { throw new Error('fixture srcdoc refused'); } });
      });
      const error = await page.evaluate(async () => {
        try { await (window as any).__renderGradient({ props: {}, width: 1, height: 1, scale: 1, staticFrame: true }); }
        catch (caught) { return { code: (caught as any).code, message: (caught as Error).message }; }
        return null;
      });
      expect(error).toEqual({ code: 'E_RENDER_SETUP', message: 'fixture srcdoc refused' });
      expect(await cleanupState(page)).toEqual({ iframes: 0, listeners: 0, timers: 0 });
    } finally { await page.close(); }
  });

  it('enforces the render deadline and cleans the silent child', async () => {
    const page = await browser.newPage();
    try {
      await page.clock.install();
      await instrumentGradientPage(page, bundle);
      await installChild(page, 'void 0');
      const pending = page.evaluate(async () => {
        try { await (window as any).__renderGradient({ props: {}, width: 1, height: 1, scale: 1, staticFrame: true }); }
        catch (caught) { return { code: (caught as any).code, message: (caught as Error).message }; }
        return null;
      });
      await page.waitForSelector('iframe');
      await page.clock.fastForward(45_001);
      expect(await pending).toEqual({ code: 'E_TIMEOUT', message: 'gradient render exceeded 45000ms' });
      expect(await cleanupState(page)).toEqual({ iframes: 0, listeners: 0, timers: 0 });
    } finally { await page.close(); }
  });

  it('enforces the load deadline and cleans a child that never loads', async () => {
    const page = await browser.newPage();
    try {
      await page.clock.install();
      await instrumentGradientPage(page, bundle);
      await page.evaluate(() => {
        const add = HTMLIFrameElement.prototype.addEventListener;
        HTMLIFrameElement.prototype.addEventListener = function (type, listener, options) {
          if (type !== 'load') add.call(this, type, listener, options);
        };
        const descriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'srcdoc')!;
        Object.defineProperty(HTMLIFrameElement.prototype, 'srcdoc', { ...descriptor, set() { /* fixture never loads */ } });
      });
      const pending = page.evaluate(async () => {
        try { await (window as any).__renderGradient({ props: {}, width: 1, height: 1, scale: 1, staticFrame: true }); }
        catch (caught) { return { code: (caught as any).code, message: (caught as Error).message }; }
        return null;
      });
      await page.waitForSelector('iframe');
      await page.clock.fastForward(15_001);
      expect(await pending).toEqual({ code: 'E_IFRAME_LOAD', message: 'the render iframe never loaded' });
      expect(await cleanupState(page)).toEqual({ iframes: 0, listeners: 0, timers: 0 });
    } finally { await page.close(); }
  });
});
