// Single source of the CLI's own version string — bundled at build time
// (esbuild inlines this constant; no runtime fs read, no package.json parse in
// the shipped binary). Kept in lockstep with package.json's "version" field by
// tests/cli-version.test.ts, the only place in this repo that reads
// package.json at test time to prove it.
import { BRIDGE_VERSION } from '../../shared/version.ts';

export const CLI_VERSION = BRIDGE_VERSION;
