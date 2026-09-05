import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import type { Browser } from 'playwright';
import { chromium } from 'playwright';
import { forwardValidatedDirectImport, forwardValidatedHtmlImport } from '../shared/figma-payload-validation-relay.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
let browser: Browser;
let authoredHtmlBundle: string;
let repositoryPanelHtml: string;

beforeAll(async () => {
  repositoryPanelHtml = await readFile(new URL('../plugin/src/ui/panel.html', import.meta.url), 'utf8');
  const child = await esbuild.build({
    entryPoints: [`${ROOT}/plugin/src/ui/render-child-entry.ts`],
    bundle: true, platform: 'browser', format: 'iife', target: 'es2020',
    write: false, logLevel: 'silent',
  });
  const built = await esbuild.build({
    stdin: {
      contents: `
        import { renderHtmlToPayload } from './plugin/src/ui/render-host.ts';
        import { forwardValidatedHtmlImport } from './shared/figma-payload-validation-relay.ts';
        window.__relayRepositoryHtml = async (html) => {
          const payload = await renderHtmlToPayload(html, 640, 'Repository panel');
          let forwarded;
          forwardValidatedHtmlImport({
            requestId: 'repository-html', expectedFile: 'Plugin panel', payload,
            placement: { x: 12, y: 24 },
          }, (message) => { forwarded = message; });
          return { forwarded, bytes: JSON.stringify(payload).length };
        };
      `,
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
    write: false,
    logLevel: 'silent',
    define: { __HTML_RENDER_CHILD__: JSON.stringify(child.outputFiles[0].text) },
  });
  authoredHtmlBundle = built.outputFiles[0].text;
  try {
    browser = await chromium.launch({ headless: true });
  } catch {
    browser = await chromium.launch({ headless: true, channel: 'chrome' });
  }
}, 30_000);

afterAll(async () => { await browser?.close(); });

const valid = () => ({
  version: 1 as const,
  name: 'Authored HTML',
  width: 320,
  height: 200,
  tokens: { colors: [], typography: [], spacing: [], radii: [], shadows: [] },
  rootNode: { type: 'FRAME', name: 'Page' },
});

describe('direct IMPORT_PAYLOAD relay admission', () => {
  it.each([
    ['direct', { ...valid(), rootNode: { type: 'FRAME', name: 'bad', layoutMode: 'NOT_A_LAYOUT' } }],
    ['wrapped', { payload: { ...valid(), rootNode: { type: 'FRAME', name: 'bad', counterAxisSpacing: {} } } }],
  ])('refuses malformed %s input before forwarding to parent', (_label, params) => {
    const forward = vi.fn();
    expect(() => forwardValidatedDirectImport({
      requestId: 'direct-bad', expectedFile: 'Landing', params,
    }, forward)).toThrowError(expect.objectContaining({ code: 'E_INVALID_ARGS' }));
    expect(forward).not.toHaveBeenCalled();
  });

  it.each([
    ['direct', { ...valid(), tokens: { colors: [] }, x: 10, y: 20 }],
    ['wrapped', {
      payload: { ...valid(), tokens: { colors: [] } },
      x: 10, y: 20, parentId: '1:2', replaceId: '1:3',
    }],
  ])('normalizes valid %s input and preserves correlation plus placement', (_label, params) => {
    const forward = vi.fn();
    forwardValidatedDirectImport({ requestId: 'direct-ok', expectedFile: 'Landing', params }, forward);
    expect(forward).toHaveBeenCalledWith({
      pluginMessage: {
        requestId: 'direct-ok', cmd: 'IMPORT_PAYLOAD', expectedFile: 'Landing',
        params: {
          payload: { ...valid(), tokens: { colors: [], typography: [], spacing: [], radii: [], shadows: [] } },
          x: 10, y: 20, ...(_label === 'wrapped' ? { parentId: '1:2', replaceId: '1:3' } : {}),
        },
      },
    });
  });
});

describe('HTML render-result relay admission', () => {
  it('does not forward malformed renderer output', () => {
    const forward = vi.fn();
    expect(() => forwardValidatedHtmlImport({
      requestId: 'req-bad',
      expectedFile: 'Landing',
      payload: { ...valid(), rootNode: { type: 'FRAME', name: 'bad', layoutMode: 'NOT_A_LAYOUT' } },
      placement: { x: 10, y: 20 },
    }, forward)).toThrowError(expect.objectContaining({ code: 'E_INVALID_ARGS' }));
    expect(forward).not.toHaveBeenCalled();
  });

  it('preserves correlation and placement when forwarding admitted output', () => {
    const forward = vi.fn();
    forwardValidatedHtmlImport({
      requestId: 'req-ok', expectedFile: 'Landing', payload: valid(),
      placement: { x: 10, y: 20, parentId: '1:2', replaceId: '1:3' },
    }, forward);
    expect(forward).toHaveBeenCalledWith({
      pluginMessage: {
        requestId: 'req-ok', cmd: 'IMPORT_PAYLOAD', expectedFile: 'Landing',
        params: { payload: valid(), x: 10, y: 20, parentId: '1:2', replaceId: '1:3' },
      },
    });
  });

  it('accepts actual converter output from repository-authored panel HTML before relaying it', async () => {
    const page = await browser.newPage();
    await page.setContent('<body style="background:#111"></body>');
    await page.addScriptTag({ content: authoredHtmlBundle });
    const result = await page.evaluate(async (html) => (
      (window as typeof window & { __relayRepositoryHtml: (source: string) => Promise<Record<string, unknown>> })
        .__relayRepositoryHtml(html)
    ), repositoryPanelHtml);
    const forwarded = result.forwarded as {
      pluginMessage: { requestId: string; expectedFile: string; params: Record<string, unknown> };
    };
    console.info('repository-html converter measurement', {
      serializedBytes: result.bytes,
      corpus: 'repository-authored plugin/src/ui/panel.html',
      figmaCorpus: 'absent',
      stress: 'separate synthetic unit fixtures',
    });
    expect(forwarded.pluginMessage).toMatchObject({
      requestId: 'repository-html', expectedFile: 'Plugin panel',
      params: { x: 12, y: 24, payload: { version: 1, name: 'Repository panel' } },
    });
    expect(((forwarded.pluginMessage.params.payload as { rootNode: { children: unknown[] } }).rootNode.children).length).toBeGreaterThan(0);
    expect(await page.locator('iframe').count()).toBe(0);
    await page.close();
  }, 30_000);
});
