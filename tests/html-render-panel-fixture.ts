import type { Frame, Page } from 'playwright';

function withSocketRecorder(html: string): string {
  const bootstrap = `<script>
    (() => {
      const fixture = { sockets: [], inbound: [] };
      window.__panelFixture = fixture;
      addEventListener('message', event => fixture.inbound.push({
        origin: event.origin,
        sourceIsParent: event.source === parent,
        sourceIsRenderer: Array.from(document.querySelectorAll('iframe')).some(frame => frame.contentWindow === event.source),
        data: event.data,
      }));
      class FixtureSocket {
        static OPEN = 1; readyState = 1; sent = []; onmessage = null; onerror = null; onclose = null;
        constructor(url) {
          this.url = url; fixture.sockets.push(this);
          if (url.endsWith(':9410')) setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: 'BROKER_HELLO', data: {} }) }), 0);
        }
        send(frame) { this.sent.push(JSON.parse(frame)); }
        close() { this.readyState = 3; }
      }
      window.WebSocket = FixtureSocket;
    })();
  <\/script>`;
  const bundle = html.indexOf('<script>');
  if (bundle < 0) throw new Error('compiled panel has no production script');
  return `${html.slice(0, bundle)}${bootstrap}${html.slice(bundle)}`;
}

export async function mountProductionPanel(page: Page, productionPanel: string): Promise<Frame> {
  await page.setContent('<iframe id="panel" name="production-panel"></iframe>');
  await page.evaluate((html) => {
    (window as any).__fromPanel = [];
    const panel = document.getElementById('panel') as HTMLIFrameElement;
    addEventListener('message', (event) => {
      if (event.source === panel.contentWindow) (window as any).__fromPanel.push(event.data);
    });
    panel.srcdoc = html;
  }, withSocketRecorder(productionPanel));
  const panel = page.frames().find((frame) => frame.name() === 'production-panel');
  if (!panel) throw new Error('production panel frame did not load');
  await panel.waitForFunction(() => (window as any).__panelFixture?.sockets.some(
    (socket: any) => socket.sent.some((frame: any) => frame.type === 'PLUGIN_HELLO'),
  ));
  return panel;
}

export function sendBrokerRequest(panel: Frame, request: Record<string, unknown>): Promise<void> {
  return panel.evaluate((message) => {
    const socket = (window as any).__panelFixture.sockets.find(
      (candidate: any) => candidate.sent.some((frame: any) => frame.type === 'PLUGIN_HELLO'),
    );
    socket.onmessage({ data: JSON.stringify(message) });
  }, request);
}

export function brokerFrames(panel: Frame): Promise<any[]> {
  return panel.evaluate(() => (window as any).__panelFixture.sockets.flatMap((socket: any) => socket.sent));
}
