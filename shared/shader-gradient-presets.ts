// ShaderGradient preset values — the ONE place in this toolchain that carries upstream's
// numeric parameter sets.
//
// Derived from ShaderGradient's own `packages/shadergradient/src/presets.ts` by evaluating
// that file's object literal at the pinned revision below, then keeping only the
// render-relevant keys (the GradientT/MeshT surface plus canvas props). Editor- and
// GIF-export-only keys are deliberately dropped: they configure upstream's own authoring
// tool, not a rendered field, and carrying them would imply this bake supports an export
// pipeline it does not have.
//
//   Upstream:  https://github.com/ruucm/shadergradient
//   Fork:      https://github.com/jangtrinh/shadergradient
//   Revision:  974a230b1e6c3ec375fbe17a8ea1c89edbc48019
//   License:   MIT (c) ruucm, stone-skipper — see THIRD-PARTY.md
//
// Why here and not in the design-os knowledge ledger: that ledger's rule is names, slugs,
// axes, and provenance — never parameter lists. A preset's prop set IS a parameter list.
// This repo attributes third-party code in THIRD-PARTY.md and is the honest home for it.
//
// REGENERATE, never hand-edit: re-evaluate upstream's literal at a new pin and re-emit, so
// a value here can never disagree with the revision it claims. A hand-patched number would
// be indistinguishable from a correct one.

/** Every render-relevant ShaderGradient prop this bake understands. */
export interface ShaderGradientProps {
  type: 'plane' | 'sphere' | 'waterPlane';
  animate: 'on' | 'off';
  uTime: number;
  uSpeed: number;
  uStrength: number;
  uDensity: number;
  uFrequency: number;
  uAmplitude: number;
  positionX: number;
  positionY: number;
  positionZ: number;
  rotationX: number;
  rotationY: number;
  rotationZ: number;
  color1: string;
  color2: string;
  color3: string;
  reflection: number;
  wireframe: boolean;
  shader: string;
  cAzimuthAngle: number;
  cPolarAngle: number;
  cDistance: number;
  cameraZoom: number;
  lightType: '3d' | 'env';
  brightness: number;
  envPreset: 'city' | 'dawn' | 'lobby';
  grain: 'on' | 'off';
  pixelDensity: number;
  fov: number;
}

export interface ShaderGradientPreset {
  /** Upstream's own object key, accepted as an alias alongside the kebab-case slug. */
  readonly upstreamKey: string;
  /** Upstream's display title. */
  readonly name: string;
  readonly props: Readonly<ShaderGradientProps>;
}

/** The 10 named presets, keyed by kebab-case slug — the same slugs the design-os ledger carries. */
export const SHADER_GRADIENT_PRESETS: Readonly<Record<string, ShaderGradientPreset>> = {
  'halo': {
    upstreamKey: 'halo',
    name: "Halo",
    props: {
      type: "plane",
      animate: "on",
      uTime: 0,
      uSpeed: 0.4,
      uStrength: 4,
      uDensity: 1.3,
      uFrequency: 5.5,
      uAmplitude: 1,
      positionX: -1.4,
      positionY: 0,
      positionZ: 0,
      rotationX: 0,
      rotationY: 10,
      rotationZ: 50,
      color1: "#ff5005",
      color2: "#dbba95",
      color3: "#d0bce1",
      reflection: 0.1,
      wireframe: false,
      shader: "defaults",
      cAzimuthAngle: 180,
      cPolarAngle: 90,
      cDistance: 3.6,
      cameraZoom: 1,
      lightType: "3d",
      brightness: 1.2,
      envPreset: "city",
      grain: "on",
      pixelDensity: 1,
      fov: 45,
    },
  },
  'pensive': {
    upstreamKey: 'pensive',
    name: "Pensive",
    props: {
      type: "sphere",
      animate: "on",
      uTime: 0,
      uSpeed: 0.3,
      uStrength: 0.4,
      uDensity: 0.8,
      uFrequency: 5.5,
      uAmplitude: 7,
      positionX: 0,
      positionY: 0,
      positionZ: 0,
      rotationX: 0,
      rotationY: 0,
      rotationZ: 140,
      color1: "#809bd6",
      color2: "#910aff",
      color3: "#af38ff",
      reflection: 0.5,
      wireframe: false,
      shader: "defaults",
      cAzimuthAngle: 250,
      cPolarAngle: 140,
      cDistance: 1.5,
      cameraZoom: 12.5,
      lightType: "3d",
      brightness: 1.5,
      envPreset: "city",
      grain: "on",
      pixelDensity: 1,
      fov: 45,
    },
  },
  'mint': {
    upstreamKey: 'mint',
    name: "Mint",
    props: {
      type: "waterPlane",
      animate: "on",
      uTime: 0,
      uSpeed: 0.2,
      uStrength: 3.4,
      uDensity: 1.2,
      uFrequency: 0,
      uAmplitude: 0,
      positionX: 0,
      positionY: 0.9,
      positionZ: -0.3,
      rotationX: 45,
      rotationY: 0,
      rotationZ: 0,
      color1: "#94ffd1",
      color2: "#6bf5ff",
      color3: "#ffffff",
      reflection: 0.1,
      wireframe: false,
      shader: "defaults",
      cAzimuthAngle: 170,
      cPolarAngle: 70,
      cDistance: 4.4,
      cameraZoom: 1,
      lightType: "3d",
      brightness: 1.2,
      envPreset: "city",
      grain: "off",
      pixelDensity: 1,
      fov: 45,
    },
  },
  'interstella': {
    upstreamKey: 'interstella',
    name: "Interstella",
    props: {
      type: "sphere",
      animate: "on",
      uTime: 0,
      uSpeed: 0.3,
      uStrength: 0.3,
      uDensity: 0.8,
      uFrequency: 5.5,
      uAmplitude: 3.2,
      positionX: -0.1,
      positionY: 0,
      positionZ: 0,
      rotationX: 0,
      rotationY: 130,
      rotationZ: 70,
      color1: "#73bfc4",
      color2: "#ff810a",
      color3: "#8da0ce",
      reflection: 0.4,
      wireframe: false,
      shader: "defaults",
      cAzimuthAngle: 270,
      cPolarAngle: 180,
      cDistance: 0.5,
      cameraZoom: 15.1,
      lightType: "env",
      brightness: 0.8,
      envPreset: "city",
      grain: "on",
      pixelDensity: 1,
      fov: 45,
    },
  },
  'nighty-night': {
    upstreamKey: 'nightyNight',
    name: "Nighty night",
    props: {
      type: "waterPlane",
      animate: "on",
      uTime: 8,
      uSpeed: 0.3,
      uStrength: 1.5,
      uDensity: 1.5,
      uFrequency: 0,
      uAmplitude: 0,
      positionX: 0,
      positionY: 0,
      positionZ: 0,
      rotationX: 50,
      rotationY: 0,
      rotationZ: -60,
      color1: "#606080",
      color2: "#8d7dca",
      color3: "#212121",
      reflection: 0.1,
      wireframe: false,
      shader: "defaults",
      cAzimuthAngle: 180,
      cPolarAngle: 80,
      cDistance: 2.8,
      cameraZoom: 9.1,
      lightType: "3d",
      brightness: 1,
      envPreset: "city",
      grain: "on",
      pixelDensity: 1,
      fov: 45,
    },
  },
  'viola-orientalis': {
    upstreamKey: 'violaOrientalis',
    name: "Viola",
    props: {
      type: "sphere",
      animate: "on",
      uTime: 0,
      uSpeed: 0.1,
      uStrength: 1,
      uDensity: 1.1,
      uFrequency: 5.5,
      uAmplitude: 1.4,
      positionX: 0,
      positionY: 0,
      positionZ: 0,
      rotationX: 0,
      rotationY: 0,
      rotationZ: 0,
      color1: "#ffffff",
      color2: "#ffbb00",
      color3: "#0700ff",
      reflection: 0.1,
      wireframe: false,
      shader: "defaults",
      cAzimuthAngle: 0,
      cPolarAngle: 140,
      cDistance: 7.1,
      cameraZoom: 17.3,
      lightType: "3d",
      brightness: 1.1,
      envPreset: "city",
      grain: "off",
      pixelDensity: 1,
      fov: 45,
    },
  },
  'universe': {
    upstreamKey: 'universe',
    name: "Universe",
    props: {
      type: "waterPlane",
      animate: "on",
      uTime: 0.2,
      uSpeed: 0.1,
      uStrength: 2.4,
      uDensity: 1.1,
      uFrequency: 5.5,
      uAmplitude: 0,
      positionX: -0.5,
      positionY: 0.1,
      positionZ: 0,
      rotationX: 0,
      rotationY: 0,
      rotationZ: 235,
      color1: "#5606ff",
      color2: "#fe8989",
      color3: "#000000",
      reflection: 0.1,
      wireframe: false,
      shader: "defaults",
      cAzimuthAngle: 180,
      cPolarAngle: 115,
      cDistance: 3.9,
      cameraZoom: 1,
      lightType: "3d",
      brightness: 1.1,
      envPreset: "city",
      grain: "off",
      pixelDensity: 1,
      fov: 45,
    },
  },
  'sunset': {
    upstreamKey: 'sunset',
    name: "Sunset",
    props: {
      type: "sphere",
      animate: "on",
      uTime: 0,
      uSpeed: 0.1,
      uStrength: 0.4,
      uDensity: 1.1,
      uFrequency: 5.5,
      uAmplitude: 1.4,
      positionX: 0,
      positionY: -0.15,
      positionZ: 0,
      rotationX: 0,
      rotationY: 0,
      rotationZ: 0,
      color1: "#ff7a33",
      color2: "#33a0ff",
      color3: "#ffc53d",
      reflection: 0.1,
      wireframe: false,
      shader: "defaults",
      cAzimuthAngle: 60,
      cPolarAngle: 90,
      cDistance: 7.1,
      cameraZoom: 15.3,
      lightType: "3d",
      brightness: 1.5,
      envPreset: "dawn",
      grain: "off",
      pixelDensity: 1,
      fov: 45,
    },
  },
  'mandarin': {
    upstreamKey: 'mandarin',
    name: "Mandarin",
    props: {
      type: "waterPlane",
      animate: "on",
      uTime: 0.2,
      uSpeed: 0.2,
      uStrength: 3,
      uDensity: 1.8,
      uFrequency: 5.5,
      uAmplitude: 0,
      positionX: 0,
      positionY: -2.1,
      positionZ: 0,
      rotationX: 0,
      rotationY: 0,
      rotationZ: 225,
      color1: "#ff6a1a",
      color2: "#c73c00",
      color3: "#FD4912",
      reflection: 0.1,
      wireframe: false,
      shader: "defaults",
      cAzimuthAngle: 180,
      cPolarAngle: 95,
      cDistance: 2.4,
      cameraZoom: 1,
      lightType: "3d",
      brightness: 1.2,
      envPreset: "city",
      grain: "off",
      pixelDensity: 1,
      fov: 45,
    },
  },
  'cotton-candy': {
    upstreamKey: 'cottonCandy',
    name: "Cotton Candy",
    props: {
      type: "waterPlane",
      animate: "on",
      uTime: 0.2,
      uSpeed: 0.3,
      uStrength: 3,
      uDensity: 1,
      uFrequency: 5.5,
      uAmplitude: 0,
      positionX: 0,
      positionY: 1.8,
      positionZ: 0,
      rotationX: 0,
      rotationY: 0,
      rotationZ: -90,
      color1: "#ebedff",
      color2: "#f3f2f8",
      color3: "#dbf8ff",
      reflection: 0.1,
      wireframe: false,
      shader: "defaults",
      cAzimuthAngle: 180,
      cPolarAngle: 120,
      cDistance: 2.9,
      cameraZoom: 1,
      lightType: "3d",
      brightness: 1.2,
      envPreset: "city",
      grain: "off",
      pixelDensity: 1,
      fov: 45,
    },
  },
};

/** Kebab slug for an upstream camelCase key, or null when it names no preset. */
export function slugForUpstreamKey(key: string): string | null {
  for (const [slug, preset] of Object.entries(SHADER_GRADIENT_PRESETS)) {
    if (preset.upstreamKey === key) return slug;
  }
  return null;
}
