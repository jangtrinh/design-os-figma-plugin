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

  it('a marker entry with fileKey MISSING (crossed a trust boundary, e.g. a hand-edited marker) never fabricates figma://file/undefined', () => {
    // The type says `string | null`, but readBindMarker's own parse from disk cannot
    // enforce that at runtime — reproduce the exact malformed shape a corrupt/hand-edited
    // JSON file could produce.
    const malformed = {} as unknown as { fileKey: string | null };
    const result = buildDeepLink(malformed);
    expect(result.url).toBeNull(); // never "figma://file/undefined"
    expect(result.reason).toMatch(/Free plan/);
  });

  it('a marker entry with fileKey as an EMPTY STRING never fabricates figma://file/', () => {
    const result = buildDeepLink({ fileKey: '' });
    expect(result.url).toBeNull(); // never "figma://file/"
    expect(result.reason).toMatch(/Free plan/);
  });
});
