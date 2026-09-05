import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { buildProductionRenderHostBundle, launchInstalledChrome, validRendererPayload } from './html-render-browser-fixture';

let browser: Browser;
let bundle: string;

async function instrument(page: Page, fault: string): Promise<void> {
  await page.clock.install();
  await page.setContent('<body></body>');
  await page.evaluate((fault) => {
    const probe = {
      timers: new Set<number>(), loadListeners: new Set<EventListenerOrEventListenerObject>(),
      messages: new Set<EventListenerOrEventListenerObject>(), cancellations: new Map<number, number>(),
      loadRemovals: 0, messageRemovals: 0, iframeRemovals: 0, fired: 0, unhandled: [] as string[],
    };
    const schedule = window.setTimeout.bind(window);
    const cancel = window.clearTimeout.bind(window);
    const add = window.addEventListener.bind(window);
    const remove = window.removeEventListener.bind(window);
    const create = document.createElement.bind(document);
    add('unhandledrejection', (event) => probe.unhandled.push(String(event.reason)));
    window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
      const id = schedule(() => {
        probe.timers.delete(id); probe.fired += 1;
        if (typeof handler === 'function') handler(...args);
      }, delay);
      probe.timers.add(id);
      return id;
    }) as typeof window.setTimeout;
    window.clearTimeout = ((id?: number) => {
      if (id !== undefined) {
        probe.timers.delete(id);
        probe.cancellations.set(id, (probe.cancellations.get(id) ?? 0) + 1);
      }
      cancel(id);
    }) as typeof window.clearTimeout;
    window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
      if (type === 'message') probe.messages.add(listener);
      add(type, listener, options);
    }) as typeof window.addEventListener;
    window.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
      if (type === 'message') { probe.messages.delete(listener); probe.messageRemovals += 1; }
      remove(type, listener, options);
    }) as typeof window.removeEventListener;
    document.createElement = ((tag: string, options?: ElementCreationOptions) => {
      const element = create(tag, options);
      if (element instanceof HTMLIFrameElement) {
        const listen = element.addEventListener.bind(element);
        const unlisten = element.removeEventListener.bind(element);
        const removeFrame = element.remove.bind(element);
        element.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
          if (type === 'load') {
            if (fault === 'load listener') throw new Error('fixture load listener refused');
            probe.loadListeners.add(listener);
          }
          listen(type, listener, options);
        }) as typeof element.addEventListener;
        element.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
          if (type === 'load') { probe.loadListeners.delete(listener); probe.loadRemovals += 1; }
          unlisten(type, listener, options);
        }) as typeof element.removeEventListener;
        element.remove = () => { probe.iframeRemovals += 1; removeFrame(); };
        if (fault === 'srcdoc') Object.defineProperty(element, 'srcdoc', {
          configurable: true, set() { throw new Error('fixture srcdoc refused'); },
        });
      }
      return element;
    }) as typeof document.createElement;
    (window as any).__cleanupState = () => ({
      timers: probe.timers.size, loads: probe.loadListeners.size, messages: probe.messages.size,
      cancellations: [...probe.cancellations.values()], loadRemovals: probe.loadRemovals,
      messageRemovals: probe.messageRemovals, iframeRemovals: probe.iframeRemovals,
      iframes: document.querySelectorAll('iframe').length, fired: probe.fired, unhandled: probe.unhandled,
    });
  }, fault);
  await page.addScriptTag({ content: bundle });
}

beforeAll(async () => {
  bundle = await buildProductionRenderHostBundle();
  browser = await launchInstalledChrome();
}, 30_000);

afterAll(async () => { await browser?.close(); });

describe('renderer cleanup ownership', () => {
  it.each(['srcdoc', 'load listener'])('releases all resources immediately when %s setup refuses', async (fault) => {
    const page = await browser.newPage();
    try {
      await instrument(page, fault);
      const immediate = await page.evaluate(async () => {
        let message = 'unexpected success';
        try { await (window as any).__render('<body>never</body>', 320, 'refused'); }
        catch (error) { message = error instanceof Error ? error.message : String(error); }
        return { message, ...(window as any).__cleanupState() };
      });
      expect(immediate).toMatchObject({
        message: `fixture ${fault} refused`, timers: 0, loads: 0, messages: 0,
        iframes: 0, iframeRemovals: 1, messageRemovals: 1, fired: 0, unhandled: [],
      });
      expect(immediate.cancellations.every((count: number) => count === 1)).toBe(true);
      expect(immediate.loadRemovals).toBe(fault === 'srcdoc' ? 1 : 0);
      await page.clock.fastForward(15_001);
      expect(await page.evaluate(() => (window as any).__cleanupState())).toMatchObject({ fired: 0, unhandled: [] });
    } finally { await page.close(); }
  });

  it('cleans each owned resource once for the first terminal reply', async () => {
    const page = await browser.newPage();
    try {
      await instrument(page, 'none');
      const payload = validRendererPayload('first result');
      const result = await page.evaluate(async (payload) => {
        const html = `<body><script>addEventListener('message',event=>{
          const request=event.data;if(request?.type!=='render')return;event.stopImmediatePropagation();
          parent.postMessage({...request,type:'result',payload:${JSON.stringify(payload)}},'*');
          parent.postMessage({...request,type:'error',error:'late error'},'*');
        })<\/script></body>`;
        const value = await (window as any).__render(html, 320, 'once');
        return { name: value.name, ...(window as any).__cleanupState() };
      }, payload);
      expect(result).toMatchObject({
        name: 'first result', timers: 0, loads: 0, messages: 0, iframes: 0,
        iframeRemovals: 1, messageRemovals: 1, loadRemovals: 1, unhandled: [],
      });
      expect(result.cancellations.every((count: number) => count === 1)).toBe(true);
    } finally { await page.close(); }
  });
});
