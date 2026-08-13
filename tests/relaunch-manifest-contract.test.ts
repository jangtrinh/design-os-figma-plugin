import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const manifestPath = fileURLToPath(new URL('../plugin/manifest.json', import.meta.url));
const codePath = fileURLToPath(new URL('../plugin/code.js', import.meta.url));
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  relaunchButtons?: Array<{ command?: unknown; name?: unknown }>;
};
const loadedCode = readFileSync(codePath, 'utf8');

describe('Figma relaunch manifest contract', () => {
  it('declares every command stored by setRelaunchData', () => {
    const storedCommands = [...loadedCode.matchAll(/setRelaunchData\(\{\s*([a-zA-Z0-9_-]+)\s*:/g)]
      .map((match) => match[1]);
    const declaredButtons = manifest.relaunchButtons ?? [];
    const declaredCommands = declaredButtons.map((button) => button.command);

    expect(storedCommands).not.toHaveLength(0);
    expect(declaredCommands).toEqual(expect.arrayContaining(storedCommands));
    expect(declaredButtons.every((button) => typeof button.name === 'string' && button.name.length > 0)).toBe(true);
  });
});
