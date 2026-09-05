import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { Browser } from 'playwright';
import { launchInstalledChrome, ROOT } from './html-render-browser-fixture';
import { brokerFrames, mountProductionPanel, sendBrokerRequest } from './html-render-panel-fixture';

let browser: Browser;
let productionPanel: string;
let repositoryPanelSource: string;

beforeAll(async () => {
  productionPanel = await readFile(`${ROOT}/plugin/ui.html`, 'utf8');
  repositoryPanelSource = await readFile(`${ROOT}/plugin/src/ui/panel.html`, 'utf8');
  browser = await launchInstalledChrome();
});

afterAll(async () => { await browser?.close(); });

describe('compiled production panel source boundaries', () => {
  it('accepts parent control while renderer-child FILE_INFO, reply, and IDLE_READY have no effects', async () => {
    const page = await browser.newPage();
    try {
      const panel = await mountProductionPanel(page, productionPanel);
      const html = `<body><div id="runtime">before</div><script>
        addEventListener('message', event => {
          if (event.data?.type !== 'render') return;
          parent.postMessage({ pluginMessage: { type: 'FILE_INFO', data: { fileName: 'Child spoof' } } }, '*');
          parent.postMessage({ pluginMessage: { requestId: 'child-spoof', ok: true, result: { owned: true } } }, '*');
          parent.postMessage({ pluginMessage: { type: 'IDLE_READY', data: { count: 77 } } }, '*');
          requestAnimationFrame(() => {
            const element = document.getElementById('runtime');
            element.textContent = 'changed by user JavaScript';
            element.style.cssText = 'padding:19px;background:rgb(21,43,65);display:flex';
          });
        });
      <\/script></body>`;
      await sendBrokerRequest(panel, { id: 'html-import', cmd: 'HTML_TO_FIGMA', params: { html, width: 320, name: 'Compiled panel import' }, v: 1 });
      await page.waitForFunction(() => (window as any).__fromPanel.some(
        (message: any) => message?.pluginMessage?.requestId === 'html-import' && message?.pluginMessage?.cmd === 'IMPORT_PAYLOAD',
      ));

      const imported = await page.evaluate(() => (window as any).__fromPanel.find(
        (message: any) => message?.pluginMessage?.requestId === 'html-import',
      ));
      const runtime = imported.pluginMessage.params.payload.rootNode.children.find((node: any) => node.name === 'runtime');
      expect(runtime).toMatchObject({
        paddingTop: 19,
        paddingRight: 19,
        paddingBottom: 19,
        paddingLeft: 19,
        fills: [{ color: { r: 21 / 255, g: 43 / 255, b: 65 / 255, a: 1 } }],
      });
      expect(JSON.stringify(runtime)).toContain('changed by user JavaScript');
      expect((await brokerFrames(panel)).filter((frame) => frame.id === 'child-spoof')).toEqual([]);
      expect((await brokerFrames(panel)).filter((frame) => frame.type === 'FILE_INFO')).toEqual([]);
      expect(await panel.locator('#fga-sync-rail-btn').getAttribute('hidden')).not.toBeNull();
      const rendererMessages = await panel.evaluate(() => (window as any).__panelFixture.inbound.filter(
        (event: any) => event.sourceIsRenderer,
      ));
      expect(rendererMessages.length).toBeGreaterThan(0);
      expect(rendererMessages.every((event: any) => event.origin === 'null' && event.sourceIsParent === false)).toBe(true);

      await page.evaluate(() => {
        const panel = (document.getElementById('panel') as HTMLIFrameElement).contentWindow!;
        panel.postMessage({ pluginMessage: { type: 'FILE_INFO', data: { fileName: 'Parent file', fileKey: 'parent-key' } } }, '*');
        panel.postMessage({ pluginMessage: { requestId: 'parent-reply', ok: true, result: { accepted: true } } }, '*');
        panel.postMessage({ pluginMessage: { type: 'IDLE_READY', data: { count: 3 } } }, '*');
      });
      await panel.waitForFunction(() => (window as any).__panelFixture.sockets.some(
        (socket: any) => socket.sent.some((frame: any) => frame.id === 'parent-reply'),
      ));
      expect((await brokerFrames(panel)).find((frame) => frame.type === 'FILE_INFO')).toMatchObject({
        data: { fileName: 'Parent file', fileKey: 'parent-key' },
      });
      expect((await brokerFrames(panel)).find((frame) => frame.id === 'parent-reply')).toMatchObject({
        ok: true,
        result: { accepted: true },
      });
      expect(await panel.locator('#fga-sync-badge').textContent()).toBe('3');
      expect(await panel.locator('#fga-sync-rail-btn').getAttribute('hidden')).toBeNull();
    } finally { await page.close(); }
  }, 30_000);

  it('converts repository panel HTML through the compiled panel and production relay', async () => {
    const page = await browser.newPage();
    try {
      const panel = await mountProductionPanel(page, productionPanel);
      await sendBrokerRequest(panel, {
        id: 'repository-panel-import',
        cmd: 'HTML_TO_FIGMA',
        params: { html: repositoryPanelSource, width: 640, name: 'Repository panel HTML' },
        v: 1,
      });
      await page.waitForFunction(() => (window as any).__fromPanel.some(
        (message: any) => message?.pluginMessage?.requestId === 'repository-panel-import',
      ));
      const payload = await page.evaluate(() => (window as any).__fromPanel.find(
        (message: any) => message?.pluginMessage?.requestId === 'repository-panel-import',
      ).pluginMessage.params.payload);
      expect(payload).toMatchObject({ version: 1, name: 'Repository panel HTML', width: 640 });
      expect(payload.rootNode.children.length).toBeGreaterThan(0);
      expect(await panel.locator('iframe').count()).toBe(0);
    } finally { await page.close(); }
  }, 30_000);
});
