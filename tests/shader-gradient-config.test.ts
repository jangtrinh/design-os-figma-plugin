// Pure codec tests for shared/shader-gradient-config.ts. No DOM, no Figma, no network.
//
// The round-trip case at the bottom is the load-bearing one: a baked node stores its
// config as a query string and is re-edited from it, so a lossy or type-dropping
// round-trip would silently degrade a field every time someone touched it.

import { describe, expect, it } from 'vitest';

import {
  parseQuery,
  resolveConfig,
  toQueryString,
} from '../shared/shader-gradient-config';
import { SHADER_GRADIENT_PRESETS } from '../shared/shader-gradient-presets';

describe('parseQuery', () => {
  it('parses a bare query string', () => {
    expect(parseQuery('animate=on&uSpeed=0.4')).toEqual({ animate: 'on', uSpeed: '0.4' });
  });

  it('parses a full customize URL, ignoring everything before the ?', () => {
    const url = 'https://www.shadergradient.co/customize?animate=on&cDistance=3.6';
    expect(parseQuery(url)).toEqual({ animate: 'on', cDistance: '3.6' });
  });

  it('percent-decodes values — a hex colour arrives as %23rrggbb', () => {
    expect(parseQuery('color1=%2352ff89')).toEqual({ color1: '#52ff89' });
  });

  it('treats + as a space, the way a query string means it', () => {
    expect(parseQuery('shader=a+b')).toEqual({ shader: 'a b' });
  });

  it('returns an empty object for an empty string', () => {
    expect(parseQuery('')).toEqual({});
  });
});

describe('resolveConfig — presets', () => {
  it('resolves every ledger slug', () => {
    for (const slug of Object.keys(SHADER_GRADIENT_PRESETS)) {
      const r = resolveConfig({ preset: slug });
      expect(r.ok, `preset '${slug}' failed to resolve`).toBe(true);
    }
  });

  it('resolves upstream camelCase keys as aliases', () => {
    const r = resolveConfig({ preset: 'nightyNight' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.slug).toBe('nighty-night');
  });

  it('rejects an unknown preset and names the known ones', () => {
    const r = resolveConfig({ preset: 'nope' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('E_UNKNOWN_PRESET');
    expect(r.message).toContain('halo');
  });

  it('refuses an empty request rather than rendering a default nobody asked for', () => {
    const r = resolveConfig({});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('E_NO_CONFIG');
  });

  it('a resolved preset carries every declared prop', () => {
    const r = resolveConfig({ preset: 'halo' });
    if (!r.ok) throw new Error('expected ok');
    expect(Object.keys(r.props).sort()).toEqual(Object.keys(SHADER_GRADIENT_PRESETS['halo']!.props).sort());
  });

  it('does not mutate the shared preset table', () => {
    const before = SHADER_GRADIENT_PRESETS['halo']!.props.uSpeed;
    const r = resolveConfig({ preset: 'halo', overrides: ['uSpeed=9'] });
    expect(r.ok).toBe(true);
    expect(SHADER_GRADIENT_PRESETS['halo']!.props.uSpeed).toBe(before);
  });
});

describe('resolveConfig — typing, the thing a naive merge gets wrong', () => {
  it('coerces numeric strings to numbers', () => {
    const r = resolveConfig({ preset: 'halo', url: 'uSpeed=0.75' });
    if (!r.ok) throw new Error('expected ok');
    expect(r.props.uSpeed).toBe(0.75);
    expect(typeof r.props.uSpeed).toBe('number');
  });

  it('coerces wireframe to a real boolean', () => {
    const r = resolveConfig({ preset: 'halo', url: 'wireframe=true' });
    if (!r.ok) throw new Error('expected ok');
    expect(r.props.wireframe).toBe(true);
  });

  it('rejects a non-numeric value for a numeric key instead of passing NaN through', () => {
    const r = resolveConfig({ preset: 'halo', url: 'uSpeed=fast' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('E_BAD_VALUE');
  });

  it('rejects an EMPTY numeric value — Number("") is 0 and would look deliberate', () => {
    const r = resolveConfig({ preset: 'halo', url: 'uSpeed=' });
    expect(r.ok).toBe(false);
  });

  it('rejects a value outside a closed enum', () => {
    const r = resolveConfig({ preset: 'halo', url: 'type=torus' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('plane|sphere|waterPlane');
  });

  it('rejects a malformed colour', () => {
    expect(resolveConfig({ preset: 'halo', url: 'color1=red' }).ok).toBe(false);
    expect(resolveConfig({ preset: 'halo', url: 'color1=%23fff' }).ok).toBe(false);
    expect(resolveConfig({ preset: 'halo', url: 'color1=%23ff5005' }).ok).toBe(true);
  });

  it('rejects a genuinely unknown key rather than dropping it silently', () => {
    // Not an upstream key at all — a typo or a version drift, worth failing on.
    // Upstream's own editor-only keys take the separate "ignored" path instead;
    // see the real-customize-URL block below for why the two must differ.
    const r = resolveConfig({ preset: 'halo', url: 'uSpeeed=1' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('E_UNKNOWN_KEY');
  });

  it('accepts every shader family, including the three no preset uses', () => {
    for (const shader of ['defaults', 'positionMix', 'cosmic', 'glass']) {
      expect(resolveConfig({ preset: 'halo', url: `shader=${shader}` }).ok, shader).toBe(true);
    }
  });
});

describe('resolveConfig — precedence', () => {
  it('overrides beat the url, and the url beats the preset', () => {
    const r = resolveConfig({ preset: 'halo', url: 'uSpeed=1', overrides: ['uSpeed=2'] });
    if (!r.ok) throw new Error('expected ok');
    expect(r.props.uSpeed).toBe(2);
  });

  it('a url-only config still yields a complete prop set', () => {
    const r = resolveConfig({ url: 'uSpeed=1.5' });
    if (!r.ok) throw new Error('expected ok');
    expect(r.props.uSpeed).toBe(1.5);
    expect(r.props.type).toBeDefined();
    expect(r.props.color1).toBeDefined();
    expect(r.slug).toBeNull(); // no preset was named, and none is claimed
  });

  it('rejects a malformed override', () => {
    const r = resolveConfig({ preset: 'halo', overrides: ['uSpeed'] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('E_BAD_OVERRIDE');
  });
});

describe('toQueryString — the re-editability contract', () => {
  it('is byte-stable for the same props', () => {
    const r = resolveConfig({ preset: 'mint' });
    if (!r.ok) throw new Error('expected ok');
    expect(toQueryString(r.props)).toBe(toQueryString(r.props));
  });

  it('round-trips every preset with no loss and no type drift', () => {
    for (const slug of Object.keys(SHADER_GRADIENT_PRESETS)) {
      const first = resolveConfig({ preset: slug });
      if (!first.ok) throw new Error(`preset ${slug} failed`);
      const round = resolveConfig({ url: toQueryString(first.props) });
      if (!round.ok) throw new Error(`round-trip of ${slug} failed: ${round.message}`);
      expect(round.props, `preset '${slug}' did not survive a round-trip`).toEqual(first.props);
    }
  });

  it('round-trips a hand-configured surface no preset uses', () => {
    const first = resolveConfig({ preset: 'halo', overrides: ['shader=glass', 'type=sphere'] });
    if (!first.ok) throw new Error('expected ok');
    const round = resolveConfig({ url: toQueryString(first.props) });
    if (!round.ok) throw new Error('round-trip failed');
    expect(round.props.shader).toBe('glass');
    expect(round.props.type).toBe('sphere');
  });
});

describe('resolveConfig — real customize URLs, the primary --url input', () => {
  // A link copied from upstream's own customize page carries editor and export state
  // beside the render props. Failing the whole URL on one of those would break --url
  // for its most common input; dropping them silently would hide what was lost.
  const REAL_URL =
    'https://www.shadergradient.co/customize?animate=on&axesHelper=off&bgColor1=%23000000'
    + '&cDistance=3.6&color1=%2352ff89&destination=onCanvas&embedMode=off&format=gif'
    + '&frameRate=10&gizmoHelper=hide&lightType=3d&range=disabled&rangeEnd=40&rangeStart=0'
    + '&shader=defaults&type=plane&uFrequency=5.5&uSpeed=0.4&uStrength=4';

  it('accepts a real customize URL', () => {
    const r = resolveConfig({ url: REAL_URL });
    expect(r.ok, r.ok ? '' : r.message).toBe(true);
  });

  it('applies the render props from it', () => {
    const r = resolveConfig({ url: REAL_URL });
    if (!r.ok) throw new Error(r.message);
    expect(r.props.color1).toBe('#52ff89');
    expect(r.props.uSpeed).toBe(0.4);
    expect(r.props.cDistance).toBe(3.6);
  });

  it('reports every ignored key instead of dropping it silently', () => {
    const r = resolveConfig({ url: REAL_URL });
    if (!r.ok) throw new Error(r.message);
    expect(r.ignored).toContain('gizmoHelper');
    expect(r.ignored).toContain('frameRate');
    expect(r.ignored).toContain('axesHelper');
    expect(r.ignored).toContain('destination');
  });

  it('still hard-fails a key that is neither rendered nor known upstream', () => {
    const r = resolveConfig({ url: 'notARealKey=1' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('E_UNKNOWN_KEY');
  });

  it('reports an ignored key only once even when it appears twice', () => {
    const r = resolveConfig({ preset: 'halo', url: 'gizmoHelper=hide', overrides: ['gizmoHelper=show'] });
    if (!r.ok) throw new Error(r.message);
    expect(r.ignored.filter((k) => k === 'gizmoHelper')).toHaveLength(1);
  });

  it('a clean config reports nothing ignored', () => {
    const r = resolveConfig({ preset: 'halo' });
    if (!r.ok) throw new Error(r.message);
    expect(r.ignored).toEqual([]);
  });
});
