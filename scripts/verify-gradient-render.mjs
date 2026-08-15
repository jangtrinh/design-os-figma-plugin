// Render the REAL gradient document in a real browser and prove it produces a real image.
//
// Not a CI gate: it needs the network (the renderer is fetched at render time) and a
// Chromium build, neither of which the test suite assumes. Run it by hand whenever the
// renderer pin, its dependency pins, or buildRenderDocument's import block changes.
//
//   node scripts/verify-gradient-render.mjs [--preset halo] [--out /tmp/field.png]
//
// Why this exists: the bake shipped with two defects that a fully green suite could not
// see — a version upstream never published, and three separate module bundles that gave
// the page two React instances. Both lived inside the generated document, and both are
// invisible to every static check. The only thing that finds them is rendering.
//
// It calls renderGradientToPng from the plugin source, so it exercises exactly what ships —
// iframe creation, token correlation, message plumbing, PNG decode, and teardown. Rebuilding
// any of that here would test the harness instead of the product, and the first draft of this
// script proved the point by getting a parent-side detail wrong and reporting a false failure.
//
// What it does NOT prove: that Figma's own plugin iframe grants WebGL. That sandbox is not
// reproducible here — use `figma-agent shader-gradient --self-test` against a live file.

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const PRESET = arg('preset', 'halo');
const OUT = arg('out', join(tmpdir(), `gradient-verify-${PRESET}.png`));

function die(code, msg, hint) {
  console.error(`\n  FAIL  ${msg}`);
  if (hint) console.error(`        ${hint}`);
  process.exit(code);
}

// ── Load the shipped modules ────────────────────────────────────────────────
// esbuild is already a devDependency and the plugin sources are TS with DOM types,
// so bundle to a temp ESM file rather than adding a TS runtime loader.
let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  die(3, 'playwright-core is not installed.', 'npm i -D playwright-core  (and have a Chromium build available)');
}

const esbuild = await import('esbuild');
const tmp = mkdtempSync(join(tmpdir(), 'gradient-verify-'));

// Bundle the render host as a browser global and call its REAL entry point inside the page.
// Rebuilding the parent half here (iframe creation, token correlation, message plumbing,
// PNG decode, teardown) would test the harness rather than the product — and it was exactly
// a parent-side detail that the first draft of this script got wrong.
const hostBundle = join(tmp, 'host.js');
await esbuild.build({
  entryPoints: [join(ROOT, 'plugin/src/ui/gradient-host.ts')],
  outfile: hostBundle,
  bundle: true,
  format: 'iife',
  globalName: 'GradientHost',
  platform: 'browser',
  logLevel: 'silent',
});

const presetsBundle = join(tmp, 'presets.mjs');
await esbuild.build({
  entryPoints: [join(ROOT, 'shared/shader-gradient-presets.ts')],
  outfile: presetsBundle,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  logLevel: 'silent',
});
const { SHADER_GRADIENT_PRESETS } = await import(pathToFileURL(presetsBundle).href);

const preset = SHADER_GRADIENT_PRESETS[PRESET];
if (!preset) die(2, `unknown preset '${PRESET}'`, `known: ${Object.keys(SHADER_GRADIENT_PRESETS).join(', ')}`);

// ── Find a Chromium ─────────────────────────────────────────────────────────
const executablePath = process.env.CHROME || process.env.CHROMIUM_PATH;
const launchOpts = {
  // SwiftShader so this works on a headless machine with no GPU. The renderer only needs
  // *a* WebGL context; which implementation backs it does not change whether it compiles.
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
  ...(executablePath ? { executablePath } : {}),
};

let browser;
try {
  browser = await chromium.launch(launchOpts);
} catch (e) {
  die(3, `could not launch Chromium: ${String(e.message).split('\n')[0]}`,
      'set CHROME=/path/to/chromium, or run: npx playwright install chromium');
}

// ── Render through the real entry point ─────────────────────────────────────
const W = 480, H = 300;
const page = await browser.newPage({ viewport: { width: W, height: H } });
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => consoleErrors.push(String(e.message).slice(0, 200)));

await page.setContent('<!doctype html><html><body></body></html>', { waitUntil: 'load' });
await page.addScriptTag({ content: readFileSync(hostBundle, 'utf8') });

const outcome = await page.evaluate(async ({ props, w, h }) => {
  try {
    const bytes = await window.GradientHost.renderGradientToPng({
      props, width: w, height: h, scale: 1, staticFrame: false,
    });
    return { ok: true, bytes: Array.from(bytes) };
  } catch (e) {
    return { ok: false, code: e && e.code ? e.code : 'E_UNKNOWN', message: String(e && e.message ? e.message : e) };
  }
}, { props: preset.props, w: W, h: H });

// Teardown is part of the contract: an orphaned iframe keeps a WebGL context alive.
const leakedFrames = await page.evaluate(() => document.querySelectorAll('iframe').length);

await browser.close();
rmSync(tmp, { recursive: true, force: true });

// ── Report ──────────────────────────────────────────────────────────────────
console.log(`\n  preset    ${PRESET} (${preset.name})`);
console.log(`  surface   ${preset.props.shader} / ${preset.props.type}`);

if (!outcome.ok) {
  console.error(`\n  code      ${outcome.code}`);
  console.error(`  message   ${outcome.message}`);
  if (consoleErrors.length) consoleErrors.slice(0, 3).forEach((e) => console.error(`        ${e}`));
  die(1, 'renderGradientToPng rejected.');
}

const bytes = Buffer.from(outcome.bytes);
writeFileSync(OUT, bytes);

const KB = bytes.length / 1024;
console.log(`  bytes     ${KB.toFixed(0)}KB`);
console.log(`  written   ${OUT}`);

// A PNG signature check, because "some bytes came back" is not the same as "an image did".
const isPng = bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
if (!isPng) die(1, 'the returned bytes are not a PNG.');

// A capture can succeed and still be a blank frame — the failure mode E_EMPTY_CAPTURE
// exists for, worth re-checking independently of the renderer's own guard.
if (KB < 4) {
  die(1, `the capture is implausibly small (${KB.toFixed(1)}KB) — probably a blank frame.`,
      'a real field at this size is tens to hundreds of KB.');
}

if (leakedFrames !== 0) {
  die(1, `teardown leaked ${leakedFrames} iframe(s).`,
      'an orphaned render iframe holds a WebGL context open.');
}

if (consoleErrors.length) {
  console.log(`\n  note      ${consoleErrors.length} console error(s) during render, image produced anyway:`);
  consoleErrors.slice(0, 3).forEach((e) => console.log(`            ${e}`));
}

console.log(`\n  PASS  the shipped render path produces a real image and cleans up after itself.`);
console.log(`        This does NOT prove Figma's plugin iframe grants WebGL —`);
console.log(`        run: figma-agent shader-gradient --self-test\n`);
