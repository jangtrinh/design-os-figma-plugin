// Pure ShaderGradient config codec — resolves a preset slug, a shadergradient.co
// customize URL, or explicit key=value overrides into one validated prop set.
//
// DOM-free and figma-free on purpose: the CLI validates a config before it ever
// reaches the broker, and the plugin UI re-validates what arrives. Both call this
// same module, so a config the CLI accepts can never be one the renderer rejects.
//
// Upstream's own query-string format is the interchange: the customize page emits
// `?animate=on&cDistance=3.6&color1=%23ff5005...`, and every value arrives as a
// string. Typing them back is this module's real job — a naive Object.assign would
// hand the renderer `uSpeed: "0.4"` and produce a field that silently never moves.

import { SHADER_GRADIENT_PRESETS, slugForUpstreamKey } from './shader-gradient-presets';
import type { ShaderGradientProps } from './shader-gradient-presets';

/** Keys whose value is a number. Anything else arriving numeric-looking stays a string. */
const NUMERIC_KEYS = new Set<keyof ShaderGradientProps>([
  'uTime', 'uSpeed', 'uStrength', 'uDensity', 'uFrequency', 'uAmplitude',
  'positionX', 'positionY', 'positionZ', 'rotationX', 'rotationY', 'rotationZ',
  'reflection', 'cAzimuthAngle', 'cPolarAngle', 'cDistance', 'cameraZoom',
  'brightness', 'pixelDensity', 'fov',
]);

const BOOLEAN_KEYS = new Set<keyof ShaderGradientProps>(['wireframe']);

/** Closed value sets. A value outside one is an error, never a silent pass-through. */
const ENUMS: Partial<Record<keyof ShaderGradientProps, readonly string[]>> = {
  type: ['plane', 'sphere', 'waterPlane'],
  animate: ['on', 'off'],
  grain: ['on', 'off'],
  lightType: ['3d', 'env'],
  envPreset: ['city', 'dawn', 'lobby'],
  shader: ['defaults', 'positionMix', 'cosmic', 'glass'],
};

const COLOR_KEYS = new Set<keyof ShaderGradientProps>(['color1', 'color2', 'color3']);

const ALL_KEYS = new Set<string>([
  ...NUMERIC_KEYS, ...BOOLEAN_KEYS, ...COLOR_KEYS, ...Object.keys(ENUMS),
] as string[]);

/**
 * Keys upstream really emits that this bake does not render.
 *
 * A genuine `shadergradient.co/customize` URL carries editor state (`gizmoHelper`),
 * GIF-export settings (`frameRate`, `format`, `range*`), and live-canvas-only controls
 * (`lazyLoad`, `enableTransition`) alongside the render props. Rejecting the whole URL
 * because it contains one of them would make `--url` fail on its single most common
 * input — a link the user copied from upstream's own customize page.
 *
 * So these are ACCEPTED and REPORTED as ignored, never silently dropped: the caller is
 * told exactly which settings did not survive the bake. A key in neither set is still a
 * hard error, because that one really is a typo or a version drift worth surfacing.
 */
const IGNORED_KEYS = new Set<string>([
  // authoring-tool state
  'axesHelper', 'gizmoHelper', 'embedMode', 'toggleAxis', 'zoomOut', 'hoverState',
  'control', 'isFigmaPlugin', 'urlString', 'envBasePath',
  // GIF / video export pipeline
  'destination', 'format', 'frameRate', 'range', 'rangeStart', 'rangeEnd',
  'loop', 'loopDuration',
  // live-canvas behaviour with no meaning for a single baked frame
  'lazyLoad', 'threshold', 'rootMargin', 'enableTransition', 'enableCameraUpdate',
  'smoothTime', 'rotSpringOption', 'posSpringOption',
  'preserveDrawingBuffer', 'powerPreference',
  // accepted but not applied by this renderer path
  'grainBlending', 'bgColor1', 'bgColor2',
]);

export type ConfigResult =
  | { ok: true; slug: string | null; props: ShaderGradientProps; ignored: readonly string[] }
  | { ok: false; code: string; message: string };

export interface ResolveInput {
  /** Kebab slug or upstream camelCase key. */
  preset?: string;
  /** A shadergradient.co customize URL, or a bare query string. */
  url?: string;
  /** Explicit `key=value` overrides, applied last. */
  overrides?: readonly string[];
}

/** Parse a query string (or a full URL) into raw string pairs. Unknown keys are reported, not dropped. */
export function parseQuery(urlOrQuery: string): Record<string, string> {
  const q = urlOrQuery.includes('?') ? urlOrQuery.slice(urlOrQuery.indexOf('?') + 1) : urlOrQuery;
  const out: Record<string, string> = {};
  for (const part of q.split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    // A bare flag has no value. Upstream never emits one; treating it as empty
    // rather than skipping keeps it visible to the unknown-key check below.
    const rawKey = eq === -1 ? part : part.slice(0, eq);
    const rawVal = eq === -1 ? '' : part.slice(eq + 1);
    out[decodeURIComponent(rawKey)] = decodeURIComponent(rawVal.replace(/\+/g, ' '));
  }
  return out;
}

/** Coerce one raw string to its typed value, or return an error message. */
function coerce(key: string, raw: string): { ok: true; value: unknown } | { ok: false; message: string } {
  const k = key as keyof ShaderGradientProps;

  const enumValues = ENUMS[k];
  if (enumValues !== undefined) {
    if (!enumValues.includes(raw)) {
      return { ok: false, message: `'${key}' must be one of ${enumValues.join('|')}, got '${raw}'` };
    }
    return { ok: true, value: raw };
  }

  if (NUMERIC_KEYS.has(k)) {
    // Number('') is 0 and Number('abc') is NaN — both would sail past a bare
    // Number() call and reach the renderer as a plausible-looking value.
    if (raw.trim() === '') return { ok: false, message: `'${key}' is empty, expected a number` };
    const n = Number(raw);
    if (!Number.isFinite(n)) return { ok: false, message: `'${key}' must be a finite number, got '${raw}'` };
    return { ok: true, value: n };
  }

  if (BOOLEAN_KEYS.has(k)) {
    if (raw === 'true') return { ok: true, value: true };
    if (raw === 'false') return { ok: true, value: false };
    return { ok: false, message: `'${key}' must be true or false, got '${raw}'` };
  }

  if (COLOR_KEYS.has(k)) {
    if (!/^#[0-9a-fA-F]{6}$/.test(raw)) {
      return { ok: false, message: `'${key}' must be a 6-digit hex colour like #ff5005, got '${raw}'` };
    }
    return { ok: true, value: raw };
  }

  return { ok: false, message: `unknown config key '${key}'` };
}

/**
 * Resolve a preset / url / overrides triple into one complete, typed prop set.
 *
 * Precedence, lowest to highest: preset -> url -> overrides. A url without a
 * preset starts from the default preset's props rather than from nothing,
 * because upstream's customize page omits any prop left at its default and a
 * partial prop set would render a field with undefined uniforms.
 */
export function resolveConfig(input: ResolveInput): ConfigResult {
  let slug: string | null = null;
  let base: ShaderGradientProps | null = null;

  if (input.preset !== undefined) {
    const direct = SHADER_GRADIENT_PRESETS[input.preset];
    if (direct !== undefined) {
      slug = input.preset;
    } else {
      const aliased = slugForUpstreamKey(input.preset);
      if (aliased === null) {
        return {
          ok: false,
          code: 'E_UNKNOWN_PRESET',
          message: `unknown preset '${input.preset}' — known slugs: ${Object.keys(SHADER_GRADIENT_PRESETS).join(', ')}`,
        };
      }
      slug = aliased;
    }
    base = { ...SHADER_GRADIENT_PRESETS[slug]!.props };
  }

  if (base === null) {
    if (input.url === undefined && (input.overrides === undefined || input.overrides.length === 0)) {
      return { ok: false, code: 'E_NO_CONFIG', message: 'nothing to render — pass a preset, a url, or overrides' };
    }
    // Default ground for a url/override-only config. Named explicitly so the
    // choice is visible: a caller reading a diff can see which preset's defaults
    // filled the props they never supplied.
    const fallbackSlug = 'halo';
    base = { ...SHADER_GRADIENT_PRESETS[fallbackSlug]!.props };
  }

  const ignored: string[] = [];
  const apply = (pairs: Record<string, string>): { ok: false; code: string; message: string } | null => {
    for (const [key, raw] of Object.entries(pairs)) {
      if (IGNORED_KEYS.has(key)) {
        // Known to upstream, not rendered here. Recorded and returned to the caller
        // rather than dropped, so the user learns which settings did not survive.
        if (!ignored.includes(key)) ignored.push(key);
        continue;
      }
      if (!ALL_KEYS.has(key)) {
        // Neither rendered nor known — a typo or upstream drift, and worth failing on.
        return { ok: false, code: 'E_UNKNOWN_KEY', message: `unknown config key '${key}'` };
      }
      const c = coerce(key, raw);
      if (!c.ok) return { ok: false, code: 'E_BAD_VALUE', message: c.message };
      (base as unknown as Record<string, unknown>)[key] = c.value;
    }
    return null;
  };

  if (input.url !== undefined) {
    const bad = apply(parseQuery(input.url));
    if (bad !== null) return bad;
  }

  if (input.overrides !== undefined) {
    const pairs: Record<string, string> = {};
    for (const o of input.overrides) {
      const eq = o.indexOf('=');
      if (eq <= 0) return { ok: false, code: 'E_BAD_OVERRIDE', message: `override '${o}' is not key=value` };
      pairs[o.slice(0, eq)] = o.slice(eq + 1);
    }
    const bad = apply(pairs);
    if (bad !== null) return bad;
  }

  return { ok: true, slug, props: base, ignored };
}

/**
 * Serialize a prop set back to upstream's query-string form. Round-trips with
 * parseQuery + resolveConfig, which is what makes a baked node re-editable: the
 * stored string is the same shape upstream's own customize page produces.
 * Keys are emitted in sorted order so a stored config is byte-stable.
 */
export function toQueryString(props: ShaderGradientProps): string {
  return Object.keys(props)
    .sort()
    .map((k) => {
      const v = (props as unknown as Record<string, unknown>)[k];
      return `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`;
    })
    .join('&');
}
