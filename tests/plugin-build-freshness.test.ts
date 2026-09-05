// The manifest loads the COMMITTED plugin/code.js + plugin/ui.html, never plugin/src
// directly — Figma has no build step of its own. A source edit that never gets rebuilt
// therefore ships silently: the committed artifacts drift from plugin/src and nobody
// notices until a designer hits the stale behavior live.
//
// This suite closes that gap by re-running the SAME esbuild steps scripts/build.mjs
// uses (compilePluginMain + buildPluginUi) and diffing the result against the
// committed files — never a hand-rolled re-implementation, and never a mock of the
// bundler itself. Every output stays IN MEMORY (`write: false`); this test never
// touches plugin/code.js or plugin/ui.html on disk. Mirrors the drift-check pattern
// in tests/scan-node-walker-bundle.test.ts, which does the same for the CLI's
// bundled walker.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { canonicalizePluginUi } from '../scripts/plugin-build-id.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const common = { bundle: true, target: 'es2020', logLevel: 'silent' as const };

/** Mirrors scripts/build.mjs → compilePluginMain + buildPluginUi exactly, but with
 *  `write: false` throughout so nothing lands on disk. The real build id embeds a
 *  content hash of the final artifacts (chicken-and-egg with the UI bundle that
 *  quotes it), so both here and in scripts/build.mjs the UI is built once with a
 *  placeholder id — irrelevant to this test, since the comparison below normalizes
 *  the id away with the same canonicalizePluginUi the real build id computation uses. */
async function buildPluginArtifactsInMemory(): Promise<{ codeJs: string; html: string }> {
  const mainRes = await esbuild.build({
    ...common,
    entryPoints: [resolve(root, 'plugin/src/main/main.ts')],
    platform: 'browser',
    format: 'iife',
    write: false,
  });
  const codeJs = mainRes.outputFiles[0].text;

  const template = readFileSync(resolve(root, 'plugin/src/ui/panel.html'), 'utf8');
  const worker = await esbuild.build({
    ...common,
    entryPoints: [resolve(root, 'plugin/src/ui/thinking-orb-worker.ts')],
    platform: 'browser',
    format: 'iife',
    write: false,
  });
  const workerSource = worker.outputFiles[0].text;
  const renderChild = await esbuild.build({
    ...common,
    entryPoints: [resolve(root, 'plugin/src/ui/render-child-entry.ts')],
    platform: 'browser',
    format: 'iife',
    write: false,
  });

  const ui = await esbuild.build({
    ...common,
    entryPoints: [resolve(root, 'plugin/src/ui/ui-relay.ts')],
    platform: 'browser',
    format: 'iife',
    write: false,
    define: {
      __BUILD_ID__: JSON.stringify('pending'),
      __THINKING_ORB_WORKER__: JSON.stringify(workerSource),
      __HTML_RENDER_CHILD__: JSON.stringify(renderChild.outputFiles[0].text),
    },
  });

  const MARKER = '/*__FIGMA_AGENT_UI_BUNDLE__*/';
  if (!template.includes(MARKER)) {
    throw new Error(`plugin/src/ui/panel.html is missing the ${MARKER} bundle marker`);
  }
  const html = template.replace(MARKER, () => ui.outputFiles[0].text);
  return { codeJs, html };
}

describe('committed plugin build freshness', () => {
  it('plugin/code.js and plugin/ui.html match a fresh build of plugin/src', async () => {
    const { codeJs, html } = await buildPluginArtifactsInMemory();

    const committedCode = readFileSync(resolve(root, 'plugin/code.js'), 'utf8');
    expect(codeJs).toBe(committedCode);

    const committedHtml = readFileSync(resolve(root, 'plugin/ui.html'), 'utf8');
    expect(canonicalizePluginUi(html)).toBe(canonicalizePluginUi(committedHtml));
  });
});
