import * as esbuild from 'esbuild';
import { chromium, type Browser } from 'playwright';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export async function launchInstalledChrome(): Promise<Browser> {
  if (process.platform === 'darwin') {
    return chromium.launch({ headless: true, executablePath: CHROME });
  }
  try {
    return await chromium.launch({ headless: true });
  } catch {
    return chromium.launch({ headless: true, channel: 'chrome' });
  }
}

export async function buildProductionRenderHostBundle(childOverride?: string): Promise<string> {
  const childSource = childOverride ?? (await esbuild.build({
      entryPoints: [`${ROOT}/plugin/src/ui/render-child-entry.ts`],
      bundle: true,
      platform: 'browser',
      format: 'iife',
      target: 'es2020',
      write: false,
      logLevel: 'silent',
    })).outputFiles[0].text;
  const result = await esbuild.build({
    stdin: {
      contents: "import { renderHtmlToPayload } from './plugin/src/ui/render-host.ts'; window.__render = renderHtmlToPayload;",
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
    write: false,
    logLevel: 'silent',
    define: { __HTML_RENDER_CHILD__: JSON.stringify(childSource) },
  });
  return result.outputFiles[0].text;
}

export const validRendererPayload = (name: string) => ({
  version: 1,
  name,
  width: 320,
  height: 100,
  tokens: { colors: [], typography: [], spacing: [], radii: [], shadows: [] },
  rootNode: { type: 'FRAME', name: 'Page', width: 320, height: 100 },
});
