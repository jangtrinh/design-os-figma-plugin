import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { Browser } from 'playwright';
import { launchInstalledChrome, ROOT } from './html-render-browser-fixture';
import { brokerFrames, mountProductionPanel, sendBrokerRequest } from './html-render-panel-fixture';

let browser: Browser;
let productionPanel: string;

beforeAll(async () => {
  productionPanel = await readFile(`${ROOT}/plugin/ui.html`, 'utf8');
  browser = await launchInstalledChrome();
});

afterAll(async () => { await browser?.close(); });

describe('compiled production panel renderer refusal', () => {
  it.each([
    { label: 'malformed shape', payload: { version: 1, name: 'malformed' } },
    { label: 'long unsupported key', payload: {
      version: 1, name: 'malformed', width: 320, height: 100,
      tokens: { colors: [], typography: [], spacing: [], radii: [], shadows: [] },
      rootNode: { type: 'FRAME', name: 'Page', ['x'.repeat(16_000)]: true },
    } },
  ])('returns one bounded typed error without forwarding $label', async ({ payload }) => {
    const page = await browser.newPage();
    try {
      const panel = await mountProductionPanel(page, productionPanel);
      const html = `<body><script>
        addEventListener('message', event => {
          const request = event.data;
          if (request?.type !== 'render') return;
          event.stopImmediatePropagation();
          parent.postMessage({ ...request, type: 'result', payload: ${JSON.stringify(payload)} }, '*');
        });
      <\/script></body>`;
      await sendBrokerRequest(panel, {
        id: 'malformed-child', cmd: 'HTML_TO_FIGMA',
        params: { html, width: 320, name: 'Malformed child' }, v: 1,
      });
      await panel.waitForFunction(() => (window as any).__panelFixture.sockets.some(
        (socket: any) => socket.sent.some((frame: any) => frame.id === 'malformed-child'),
      ));
      const replies = (await brokerFrames(panel)).filter((frame) => frame.id === 'malformed-child');
      expect(replies).toEqual([
        expect.objectContaining({ id: 'malformed-child', ok: false, error: expect.objectContaining({ code: 'E_INVALID_ARGS' }) }),
      ]);
      expect(replies[0]!.error.message.length).toBeLessThanOrEqual(512);
      expect(await page.evaluate(() => (window as any).__fromPanel.filter(
        (message: any) => message?.pluginMessage?.requestId === 'malformed-child',
      ))).toEqual([]);
      expect(await panel.locator('iframe').count()).toBe(0);
    } finally { await page.close(); }
  }, 30_000);
});
