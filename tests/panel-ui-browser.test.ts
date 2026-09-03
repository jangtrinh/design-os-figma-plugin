import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from 'playwright';
import { chromium } from 'playwright';
import { RAIL_HEIGHT, RAIL_MIN_WIDTH, droppedNote } from '../plugin/src/ui/panel-model.ts';

// The BUILT panel — bundle included — so this exercises the wiring in panel-ui.ts, not a
// string that happens to appear in its source. Run `npm run build` first.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const html = readFileSync(`${ROOT}/plugin/ui.html`, 'utf8');
const BROWSER_SETUP_TIMEOUT_MS = 30_000;
const SLOW_TEST_TIMEOUT_MS = 30_000;
/** Two render ticks plus slack: long enough for the 1 s tick to re-post if it were going to. */
const TICK_OBSERVATION_MS = 2_600;
let browser: Browser;
let page: Page;

interface PluginMessage { type?: string; width?: number; commit?: boolean }
interface Emitted { type: string; line: string }

/** The panel is driven ONLY by this test. Two isolations make that true, and both are about
 *  the same hazard — a broker may or may not be listening on this machine, and a test whose
 *  result depends on that is worthless:
 *   - no socket is ever opened (ui-relay.ts's `new WebSocket` gets an inert stub), and
 *   - the relay is deaf and mute: `window.dispatchEvent` is swallowed and recorded, so the
 *     relay's own connection chatter never reaches the panel and the panel's outbound events
 *     never reach the relay.
 *  panel-ui.ts posts through `parent`, and a top-level page IS its own parent, so every
 *  plugin message the panel sends still comes back as a `message` event on this window. */
async function isolateFromTheNetwork(): Promise<void> {
  await page.evaluate(() => {
    class InertSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly readyState = 0;
      send(): void { /* never opens, so nothing is ever sent */ }
      close(): void { /* nothing to close */ }
      addEventListener(): void { /* never fires */ }
      removeEventListener(): void { /* never fires */ }
    }
    (window as unknown as { WebSocket: unknown }).WebSocket = InertSocket;
  });
}

async function instrument(): Promise<void> {
  await page.evaluate(() => {
    const spy = window as unknown as {
      __posts: PluginMessage[]; __emitted: Emitted[]; __drive: (event: Event) => boolean;
    };
    spy.__posts = [];
    spy.__emitted = [];
    spy.__drive = window.dispatchEvent.bind(window);
    window.addEventListener('message', (event: MessageEvent) => {
      const message = (event.data as { pluginMessage?: PluginMessage } | null)?.pluginMessage;
      if (message) spy.__posts.push(message);
    });
    window.dispatchEvent = (event: Event): boolean => {
      // Recorded with the line as it stood at that exact instant — the panel repaints again
      // before the next await, so this is the only place the transient state is observable.
      spy.__emitted.push({ type: event.type, line: document.getElementById('fga-sentence')?.textContent ?? '' });
      return true;
    };
  });
}

const posted = (type: string): Promise<PluginMessage[]> => page.evaluate((wanted) => (
  (window as unknown as { __posts: PluginMessage[] }).__posts.filter((post) => post.type === wanted)
), type);

const emitted = (type: string): Promise<Emitted[]> => page.evaluate((wanted) => (
  (window as unknown as { __emitted: Emitted[] }).__emitted.filter((event) => event.type === wanted)
), type);

const fire = (name: string, detail: unknown): Promise<boolean> => page.evaluate(
  (event) => (window as unknown as { __drive: (e: Event) => boolean })
    .__drive(new CustomEvent(event.name, { detail: event.detail })),
  { name, detail },
);

const send = (message: unknown): Promise<void> => page.evaluate(
  (pluginMessage) => { window.postMessage({ pluginMessage }, '*'); }, message,
);

const connect = (): Promise<boolean> => fire('figma-agent:conn-state', { state: 'connected', since: Date.now() });
const failOnce = (id: string): Promise<boolean> => fire('figma-agent:activity', { phase: 'done', id, ok: false, ms: 5, result: 'boom' });

const text = (selector: string): Promise<string> => page.locator(selector).evaluate((node) => node.textContent ?? '');
const chip = (): Promise<{ hidden: boolean; text: string }> => page.locator('#fga-failure-count')
  .evaluate((node) => ({ hidden: (node as HTMLElement).hidden, text: node.textContent ?? '' }));
const orbStatus = (): Promise<string> => page.locator('#fga-orb').evaluate((node) => node.getAttribute('aria-label') ?? '');

beforeAll(async () => {
  try {
    browser = await chromium.launch({ headless: true });
  } catch {
    browser = await chromium.launch({ headless: true, channel: 'chrome' });
  }
}, BROWSER_SETUP_TIMEOUT_MS);

afterAll(async () => { await browser?.close(); });

// A fresh document per test: droppedFrames, the failure set and the sync run all live for
// the panel's lifetime by design, so one shared page would leak state between cases.
beforeEach(async () => {
  page = await browser.newPage({ viewport: { width: RAIL_MIN_WIDTH, height: RAIL_HEIGHT } });
  await isolateFromTheNetwork();
  await page.setContent(html);
  await instrument();
});

afterEach(async () => { await page?.close(); });

describe('the built panel in Chromium', () => {
  it('asks main for a width only when the row actually changed size', async () => {
    // The load render already posted its width before the recorder existed; from here on a
    // post means the row moved.
    expect(await posted('PANEL_VIEWPORT')).toHaveLength(0);
    await fire('figma-agent:dropped', { frames: 2 });
    await expect.poll(async () => (await posted('PANEL_VIEWPORT')).length).toBe(1);
    const [request] = await posted('PANEL_VIEWPORT');
    expect(request?.width).toBeGreaterThan(0);
    await page.waitForTimeout(TICK_OBSERVATION_MS); // ≥2 render ticks with nothing changing
    expect(await posted('PANEL_VIEWPORT'), 'the 1 s tick must not re-post an unchanged width').toHaveLength(1);
  }, SLOW_TEST_TIMEOUT_MS);

  it('runs the sync from the rail button and closes the round-trip', async () => {
    await connect();
    await send({ type: 'IDLE_READY', data: { count: 2 } });
    await expect.poll(() => page.locator('#fga-sync-rail-btn').isVisible()).toBe(true);
    await page.click('#fga-sync-rail-btn');
    expect(await emitted('figma-agent:sync-request'), 'one click, one request, and the row already says so')
      .toEqual([{ type: 'figma-agent:sync-request', line: 'Syncing' }]);
    // The broker refuses: nothing landed, so nothing may be committed, and the button stays.
    await fire('figma-agent:sync-result', { ok: false, summary: 'no project bound', code: 'E_UNBOUND' });
    await expect.poll(() => posted('SYNC_DONE')).toEqual([{ type: 'SYNC_DONE', commit: false }]);
    expect(await page.locator('#fga-sync-rail-btn').isVisible(), 'a refused sync stays retryable').toBe(true);
    expect(await text('#fga-sentence')).toContain('no project bound');
  });

  it('keeps a lost edit on the line after the connection comes back', async () => {
    await fire('figma-agent:dropped', { frames: 2 });
    expect(await text('#fga-sentence-lead')).toBe(droppedNote(2));
    await connect();
    expect(await text('#fga-sentence-lead'), 'a lost edit does not expire with the outage').toBe(droppedNote(2));
    expect(await text('#fga-sentence')).toContain(droppedNote(2));
    expect(await page.locator('#fga-sentence-lead').isVisible()).toBe(true);
  });

  it('acknowledges failures from the row itself, and re-arms on the next one', async () => {
    await connect();
    await failOnce('req_1');
    expect(await chip()).toEqual({ hidden: false, text: '1' });
    expect(await orbStatus()).toBe('Needs attention');
    await page.click('#fga-sentence');
    expect(await chip(), 'the chip clears once the user has seen it').toEqual({ hidden: true, text: '' });
    expect(await orbStatus()).toBe('Connected');
    await failOnce('req_2');
    expect(await chip(), 'a new failure re-arms the count').toEqual({ hidden: false, text: '1' });
    expect(await orbStatus()).toBe('Needs attention');
  });
});
