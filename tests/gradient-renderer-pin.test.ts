// Guards on the gradient renderer's CDN pin.
//
// These exist because two defects shipped together and neither was catchable by any
// existing test: the pinned version was one that upstream never published (404 on every
// CDN), and the three modules were imported as separate per-package bundles, which gives
// the page two React instances and kills the first render inside the renderer's own hooks.
//
// Both are STATIC properties of the generated render document, so they are checkable here
// without a browser. What is NOT checkable here is whether the pinned version is actually
// published — that needs the network. Verify that by hand at every repin; the version-drift
// test below at least guarantees there is only one place to check.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf8');

const HOST = read('plugin/src/ui/gradient-host.ts');
const CLI = read('cli/src/commands/shader-gradient.ts');
const MANIFEST = JSON.parse(read('plugin/manifest.json')) as {
  networkAccess: { allowedDomains: string[]; devAllowedDomains: string[] };
};

/** The single pinned version, read from its one definition. */
function hostVersion(): string {
  const m = /const RENDERER_VERSION = '([^']+)'/.exec(HOST);
  if (!m) throw new Error('RENDERER_VERSION not found in gradient-host.ts');
  return m[1]!;
}

describe('gradient renderer pin — version agreement', () => {
  it('the CLI records exactly the version the render host loads', () => {
    // The CLI writes this onto the node as provenance. If it drifts from what actually
    // rendered, every baked node carries a false claim about its own origin.
    const m = /const RENDERER = '@shadergradient\/react@([^']+)'/.exec(CLI);
    expect(m, 'RENDERER not found in the CLI command').not.toBeNull();
    expect(m![1]).toBe(hostVersion());
  });

  it('the version is an exact pin, never a range', () => {
    // A range lets a background republish change what a bake produces.
    expect(hostVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('is NOT the unpublished source version from upstream package.json', () => {
    // 2.4.24 is in upstream's package.json at the revision the presets came from, but was
    // never released. Pinning it 404s on every CDN and the bake fails 100% of the time.
    expect(hostVersion()).not.toBe('2.4.24');
  });
});

describe('gradient renderer pin — one React instance', () => {
  it('shares dependencies via a deps pin rather than separate per-package bundles', () => {
    // Without this the renderer resolves its own React and its hooks die on an instance
    // that never mounted: "Cannot read properties of null (reading 'useState')".
    expect(HOST).toContain('?deps=');
  });

  it('never loads the renderer as a standalone bundle with unpinned dependencies', () => {
    const rendererImport = /@shadergradient\/react@\$\{RENDERER_VERSION\}([^`]*)`/.exec(HOST);
    expect(rendererImport, 'renderer import not found').not.toBeNull();
    expect(rendererImport![1]).toContain('?deps=');
  });

  it('pins react-dom to the same react build the page imports', () => {
    expect(HOST).toMatch(/react-dom@\$\{REACT_VERSION\}\/client\?deps=react@\$\{REACT_VERSION\}/);
  });

  it('pins @react-three/fiber, so the resolver cannot pick a React-19-only major', () => {
    // Unpinned, the latest major (v9) is resolved; it requires React 19 and fails against
    // React 18 with an opaque internal error rather than a version complaint.
    const deps = /const DEPS = `([^`]+)`/.exec(HOST);
    expect(deps, 'DEPS not found').not.toBeNull();
    expect(deps![1]).toMatch(/@react-three\/fiber@\d+\.\d+\.\d+/);
    expect(deps![1]).toMatch(/^react@/);
    expect(deps![1]).toContain('three@');
  });
});

describe('gradient renderer pin — manifest declares the host it fetches from', () => {
  it('the CDN base is declared in allowedDomains', () => {
    const m = /const CDN_BASE = '([^']+)'/.exec(HOST);
    expect(m, 'CDN_BASE not found').not.toBeNull();
    const origin = m![1]!;
    // A fetch to an undeclared origin is blocked by Figma at runtime, so a render host
    // pointing anywhere the manifest does not list can never succeed.
    expect(MANIFEST.networkAccess.allowedDomains).toContain(origin);
    expect(MANIFEST.networkAccess.devAllowedDomains).toContain(origin);
  });
});
