// CLI_VERSION (cli/src/version.ts) is a bundled constant, not a runtime
// package.json read — this is the ONE test allowed to open package.json and
// prove the two never drift apart.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CLI_VERSION } from '../cli/src/version.ts';

describe('CLI_VERSION stays in lockstep with package.json', () => {
  it('matches package.json\'s own "version" field', () => {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
    expect(CLI_VERSION).toBe(pkg.version);
  });
});
