import * as esbuild from 'esbuild';
import type { Browser, Page } from 'playwright';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
export { PNG_DATA_URL } from './gradient-png-fixture';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export async function launchGradientChrome(): Promise<Browser> {
  const options = {
    headless: true,
    args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
  } as const;
  if (process.platform === 'darwin') return chromium.launch({ ...options, executablePath: CHROME });
  try { return await chromium.launch(options); }
  catch { return chromium.launch({ ...options, channel: 'chrome' }); }
}

export async function buildGradientHostBundle(): Promise<string> {
  const result = await esbuild.build({
    stdin: {
      contents: "import { renderGradientToPng } from './plugin/src/ui/gradient-host.ts'; window.__renderGradient = renderGradientToPng;",
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
    write: false,
    logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}

export async function openInstrumentedPage(browser: Browser, bundle: string): Promise<Page> {
  const page = await browser.newPage();
  await instrumentGradientPage(page, bundle);
  return page;
}

export async function instrumentGradientPage(page: Page, bundle: string): Promise<void> {
  await page.setContent('<main id="parent-marker">safe</main>');
  await page.evaluate(() => {
    const probe = {
      messageListeners: new Set<EventListenerOrEventListenerObject>(),
      timers: new Set<number>(),
    };
    const add = window.addEventListener.bind(window);
    const remove = window.removeEventListener.bind(window);
    const schedule = window.setTimeout.bind(window);
    const cancel = window.clearTimeout.bind(window);
    (window as any).__gradientProbe = probe;
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
    window.clearTimeout = ((id?: number) => {
      if (id !== undefined) probe.timers.delete(id);
      cancel(id);
    }) as typeof window.clearTimeout;
  });
  await page.addScriptTag({ content: bundle });
}

export async function cleanupState(page: Page): Promise<{ iframes: number; listeners: number; timers: number }> {
  return page.evaluate(() => ({
    iframes: document.querySelectorAll('iframe').length,
    listeners: (window as any).__gradientProbe.messageListeners.size,
    timers: (window as any).__gradientProbe.timers.size,
  }));
}
