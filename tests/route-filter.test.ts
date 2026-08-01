// Phase 03 — the routing precedence rule, pure: --instance (exact, unique) > --file (exact)
// > FIGMA_AGENT_FILE (substring) > active plugin. One comparison (`fileMatches`) backs both
// name-routing and the plugin-side guard, so they can never disagree. `kind` on the resolved
// filter tells the registry whether `value` is a name or an opaque instanceId.
import { describe, it, expect } from 'vitest';
import { resolveRouteFilter, fileMatches } from '../cli/src/transport/route-filter.ts';

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
