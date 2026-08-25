import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Browser, Locator, Page } from 'playwright';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const html = readFileSync(`${ROOT}/plugin/ui.html`, 'utf8');
const BROWSER_SETUP_TIMEOUT_MS = 30_000;
let browser: Browser;
let page: Page;

async function waitForDifferentFrame(orb: Locator, baseline: Buffer): Promise<Buffer> {
  let changed: Buffer | undefined;
  await expect.poll(async () => {
    const candidate = await orb.screenshot();
    if (!candidate.equals(baseline)) changed = candidate;
    return changed !== undefined;
  }, { timeout: 5_000, interval: 50, message: 'worker canvas pixels never changed' }).toBe(true);
  if (!changed) throw new Error('worker canvas pixels never changed');
  return changed;
}

beforeAll(async () => {
  try {
    browser = await chromium.launch({ headless: true });
  } catch {
    browser = await chromium.launch({ headless: true, channel: 'chrome' });
  }
  page = await browser.newPage({ viewport: { width: 200, height: 44 } });
  await page.evaluate(() => {
    const original = window.requestAnimationFrame.bind(window);
    Object.defineProperty(window, '__mainRafCount', { value: 0, writable: true });
    window.requestAnimationFrame = (callback): number => {
      (window as typeof window & { __mainRafCount: number }).__mainRafCount += 1;
      return original(callback);
    };
  });
  await page.setContent(html);
}, BROWSER_SETUP_TIMEOUT_MS);

afterAll(async () => { await browser?.close(); });

describe('Thinking Orb worker renderer in Chromium', () => {
  it('paints the transferred canvas without scheduling UI-thread animation frames', async () => {
    await expect.poll(() => page.locator('.thinking-orb').getAttribute('width')).toBe('20');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('figma-agent:conn-state', {
      detail: { state: 'connected', since: Date.now() },
    })));
    const orb = page.locator('.thinking-orb');
    const firstFrame = await orb.screenshot();
    const paintedFrame = await waitForDifferentFrame(orb, firstFrame);
    await waitForDifferentFrame(orb, paintedFrame);
    const mainRafCount = await page.evaluate(
      () => (window as typeof window & { __mainRafCount: number }).__mainRafCount,
    );
    expect(mainRafCount).toBe(0);
  }, BROWSER_SETUP_TIMEOUT_MS);
});
