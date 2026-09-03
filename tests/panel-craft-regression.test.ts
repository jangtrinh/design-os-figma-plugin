import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string): string => readFileSync(`${ROOT}/${path}`, 'utf8');
const html = read('plugin/src/ui/panel.html');
const activityView = read('plugin/src/ui/panel-activity-view.ts');
const thinkingOrb = read('plugin/src/ui/thinking-orb.ts');
const orbPainter = read('plugin/src/ui/thinking-orb-painter.ts');
const orbWorker = read('plugin/src/ui/thinking-orb-worker.ts');
const orbWorkerHost = read('plugin/src/ui/thinking-orb-worker-host.ts');
const blocks = /(?::root|html\.figma-light)\s*\{[\s\S]*?\}/g;
const chrome = html.replace(blocks, '').replace(/\/\*[\s\S]*?\*\//g, '');
const rules: [string, string][] = [...chrome.matchAll(/([^{}]+)\{([^}]*)\}/g)]
  .map((match) => [(match[1] ?? '').trim(), match[2] ?? '']);
const declarationsFor = (selector: string): string => rules
  .filter(([selectors]) => selectors.split(',').some((item) => item.trim() === selector))
  .map(([, declarations]) => declarations).join(';');

describe('panel visual regression contract', () => {
  const roots = [...html.matchAll(/:root\s*\{([\s\S]*?)\}/g)].map((match) => match[1] ?? '');
  const dark = roots.at(-1) ?? '';
  const light = /html\.figma-light\s*\{([\s\S]*?)\}/.exec(html)?.[1] ?? '';
  const tokens = (block: string): string[] => [...block.replace(/\/\*[\s\S]*?\*\//g, '')
    .matchAll(/(--fga-[a-z0-9-]+)\s*:/g)].map((match) => match[1] ?? '');
  // Theme-invariant tokens: shape, type, and motion do not change with the appearance,
  // so the light block must NOT redeclare them.
  const invariant = new Set([
    '--fga-radius-sm', '--fga-font-title', '--fga-font-body', '--fga-font-caption',
    '--fga-track-title', '--fga-track-caption', '--fga-lh-title', '--fga-lh-body',
    '--fga-lh-caption', '--fga-motion', '--fga-ease',
  ]);

  it('keeps dark tokens live and light color-token parity exact', () => {
    const declared = tokens(dark);
    const referenced = [...chrome.matchAll(/var\((--fga-[a-z0-9-]+)/g)].map((match) => match[1] ?? '');
    expect(declared.filter((token) => !chrome.includes(`var(${token})`))).toEqual([]);
    expect([...new Set(referenced)].filter((token) => !declared.includes(token))).toEqual([]);
    expect(tokens(light).sort()).toEqual(declared.filter((token) => !invariant.has(token)).sort());
    expect(tokens(light).filter((token) => invariant.has(token))).toEqual([]);
  });

  it('tokenizes typography sizes, tracking, and line-height', () => {
    expect([...dark.matchAll(/(--fga-font-[a-z]+)\s*:/g)].map((match) => match[1]).sort())
      .toEqual(['--fga-font-body', '--fga-font-caption', '--fga-font-title']);
    expect([...new Set([...chrome.matchAll(/font-family:\s*([^;]+);/g)].map((match) => match[1]?.trim()))])
      .toEqual(['var(--font-family-body)']);
    expect([...chrome.matchAll(/font-size:\s*([^;]+);/g)].map((match) => match[1]?.trim())
      .filter((value) => !/^var\(--fga-font-(title|body|caption)\)$/.test(value ?? ''))).toEqual([]);
    expect([...chrome.matchAll(/letter-spacing:\s*([^;]+)/g)].map((match) => match[1]?.trim())
      .filter((value) => !value?.startsWith('var(--fga-track-'))).toEqual([]);
    expect([...chrome.matchAll(/(?:^|;)\s*line-height:\s*([^;]+)/g)].map((match) => match[1]?.trim())
      .filter((value) => !value?.startsWith('var(--fga-lh-'))).toEqual([]);
  });

  it('never scrolls, never wraps, and keeps every ellipsis guard whole', () => {
    // One row at a fixed height: nothing may scroll, in either axis.
    expect(declarationsFor('body')).toMatch(/overflow:\s*hidden/);
    expect(chrome).not.toMatch(/overflow-y:\s*auto|overflow-x:\s*auto/);
    expect(rules.filter(([, value]) => /text-overflow:\s*ellipsis/.test(value)
      && !(/overflow:\s*hidden/.test(value) && /white-space:\s*nowrap/.test(value)))).toEqual([]);
    expect(chrome).not.toMatch(/@media[^{]*\(\s*(?:min|max)-width/);
  });

  it('hugs its content with flex while only the sentence may shrink', () => {
    expect(declarationsFor('body')).toMatch(/width:\s*max-content/);
    expect(declarationsFor('.agent-rail')).toMatch(/display:\s*flex/);
    expect(declarationsFor('.agent-rail')).toMatch(/width:\s*max-content/);
    expect(declarationsFor('.agent-rail')).not.toMatch(/grid-template-columns|\b1fr\b/);
    expect(declarationsFor('.rail-control')).toMatch(/flex:\s*0\s+0\s+32px/);
    expect(declarationsFor('.rail-orb')).toMatch(/flex:\s*0\s+0\s+32px/);
    expect(declarationsFor('.rail-sentence')).toMatch(/min-width:\s*0/);
    expect(declarationsFor('.rail-sentence')).toMatch(/max-width:\s*\d+px/);
    // The ellipsis lives on the tail span only: a flex container's own `text-overflow` is
    // inert, and a declaration that cannot fire is a claim the next reader would trust.
    expect(declarationsFor('.rail-sentence')).not.toMatch(/text-overflow/);
    expect(declarationsFor('.sentence-rest')).toMatch(/text-overflow:\s*ellipsis/);
  });

  it('keeps spacing, depth, focus, and applied 16px Lucide classes intentional', () => {
    const offGrid: string[] = [];
    for (const [selector, value] of rules) {
      for (const match of value.matchAll(/(?:^|;)\s*(padding|margin|gap|row-gap|column-gap)\s*:\s*([^;]+)/g)) {
        for (const part of (match[2] ?? '').trim().split(/\s+(?![^(]*\))/)) {
          if (/^(0|auto|var\(--space-(hair|1|2|3)\)|var\(--fga-divider-gap\)|calc\(.*\))$/.test(part)) continue;
          const pixels = /^(\d+)px$/.exec(part);
          if (!pixels || Number(pixels[1]) % 4 !== 0) offGrid.push(`${selector}:${part}`);
        }
      }
    }
    expect(offGrid).toEqual([]);
    expect(declarationsFor('.fga-icon')).toMatch(/width:\s*16px/);
    expect(activityView).toContain("icon.classList.add('is-spinning')");
    expect(chrome).not.toMatch(/box-shadow:\s*inset|border-left:\s*(?!0)/);
    expect(declarationsFor('.rail-control:focus-visible')).toMatch(/outline:\s*2px/);
  });

  it('keeps the aggregate orb inline, monochrome, and lifecycle-bounded', () => {
    expect(declarationsFor('.thinking-orb')).toMatch(/width:\s*20px/);
    expect(declarationsFor('.thinking-orb')).toMatch(/height:\s*20px/);
    expect(orbPainter).toContain('Math.min(2, dpr || 1)');
    expect(thinkingOrb).toContain("matchMedia('(prefers-reduced-motion: reduce)')");
    expect(thinkingOrb).toContain("document.addEventListener('visibilitychange'");
    expect(thinkingOrb).toContain('document.hidden');
    expect(orbWorker).toContain('requestAnimationFrame');
    expect(orbWorker).toContain('cancelAnimationFrame');
    expect(orbWorkerHost).toContain('transferControlToOffscreen');
    expect(orbWorkerHost).toContain('worker.onerror = failover');
    expect(thinkingOrb).not.toContain('IntersectionObserver');
  });

  it('uses exact reduced-motion coverage and no stale selectors', () => {
    expect(chrome).not.toMatch(/transition[^;]*:\s*[^;]*\ball\b|transition[^;]*:[^;]*\blinear\b/);
    const guards = [...html.matchAll(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/g)]
      .map((match) => match[1] ?? '').join('\n');
    // Every animated or transitioned selector the rail still has must be guarded.
    for (const selector of ['.is-spinning', '.rail-control', '.rail-sentence']) expect(guards).toContain(selector);
    expect(declarationsFor('.is-spinning')).toMatch(/animation:\s*fga-spin/);
    // The surfaces the single row replaced leave no orphan selectors behind.
    expect(html).not.toMatch(/#fga-dot|\.log-icon|\.activity-row|\.detail-cell|\.inspector|\.tab-button/);
  });
});
