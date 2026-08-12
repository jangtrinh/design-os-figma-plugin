// Pure table-driven test for buildDeepLink's three cases (phase-02 design table).
// UNVERIFIED: whether `figma://file/<fileKey>` is the exact desktop URL scheme Figma
// resolves — flagged as an owner live-test item, never claimed as confirmed here.
import { describe, expect, it } from 'vitest';
import { buildDeepLink } from '../cli/src/transport/figma-deep-link.ts';

describe('buildDeepLink — never fabricates a link', () => {
  it('a bound entry with a real fileKey builds figma://file/<fileKey>', () => {
    expect(buildDeepLink({ fileKey: 'ABC123' })).toEqual({ url: 'figma://file/ABC123', reason: null });
  });

  it('a bound entry with fileKey:null (Figma Free, or never-yet-connected) → null + reason', () => {
    const result = buildDeepLink({ fileKey: null });
    expect(result.url).toBeNull();
    expect(result.reason).toMatch(/Free plan/);
  });

  it('no binding at all → null + a reason naming the fix (`figma-agent bind`)', () => {
    const result = buildDeepLink(null);
    expect(result.url).toBeNull();
    expect(result.reason).toMatch(/figma-agent bind/);
  });
});
