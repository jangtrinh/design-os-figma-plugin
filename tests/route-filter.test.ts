// Phase 03 — the routing precedence rule, pure: --instance (exact, unique) > --file (exact)
// > the daemon's targetInstancePin (#35 P2) > FIGMA_AGENT_FILE (substring) > active plugin.
// One comparison (`fileMatches`) backs both name-routing and the plugin-side guard, so they
// can never disagree. `kind` on the resolved filter tells the registry whether `value` is a
// name or an opaque instanceId.
import { describe, it, expect } from 'vitest';
import { resolveRouteFilter, fileMatches, pinDisconnected } from '../cli/src/transport/route-filter.ts';

describe('resolveRouteFilter — precedence', () => {
  it('--instance set (alone) → flag wins, exact, kind:instance', () => {
    expect(resolveRouteFilter(undefined, undefined, 'p_3_1712345')).toEqual({
      value: 'p_3_1712345', exact: true, source: 'flag', kind: 'instance',
    });
  });

  it('--instance + --file both set → instance wins (highest precedence)', () => {
    expect(resolveRouteFilter('VSF - PCP', undefined, 'p_3_1712345')).toEqual({
      value: 'p_3_1712345', exact: true, source: 'flag', kind: 'instance',
    });
  });

  it('--instance + env both set → instance wins', () => {
    expect(resolveRouteFilter(undefined, 'design', 'p_3_1712345')).toEqual({
      value: 'p_3_1712345', exact: true, source: 'flag', kind: 'instance',
    });
  });

  it('--instance + --file + env all set → instance wins over everything', () => {
    expect(resolveRouteFilter('VSF - PCP', 'design', 'p_3_1712345')).toEqual({
      value: 'p_3_1712345', exact: true, source: 'flag', kind: 'instance',
    });
  });

  it('a whitespace-only --instance is treated as unset — falls through to --file', () => {
    expect(resolveRouteFilter('VSF - PCP', 'design', '   ')).toEqual({
      value: 'VSF - PCP', exact: true, source: 'flag', kind: 'name',
    });
  });

  it('--file set + env set (no --instance) → --file wins, exact, kind:name', () => {
    expect(resolveRouteFilter('VSF - PCP', 'design')).toEqual({ value: 'VSF - PCP', exact: true, source: 'flag', kind: 'name' });
  });

  it('only env set → env, substring, kind:name', () => {
    expect(resolveRouteFilter(undefined, 'design')).toEqual({ value: 'design', exact: false, source: 'env', kind: 'name' });
  });

  it('neither set → none, unrestricted, kind:name', () => {
    expect(resolveRouteFilter(undefined, undefined)).toEqual({ value: null, exact: false, source: 'none', kind: 'name' });
    expect(resolveRouteFilter(null, null)).toEqual({ value: null, exact: false, source: 'none', kind: 'name' });
  });

  it('a whitespace-only --file is treated as unset — falls through to the env pin', () => {
    expect(resolveRouteFilter('   ', 'design')).toEqual({ value: 'design', exact: false, source: 'env', kind: 'name' });
  });

  it('a whitespace-only env pin with no --file → none', () => {
    expect(resolveRouteFilter(undefined, '   ')).toEqual({ value: null, exact: false, source: 'none', kind: 'name' });
  });
});

// #35 P2 — the daemon's runtime `targetInstancePin` (panel "Target this plugin" button),
// ranked between --file and the env pin. The caller passes the pin only once it has
// already verified liveness (`pinDisconnected`, below) — a disconnected pin is never
// passed through here at all.
describe('resolveRouteFilter — the runtime target pin (#35 P2)', () => {
  it('pin set alone (no --instance, no --file) → pin wins over the env pin, exact, kind:instance', () => {
    expect(resolveRouteFilter(undefined, 'design', undefined, 'p_7_1712999')).toEqual({
      value: 'p_7_1712999', exact: true, source: 'pin', kind: 'instance',
    });
  });

  it('--instance set alongside a pin → --instance still wins (per-request always overrides)', () => {
    expect(resolveRouteFilter(undefined, undefined, 'p_3_1712345', 'p_7_1712999')).toEqual({
      value: 'p_3_1712345', exact: true, source: 'flag', kind: 'instance',
    });
  });

  it('--file set alongside a pin → --file still wins (per-request always overrides)', () => {
    expect(resolveRouteFilter('VSF - PCP', undefined, undefined, 'p_7_1712999')).toEqual({
      value: 'VSF - PCP', exact: true, source: 'flag', kind: 'name',
    });
  });

  it('pin set, no env → pin still applies (does not require an env pin to exist)', () => {
    expect(resolveRouteFilter(undefined, undefined, undefined, 'p_7_1712999')).toEqual({
      value: 'p_7_1712999', exact: true, source: 'pin', kind: 'instance',
    });
  });

  it('no pin (null/undefined) → falls through to the env pin exactly as before', () => {
    expect(resolveRouteFilter(undefined, 'design', undefined, null)).toEqual({
      value: 'design', exact: false, source: 'env', kind: 'name',
    });
    expect(resolveRouteFilter(undefined, 'design', undefined, undefined)).toEqual({
      value: 'design', exact: false, source: 'env', kind: 'name',
    });
  });

  it('a whitespace-only pin is treated as unset — falls through to the env pin', () => {
    expect(resolveRouteFilter(undefined, 'design', undefined, '   ')).toEqual({
      value: 'design', exact: false, source: 'env', kind: 'name',
    });
  });
});

// The disconnected-pin refusal predicate: Law 1 (a standing pin must never silently
// re-point at another plugin) means the daemon refuses outright instead of calling
// resolveRouteFilter with a null pin — this is the pure seam that decision routes through.
describe('pinDisconnected — Law 1: a dead pin refuses, never falls through (#35 P2)', () => {
  it('no pin set at all → never disconnected (nothing to refuse)', () => {
    expect(pinDisconnected(undefined, undefined, null, false)).toBe(false);
    expect(pinDisconnected(undefined, undefined, undefined, false)).toBe(false);
  });

  it('pin set and live → not disconnected', () => {
    expect(pinDisconnected(undefined, undefined, 'p_7_1712999', true)).toBe(false);
  });

  it('pin set and NOT live, no per-request flag → disconnected, must refuse', () => {
    expect(pinDisconnected(undefined, undefined, 'p_7_1712999', false)).toBe(true);
  });

  it('pin set and NOT live, but --instance overrides it → never disconnected (per-request bypasses the pin entirely)', () => {
    expect(pinDisconnected(undefined, 'p_3_1712345', 'p_7_1712999', false)).toBe(false);
  });

  it('pin set and NOT live, but --file overrides it → never disconnected', () => {
    expect(pinDisconnected('VSF - PCP', undefined, 'p_7_1712999', false)).toBe(false);
  });

  it('a whitespace-only pin is treated as unset — never disconnected', () => {
    expect(pinDisconnected(undefined, undefined, '   ', false)).toBe(false);
  });
});

describe('fileMatches', () => {
  it('substring mode is case-insensitive', () => {
    expect(fileMatches('Design System', 'design', false)).toBe(true);
  });

  it('exact mode requires the whole name', () => {
    expect(fileMatches('Design System', 'design', true)).toBe(false);
  });

  it('exact mode trims and lowercases both sides', () => {
    expect(fileMatches('VSF - PCP', ' vsf - pcp ', true)).toBe(true);
  });

  it('null/undefined actual never matches', () => {
    expect(fileMatches(null, 'design', false)).toBe(false);
    expect(fileMatches(undefined, 'design', true)).toBe(false);
  });
});
