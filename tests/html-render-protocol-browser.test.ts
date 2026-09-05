import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import {
  buildProductionRenderHostBundle,
  launchInstalledChrome,
  validRendererPayload,
} from './html-render-browser-fixture';

let browser: Browser;
let bundle: string;

async function instrumentHost(page: Page, source: string = bundle): Promise<void> {
  await page.setContent('<body></body>');
  await page.evaluate(() => {
    const probe = {
      messageListeners: new Set<EventListenerOrEventListenerObject>(),
      timers: new Set<number>(),
      seen: [] as Array<{ origin: string; sourceIsActive: boolean; data: any }>,
    };
    const add = window.addEventListener.bind(window);
    const remove = window.removeEventListener.bind(window);
    const schedule = window.setTimeout.bind(window);
    const cancel = window.clearTimeout.bind(window);
    (window as any).__hostProbe = probe;
    add('message', (event) => probe.seen.push({
      origin: event.origin,
      sourceIsActive: event.source === document.querySelector('iframe[sandbox="allow-scripts"]')?.contentWindow,
      data: event.data,
    }));
    window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
      if (type === 'message') probe.messageListeners.add(listener);
      add(type, listener, options);
    }) as typeof window.addEventListener;
    window.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
      if (type === 'message') probe.messageListeners.delete(listener);
      remove(type, listener, options);
    }) as typeof window.removeEventListener;
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      let id = 0;
      id = schedule(() => { probe.timers.delete(id); if (typeof handler === 'function') handler(...args); }, timeout);
      probe.timers.add(id);
      return id;
    }) as typeof window.setTimeout;
    window.clearTimeout = ((id?: number) => { if (id !== undefined) probe.timers.delete(id); cancel(id); }) as typeof window.clearTimeout;
  });
  await page.addScriptTag({ content: source });
}

async function cleanupState(page: Page): Promise<{ iframes: number; listeners: number; timers: number }> {
  return page.evaluate(() => ({
    iframes: document.querySelectorAll('iframe').length,
    listeners: (window as any).__hostProbe.messageListeners.size,
    timers: (window as any).__hostProbe.timers.size,
  }));
}

beforeAll(async () => {
  bundle = await buildProductionRenderHostBundle();
  browser = await launchInstalledChrome();
}, 30_000);

afterAll(async () => { await browser?.close(); });

describe('opaque renderer protocol and lifecycle', () => {
  it('cleans the listener and deadline when iframe setup throws', async () => {
    const page = await browser.newPage();
    try {
      await instrumentHost(page);
      const result = await page.evaluate(async () => {
        const body = document.body;
        const append = body.appendChild.bind(body);
        body.appendChild = ((node: Node) => {
          if (node instanceof HTMLIFrameElement) throw new Error('fixture append refused');
          return append(node);
        }) as typeof body.appendChild;
        try { await (window as any).__render('<body><div>never</div></body>', 320, 'setup'); }
        catch (error) { return { message: error instanceof Error ? error.message : String(error) }; }
        return { message: 'unexpected success' };
      });
      expect(result.message).toBe('fixture append refused');
      expect(await cleanupState(page)).toEqual({ iframes: 0, listeners: 0, timers: 0 });
    } finally { await page.close(); }
  });

  it('allocates no host resources when the child bundle is unavailable', async () => {
    const page = await browser.newPage();
    try {
      await instrumentHost(page, await buildProductionRenderHostBundle(''));
      const message = await page.evaluate(async () => {
        try { await (window as any).__render('<body><div>never</div></body>', 320, 'missing bundle'); }
        catch (error) { return error instanceof Error ? error.message : String(error); }
        return 'unexpected success';
      });
      expect(message).toBe('HTML renderer child bundle is unavailable');
      expect(await cleanupState(page)).toEqual({ iframes: 0, listeners: 0, timers: 0 });
    } finally { await page.close(); }
  });

  it('ignores stale, wrong-version, and unrelated-child results before the real child result', async () => {
    const page = await browser.newPage();
    try {
      await page.route('http://renderer-host.test/', (route) => route.fulfill({ body: '<body></body>', contentType: 'text/html' }));
      await page.goto('http://renderer-host.test/');
      await instrumentHost(page);
      const attacker = validRendererPayload('attacker');
      await page.evaluate((forged) => {
        const unrelated = document.createElement('iframe');
        unrelated.id = 'unrelated-child';
        unrelated.srcdoc = `<script>addEventListener('message',event=>parent.postMessage({...event.data,type:'result',payload:${JSON.stringify(forged)}},'*'))<\/script>`;
        document.body.appendChild(unrelated);
        const handler = (event: MessageEvent) => {
          if (event.data?.fixtureRequest) unrelated.contentWindow?.postMessage(event.data.fixtureRequest, '*');
        };
        (window as any).__unrelatedHandler = handler;
        addEventListener('message', handler);
      }, attacker);
      const payload = await page.evaluate(async ({ forged }) => (window as any).__render(`
        <body style="background:rgb(8,9,10)"><div id="real">real child</div>
        <script>
          addEventListener('message', event => {
            const request = event.data;
            if (request?.type !== 'render') return;
            parent.postMessage({...request, type:'result', channel:'wrong-channel', payload:${JSON.stringify(forged)}}, '*');
            parent.postMessage({...request, type:'result', version:999, payload:${JSON.stringify(forged)}}, '*');
            parent.postMessage({...request, type:'result', renderId:'stale', payload:${JSON.stringify(forged)}}, '*');
            parent.postMessage({fixtureRequest:request}, '*');
          });
        <\/script></body>`, 320, 'real result'), { forged: attacker });
      expect(payload.name).toBe('real result');
      expect(JSON.stringify(payload.rootNode)).toContain('real child');
      const rejected = await page.evaluate(() => (window as any).__hostProbe.seen.filter(
        (event: any) => event.data?.type === 'result' && event.data?.payload?.name === 'attacker',
      ));
      expect(rejected).toEqual(expect.arrayContaining([
        expect.objectContaining({ origin: 'null', sourceIsActive: true, data: expect.objectContaining({ channel: 'wrong-channel' }) }),
        expect.objectContaining({ origin: 'null', sourceIsActive: true, data: expect.objectContaining({ version: 999 }) }),
        expect.objectContaining({ origin: 'null', sourceIsActive: true, data: expect.objectContaining({ renderId: 'stale' }) }),
        expect.objectContaining({ origin: 'http://renderer-host.test', sourceIsActive: false }),
      ]));
      await page.evaluate(() => removeEventListener('message', (window as any).__unrelatedHandler));
      await page.locator('#unrelated-child').evaluate((element) => element.remove());
      expect(await cleanupState(page)).toEqual({ iframes: 0, listeners: 0, timers: 0 });
    } finally { await page.close(); }
  });

  it.each([
    ['malformed result', `parent.postMessage({...request,type:'result',payload:{version:1,name:'bad'}},'*')`, 'E_INVALID_ARGS'],
    ['missing payload', `parent.postMessage({...request,type:'result'},'*');parent.postMessage({...request,type:'result',payload:${JSON.stringify(validRendererPayload('late valid'))}},'*')`, 'E_INVALID_ARGS'],
    ['bounded child error', `parent.postMessage({...request,type:'error',error:'x'.repeat(2048)},'*')`, 'x'.repeat(512)],
  ])('settles one %s and cleans every host resource', async (_label, terminal, expected) => {
    const page = await browser.newPage();
    try {
      await instrumentHost(page);
      const result = await page.evaluate(async ({ code }) => {
        try {
          await (window as any).__render(`<body><script>addEventListener('message',event=>{const request=event.data;if(request?.type!=='render')return;event.stopImmediatePropagation();${code}})<\/script></body>`, 320, 'terminal');
        } catch (error) {
          return { message: error instanceof Error ? error.message : String(error), code: (error as any)?.code };
        }
        return { message: 'unexpected success' };
      }, { code: terminal });
      expect(`${result.code ?? ''} ${result.message}`).toContain(expected);
      if (_label === 'bounded child error') expect(result.message).toHaveLength(512);
      expect(await cleanupState(page)).toEqual({ iframes: 0, listeners: 0, timers: 0 });
    } finally { await page.close(); }
  });

  it('accepts only the first terminal result and cleans before a duplicate arrives', async () => {
    const page = await browser.newPage();
    try {
      await instrumentHost(page);
      const first = validRendererPayload('first terminal');
      const second = validRendererPayload('duplicate terminal');
      const payload = await page.evaluate(async ({ one, two }) => (window as any).__render(`<body><script>
        addEventListener('message',event=>{const request=event.data;if(request?.type!=='render')return;event.stopImmediatePropagation();parent.postMessage({...request,type:'result',payload:${JSON.stringify(one)}},'*');parent.postMessage({...request,type:'result',payload:${JSON.stringify(two)}},'*')})
      <\/script></body>`, 320, 'terminal'), { one: first, two: second });
      expect(payload.name).toBe('first terminal');
      expect(await cleanupState(page)).toEqual({ iframes: 0, listeners: 0, timers: 0 });
    } finally { await page.close(); }
  });

  it('enforces the real render deadline and cleans after timeout', async () => {
    const page = await browser.newPage();
    try {
      await page.clock.install();
      await instrumentHost(page);
      const pending = page.evaluate(async () => {
        try {
          await (window as any).__render(`<body><script>addEventListener('message',event=>event.stopImmediatePropagation())<\/script></body>`, 320, 'timeout');
        } catch (error) { return error instanceof Error ? error.message : String(error); }
        return 'unexpected success';
      });
      await page.waitForSelector('iframe');
      await page.clock.fastForward(15_001);
      expect(await pending).toBe('HTML renderer timed out');
      expect(await cleanupState(page)).toEqual({ iframes: 0, listeners: 0, timers: 0 });
    } finally { await page.close(); }
  });
});
