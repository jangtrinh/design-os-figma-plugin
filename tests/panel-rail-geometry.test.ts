import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from 'playwright';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const html = readFileSync(`${ROOT}/plugin/src/ui/panel.html`, 'utf8');
let browser: Browser;
let page: Page;

beforeAll(async () => {
  try {
    browser = await chromium.launch({ headless: true });
  } catch {
    browser = await chromium.launch({ headless: true, channel: 'chrome' });
  }
  page = await browser.newPage({ viewport: { width: 200, height: 44 } });
  await page.setContent(html);
});

afterAll(async () => { await browser?.close(); });

describe('adaptive rail geometry in Chromium', () => {
  for (const scenario of [
    { width: 200, target: false, sync: false },
    { width: 220, target: true, sync: false },
    { width: 220, target: false, sync: true },
    { width: 240, target: true, sync: true },
  ]) {
    it(`keeps the toggle 8px from the ${scenario.width}px rail edge`, async () => {
      await page.setViewportSize({ width: scenario.width, height: 44 });
      await page.evaluate(({ target, sync }) => {
        (document.getElementById('fga-target-rail-btn') as HTMLButtonElement).hidden = !target;
        (document.getElementById('fga-sync-rail-btn') as HTMLButtonElement).hidden = !sync;
      }, scenario);
      const geometry = await page.evaluate(() => {
        const current = document.getElementById('fga-current-btn')!.getBoundingClientRect();
        const toggle = document.getElementById('fga-toggle-btn')!.getBoundingClientRect();
        return { currentRight: current.right, toggleLeft: toggle.left, toggleRight: toggle.right };
      });
      expect(geometry.toggleRight).toBe(scenario.width - 8);
      expect(geometry.toggleLeft - geometry.currentRight).toBeGreaterThanOrEqual(4);
    });
  }
});
