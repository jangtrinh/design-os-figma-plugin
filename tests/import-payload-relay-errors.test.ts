import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, type Browser } from 'playwright';

let browser: Browser;
let panel: string;
let relay: string;

beforeAll(async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  panel = await readFile(`${root}/plugin/src/ui/panel.html`, 'utf8');
  const child = await build({
    entryPoints: [`${root}/plugin/src/ui/render-child-entry.ts`],
    bundle: true, platform: 'browser', format: 'iife', target: 'es2020',
    write: false, logLevel: 'silent',
  });
  const result = await build({
    entryPoints: [`${root}/plugin/src/ui/ui-relay.ts`],
    bundle: true, platform: 'browser', format: 'iife', target: 'es2020',
    write: false, logLevel: 'silent',
    define: { __HTML_RENDER_CHILD__: JSON.stringify(child.outputFiles[0].text) },
  });
  relay = result.outputFiles[0].text;
  try { browser = await chromium.launch({ headless: true }); }
  catch { browser = await chromium.launch({ headless: true, channel: 'chrome' }); }
}, 30_000);

afterAll(async () => { await browser?.close(); });

describe('actual UI relay admission errors', () => {
  it.each(['IMPORT_PAYLOAD', 'HTML_TO_FIGMA'])('preserves typed refusal and correlation for %s', async (cmd) => {
    const page = await browser.newPage();
    try {
      await page.addInitScript(() => {
        const probe = window as any;
        probe.sockets = [];
        probe.forwarded = [];
        probe.activities = [];
        class BrokerSocket {
          static OPEN = 1;
          readyState = 1;
          sent: any[] = [];
          onmessage: ((event: { data: string }) => void) | null = null;
          constructor(public url: string) {
            probe.sockets.push(this);
            setTimeout(() => this.onmessage?.({
              data: JSON.stringify({ type: 'BROKER_HELLO', data: {} }),
            }), 0);
          }
          send(frame: string) { this.sent.push(JSON.parse(frame)); }
          close() { this.readyState = 3; }
        }
        probe.WebSocket = BrokerSocket;
        probe.postMessage = (message: unknown) => probe.forwarded.push(message);
        window.addEventListener('figma-agent:activity', (event) => {
          probe.activities.push((event as CustomEvent).detail);
        });
      });
      await page.goto(`data:text/html,${encodeURIComponent(panel)}`);
      await page.addScriptTag({ content: relay });
      await page.waitForFunction(() => (window as any).sockets.some(
        (socket: any) => socket.sent.some((frame: any) => frame.type === 'PLUGIN_HELLO'),
      ));
      await page.evaluate((command) => {
        const socket = (window as any).sockets.find(
          (candidate: any) => candidate.sent.some((frame: any) => frame.type === 'PLUGIN_HELLO'),
        );
        const params = command === 'HTML_TO_FIGMA'
          ? { html: '<body style="background:#111"><div>Hi</div></body>', width: 100, name: 'x'.repeat(1024 * 1024 + 1) }
          : { version: 1, name: 'invalid', width: 100, height: 100, rootNode: { type: 'NOT_A_NODE', name: 'invalid' } };
        socket.onmessage({ data: JSON.stringify({ id: 'invalid-import', cmd: command, params, v: 1 }) });
      }, cmd);
      await page.waitForFunction(() => (window as any).sockets.some(
        (socket: any) => socket.sent.some((frame: any) => frame.id === 'invalid-import'),
      ));
      const result = await page.evaluate(() => {
        const probe = window as any;
        return {
          replies: probe.sockets.flatMap((socket: any) => socket.sent).filter((frame: any) => frame.id === 'invalid-import'),
          imports: probe.forwarded.filter((message: any) => message?.pluginMessage?.cmd === 'IMPORT_PAYLOAD'),
          completed: probe.activities.filter((activity: any) => activity.id === 'invalid-import' && activity.phase === 'done'),
          iframes: document.querySelectorAll('iframe').length,
        };
      });
      expect(result.replies).toHaveLength(1);
      expect(result.replies[0]).toMatchObject({ id: 'invalid-import', ok: false, error: { code: 'E_INVALID_ARGS' } });
      expect(result.imports).toEqual([]);
      expect(result.completed).toHaveLength(1);
      expect(result.completed[0]).toMatchObject({ ok: false, code: 'E_INVALID_ARGS' });
      expect(result.iframes).toBe(0);
    } finally {
      await page.close();
    }
  }, 20_000);
});
