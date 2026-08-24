/**
 * Minimal local subset of lucide icons. Geometry is derived from lucide v0.468.0.
 * Copyright (c) Lucide Contributors, distributed under the ISC License.
 * https://lucide.dev/license
 */
const SVG_NS = 'http://www.w3.org/2000/svg';

type SvgNode = readonly [tag: 'path' | 'circle' | 'line' | 'rect', attributes: Readonly<Record<string, string>>];

export type LucideIconName =
  | 'activity' | 'chevron-down' | 'chevron-up' | 'circle-check' | 'circle-off'
  | 'circle-x' | 'files' | 'info' | 'loader-circle' | 'panels-top-left'
  | 'pin' | 'refresh-cw';

const ICONS: Readonly<Record<LucideIconName, readonly SvgNode[]>> = {
  activity: [['path', { d: 'M22 12h-4l-3 9L9 3l-3 9H2' }]],
  'chevron-down': [['path', { d: 'm6 9 6 6 6-6' }]],
  'chevron-up': [['path', { d: 'm18 15-6-6-6 6' }]],
  'circle-check': [
    ['circle', { cx: '12', cy: '12', r: '10' }],
    ['path', { d: 'm9 12 2 2 4-4' }],
  ],
  'circle-off': [
    ['path', { d: 'M20.42 15.89A10 10 0 1 1 8.11 3.58' }],
    ['path', { d: 'm2 2 20 20' }],
  ],
  'circle-x': [
    ['circle', { cx: '12', cy: '12', r: '10' }],
    ['path', { d: 'm15 9-6 6' }],
    ['path', { d: 'm9 9 6 6' }],
  ],
  files: [
    ['path', { d: 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z' }],
    ['path', { d: 'M14 2v6h6' }],
    ['path', { d: 'M2 6h2' }],
    ['path', { d: 'M2 10h2' }],
    ['path', { d: 'M2 14h2' }],
    ['path', { d: 'M2 18h2' }],
  ],
  info: [
    ['circle', { cx: '12', cy: '12', r: '10' }],
    ['path', { d: 'M12 16v-4' }],
    ['path', { d: 'M12 8h.01' }],
  ],
  'loader-circle': [
    ['path', { d: 'M21 12a9 9 0 1 1-6.22-8.56' }],
  ],
  'panels-top-left': [
    ['rect', { width: '18', height: '18', x: '3', y: '3', rx: '2' }],
    ['path', { d: 'M3 9h18' }],
    ['path', { d: 'M9 21V9' }],
  ],
  pin: [
    ['path', { d: 'M12 17v5' }],
    ['path', { d: 'M5 17h14' }],
    ['path', { d: 'M6 17 7 7l-2-2h14l-2 2 1 10' }],
  ],
  'refresh-cw': [
    ['path', { d: 'M21 12a9 9 0 0 1-15.17 6.55L3 16' }],
    ['path', { d: 'M3 21v-5h5' }],
    ['path', { d: 'M3 12A9 9 0 0 1 18.17 5.45L21 8' }],
    ['path', { d: 'M16 8h5V3' }],
  ],
};

export function makeLucideIcon(name: LucideIconName): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'fga-icon');
  for (const [tag, attributes] of ICONS[name]) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    svg.appendChild(node);
  }
  return svg;
}
