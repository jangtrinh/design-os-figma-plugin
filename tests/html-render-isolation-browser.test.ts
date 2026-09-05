import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { buildProductionRenderHostBundle, launchInstalledChrome } from './html-render-browser-fixture';

let browser: Browser;
let bundle = '';

beforeAll(async () => {
  bundle = await buildProductionRenderHostBundle();
  browser = await launchInstalledChrome();
}, 30_000);

afterAll(async () => { await browser?.close(); });

describe('opaque HTML renderer', () => {
  it('prevents repository HTML from reading or changing the parent document', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<main id="parent-marker">safe</main>');
      await page.addScriptTag({ content: bundle });
      const payload = await page.evaluate(async () => (window as any).__render(`
        <body style="background: rgb(9, 10, 11)">
          <script>
            try { parent.document.getElementById('parent-marker').textContent = 'owned'; }
            catch { document.body.dataset.parentRefused = 'true'; }
          </script>
          <div id="child-result">child-only</div>
        </body>`, 320, 'Opaque HTML'));
      expect(await page.locator('#parent-marker').textContent()).toBe('safe');
      expect((payload as any).rootNode.children).toHaveLength(1);
    } finally { await page.close(); }
  }, 30_000);

  it('extracts requestAnimationFrame DOM and runtime-style changes inside the opaque child', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<main id="parent-marker">safe</main>');
      await page.addScriptTag({ content: bundle });
      const payload = await page.evaluate(async () => (window as any).__render(`
        <body><div id="runtime">before</div><script>
          requestAnimationFrame(() => {
            const element = document.getElementById('runtime');
            element.textContent = 'after animation frame';
            element.style.cssText = 'padding:23px;background:rgb(12,34,56);width:120px;height:40px;display:flex';
          });
        <\/script></body>`, 320, 'Runtime style proof'));
      expect(await page.locator('#parent-marker').textContent()).toBe('safe');
      const runtime = (payload as any).rootNode.children.find((node: any) => node.name === 'runtime');
      expect(runtime).toMatchObject({
        paddingTop: 23,
        paddingRight: 23,
        paddingBottom: 23,
        paddingLeft: 23,
        fills: [{ color: { r: 12 / 255, g: 34 / 255, b: 56 / 255, a: 1 } }],
      });
      expect(runtime.children[0].characters).toBe('after animation frame');
    } finally { await page.close(); }
  }, 30_000);
});
