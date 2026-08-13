import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  canonicalizePluginUi,
  computePluginBuildId,
  extractPluginBuildId,
} from '../scripts/plugin-build-id.mjs';

const artifacts = {
  code: 'plugin main bundle',
  manifest: '{"name":"plugin"}',
  panel: '<main>panel</main>',
  ui: 'plugin UI bundle',
};

describe('plugin build identity', () => {
  it.each(Object.keys(artifacts) as Array<keyof typeof artifacts>)(
    'changes when %s changes',
    (artifact) => {
      const changed = { ...artifacts, [artifact]: `${artifacts[artifact]} updated` };
      expect(computePluginBuildId(changed)).not.toBe(computePluginBuildId(artifacts));
    },
  );

  it('is independent of object insertion order', () => {
    const reversed = Object.fromEntries(Object.entries(artifacts).reverse());
    expect(computePluginBuildId(reversed)).toBe(computePluginBuildId(artifacts));
  });

  it('matches the complete plugin artifacts loaded through manifest.json', () => {
    const pluginUrl = new URL('../plugin/', import.meta.url);
    const code = readFileSync(fileURLToPath(new URL('code.js', pluginUrl)));
    const manifest = readFileSync(fileURLToPath(new URL('manifest.json', pluginUrl)));
    const ui = readFileSync(fileURLToPath(new URL('ui.html', pluginUrl)), 'utf8');

    expect(extractPluginBuildId(ui)).toBe(computePluginBuildId({
      code,
      manifest,
      ui: canonicalizePluginUi(ui),
    }));
  });
});
