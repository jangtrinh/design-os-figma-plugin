// Single source of the bridge version across the CLI, Figma plugin main thread,
// and plugin UI iframe. Inlined at build time by esbuild (no runtime fs reads)
// and kept in lockstep with package.json by tests/cli-version.test.ts.
export const BRIDGE_VERSION = '0.2.1';
