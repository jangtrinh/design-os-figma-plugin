import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string): string => readFileSync(`${ROOT}/${path}`, 'utf8');
const html = read('plugin/src/ui/panel.html');
const activityView = read('plugin/src/ui/panel-activity-view.ts');
const thinkingOrb = read('plugin/src/ui/thinking-orb.ts');
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
  const invariant = new Set([
    '--fga-radius', '--fga-radius-sm', '--fga-divider-gap', '--fga-font-title',
    '--fga-font-body', '--fga-font-caption', '--fga-track-title', '--fga-track-body',
    '--fga-track-caption', '--fga-lh-title', '--fga-lh-body', '--fga-lh-caption',
    '--fga-motion', '--fga-ease',
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

  it('preserves vertical-only overflow and every ellipsis guard', () => {
    expect(declarationsFor('.inspector-content')).toMatch(/overflow-y:\s*auto/);
    expect(declarationsFor('.inspector-content')).toMatch(/overflow-x:\s*hidden/);
    expect(rules.filter(([, value]) => /text-overflow:\s*ellipsis/.test(value)
      && !(/overflow:\s*hidden/.test(value) && /white-space:\s*nowrap/.test(value)))).toEqual([]);
    expect(chrome).not.toMatch(/@media[^{]*\(\s*(?:min|max)-width/);
  });

  it('hugs the rail with flex while only the activity label may shrink', () => {
    expect(declarationsFor('.agent-rail')).toMatch(/display:\s*flex/);
    expect(declarationsFor('.agent-rail')).not.toMatch(/grid-template-columns|\b1fr\b/);
    expect(declarationsFor('.rail-control')).toMatch(/flex:\s*0\s+0\s+32px/);
    expect(declarationsFor('.current-control')).toMatch(/flex:\s*1\s+1\s+auto/);
    expect(declarationsFor('.current-label')).toMatch(/min-width:\s*0/);
    expect(declarationsFor('.current-label')).toMatch(/text-overflow:\s*ellipsis/);
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
    expect(activityView).toContain("iconWrap.className = 'log-icon-wrap'");
    expect(chrome).not.toMatch(/background(?:-color)?:\s*var\(--fga-(hairline|hairline-soft|topedge)\)/);
    expect(chrome).not.toMatch(/box-shadow:\s*inset|border-left:\s*(?!0)/);
    for (const selector of ['.rail-control:focus-visible', '.tab-button:focus-visible', '.sync-btn:focus-visible', '.inline-link:focus-visible']) expect(declarationsFor(selector)).toMatch(/outline:\s*2px/);
  });

  it('keeps the aggregate orb inline, monochrome, and lifecycle-bounded', () => {
    expect(declarationsFor('.thinking-orb')).toMatch(/width:\s*20px/);
    expect(declarationsFor('.thinking-orb')).toMatch(/height:\s*20px/);
    expect(thinkingOrb).toContain('Math.min(2, window.devicePixelRatio || 1)');
    expect(thinkingOrb).toContain("matchMedia('(prefers-reduced-motion: reduce)')");
    expect(thinkingOrb).toContain("document.addEventListener('visibilitychange'");
    expect(thinkingOrb).toContain('document.hidden');
    expect(thinkingOrb).toContain('requestAnimationFrame');
    expect(thinkingOrb).toContain('cancelAnimationFrame');
    expect(thinkingOrb).not.toContain('IntersectionObserver');
  });

  it('uses exact reduced-motion coverage and no stale icon selectors', () => {
    expect(chrome).not.toMatch(/transition[^;]*:\s*[^;]*\ball\b|transition[^;]*:[^;]*\blinear\b/);
    const guards = [...html.matchAll(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/g)]
      .map((match) => match[1] ?? '').join('\n');
    for (const selector of ['.is-spinning', '.activity-row.is-new', '.rail-control']) expect(guards).toContain(selector);
    expect(declarationsFor('.activity-row')).not.toMatch(/animation:/);
    expect(declarationsFor('.activity-row.is-new')).toMatch(/animation:\s*fga-row-in/);
    expect(html).not.toMatch(/#fga-dot|\.log-icon(?:\s|\{|\[|:)/);
    expect(html).toContain('.log-icon-wrap[data-state="failed"]  .fga-icon');
    expect(html).toContain('.activity-row.is-stale .fga-icon');
  });
});
