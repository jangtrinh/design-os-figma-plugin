import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const KERNEL_CORE = `${ROOT}/kernel/design-os/src/core/`;
if (!existsSync(`${KERNEL_CORE}layout-lint.ts`)) {
  throw new Error('kernel/design-os submodule is not checked out — run: git submodule update --init --depth 1');
}

// Dynamic imports keep the missing-submodule message above actionable.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyLintModule = any;
const layoutLintMod: AnyLintModule = await import(/* @vite-ignore */ `${KERNEL_CORE}layout-lint.ts`);
const a11yLintMod: AnyLintModule = await import(/* @vite-ignore */ `${KERNEL_CORE}a11y-lint.ts`);
const tasteLintMod: AnyLintModule = await import(/* @vite-ignore */ `${KERNEL_CORE}taste-lint.ts`);
const contentChecksMod: AnyLintModule = await import(/* @vite-ignore */ `${KERNEL_CORE}content-checks.ts`);
const { lintLayout } = layoutLintMod as { lintLayout: (html: string) => { errorCount: number } };
const { lintA11y } = a11yLintMod as { lintA11y: (html: string) => { errorCount: number } };
const { lintTaste } = tasteLintMod as { lintTaste: (html: string) => { errorCount: number } };
const { allContentChecks } = contentChecksMod as {
  allContentChecks: ReadonlyArray<(src: string) => ReadonlyArray<{ severity: string }>>;
};

const read = (path: string): string => readFileSync(`${ROOT}/${path}`, 'utf8');
const html = read('plugin/src/ui/panel.html');
const model = read('plugin/src/ui/panel-model.ts');
const panelUi = read('plugin/src/ui/panel-ui.ts');
const activityView = read('plugin/src/ui/panel-activity-view.ts');
const viewState = read('plugin/src/ui/panel-view-state.ts');
const main = read('plugin/src/main/main.ts');
const icons = existsSync(`${ROOT}/plugin/src/ui/lucide-icons.ts`) ? read('plugin/src/ui/lucide-icons.ts') : '';

const THEME_BLOCK_RE = /(?::root|html\.figma-light)\s*\{[\s\S]*?\}/g;
const chrome = html.replace(THEME_BLOCK_RE, '').replace(/\/\*[\s\S]*?\*\//g, '');
const rules: [string, string][] = [...chrome.matchAll(/([^{}]+)\{([^}]*)\}/g)]
  .map((match) => [(match[1] ?? '').trim(), match[2] ?? '']);
const declarationsFor = (selector: string): string => rules
  .filter(([selectors]) => selectors.split(',').some((item) => item.trim() === selector))
  .map(([, declarations]) => declarations).join(';');

function contentErrors(source: string): number {
  let errors = 0;
  for (const check of allContentChecks) {
    for (const finding of check(source)) if (finding.severity === 'error') errors += 1;
  }
  return errors;
}

describe('adaptive panel source contract', () => {
  it('passes the shared layout, accessibility, taste, and content linters', () => {
    expect(lintLayout(html).errorCount, 'layout errors').toBe(0);
    expect(lintA11y(html).errorCount, 'a11y errors').toBe(0);
    expect(lintTaste(html).errorCount, 'taste errors').toBe(0);
    expect(contentErrors(html), 'content errors').toBe(0);
  });

  it('opens as the exact rail and whitelists only named viewport modes', () => {
    expect(model).toContain('RAIL_WIDTH = 240');
    expect(model).toContain('RAIL_HEIGHT = 44');
    expect(model).toContain('INSPECTOR_WIDTH = 288');
    expect(model).toContain('INSPECTOR_HEIGHT = 280');
    expect(main).toMatch(/width:\s*RAIL_WIDTH,\s*height:\s*RAIL_HEIGHT/);
    expect(main).toContain("chrome.type === 'PANEL_VIEWPORT'");
    expect(main).toContain("chrome.mode === 'inspector'");
    expect(main).toContain('viewportFor(chrome.mode)');
    expect(main).toContain('figma.ui.resize(viewport.width, viewport.height)');
    expect(main).not.toMatch(/chrome\.(?:width|height)/);
  });

  it('owns a compact rail and a mounted three-view inspector', () => {
    for (const id of [
      'fga-panel', 'fga-rail', 'fga-connection-btn', 'fga-current-btn',
      'fga-target-rail-btn', 'fga-sync-rail-btn', 'fga-toggle-btn', 'fga-inspector',
      'fga-tab-activity', 'fga-tab-context', 'fga-tab-details',
      'fga-panel-activity', 'fga-panel-context', 'fga-panel-details',
    ]) expect(html, `missing #${id}`).toContain(`id="${id}"`);
    expect(html).toContain('role="tablist"');
    expect((html.match(/role="tab"/g) ?? []).length).toBe(3);
    expect((html.match(/role="tabpanel"/g) ?? []).length).toBe(3);
    expect(html).toMatch(/id="fga-inspector"[^>]*hidden/);
  });

  it('keeps context, activity, sync, onboarding, recovery, and version information', () => {
    for (const id of [
      'fga-sentence', 'fga-onboarding', 'fga-ctx-file', 'fga-ctx-file-note',
      'fga-ctx-page', 'fga-ctx-selection', 'fga-target-btn', 'fga-activity',
      'fga-sync', 'fga-sync-msg', 'fga-sync-now', 'fga-sync-later', 'fga-version',
    ]) expect(html, `missing #${id}`).toContain(`id="${id}"`);
    expect((html.match(/aria-live="polite"/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(html).toContain('aria-atomic="true"');
  });
});

describe('Lucide and control accessibility', () => {
  it('vendors an attributed Lucide descriptor set with no runtime dependency', () => {
    expect(icons).toContain('Lucide Contributors');
    expect(icons).toContain('ISC License');
    expect(icons).toContain("viewBox', '0 0 24 24'");
    expect(icons).toContain("stroke-width', '2'");
    expect(icons).not.toContain('innerHTML');
    expect(activityView).toContain("from './lucide-icons'");
    expect(`${panelUi}${activityView}${icons}`).not.toContain('Phosphor');
  });

  it('gives every icon-only rail control a title, accessible name, and native button', () => {
    for (const id of ['fga-connection-btn', 'fga-target-rail-btn', 'fga-sync-rail-btn', 'fga-toggle-btn']) {
      const button = new RegExp(`<button[^>]*id="${id}"[^>]*>`, 's').exec(html)?.[0] ?? '';
      expect(button, `${id} must be a button`).toContain('<button');
      expect(button, `${id} missing title`).toContain('title=');
      expect(button, `${id} missing aria-label`).toContain('aria-label=');
      expect(button, `${id} missing type`).toContain('type="button"');
    }
    expect(declarationsFor('.rail-control')).toMatch(/(?:width|min-width):\s*32px/);
    expect(declarationsFor('.rail-control')).toMatch(/height:\s*32px/);
    expect(declarationsFor('.fga-icon')).toMatch(/width:\s*16px/);
    expect(declarationsFor('.fga-icon')).toMatch(/height:\s*16px/);
    expect(declarationsFor('.rail-control:focus-visible')).toMatch(/outline:\s*2px/);
  });

  it('implements keyboard tabs, Escape collapse, and focus restoration', () => {
    for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End', 'Escape']) {
      expect(panelUi, `missing ${key} keyboard handling`).toContain(`'${key}'`);
    }
    expect(panelUi).toContain('toggleBtn.focus()');
    expect(panelUi).toContain("setAttribute('aria-selected'");
    expect(panelUi).toContain('tabIndex = selected ? 0 : -1');
  });
});

describe('disclosure, authority, and motion', () => {
  it('keeps target conditional and PEERS-authoritative', () => {
    expect(html).toMatch(/id="fga-target-rail-btn"[^>]*hidden/);
    expect(panelUi).toContain('targetRailBtn.hidden = peersCount <= 1');
    expect(panelUi).toContain("peersPinned ? 'figma-agent:clear-target' : 'figma-agent:set-target'");
    expect(panelUi).toContain('targetRailBtn.onclick = toggleTarget');
    expect(panelUi).toContain('targetBtn.onclick = toggleTarget');
    expect(panelUi).not.toContain('peersPinned = !peersPinned');
  });

  it('keeps sync conditional and failure retry semantics intact', () => {
    expect(html).toMatch(/id="fga-sync-rail-btn"[^>]*hidden/);
    expect(panelUi).toContain('pendingSyncCount');
    expect(panelUi).toContain('shouldClearPendingCount(ok)');
    expect(panelUi).toContain('syncNowLabel(unbound)');
    expect(panelUi).toContain('SYNC_STUCK_TIMEOUT_MS');
  });

  it('dedupes forced expansion while leaving unresolved state on the rail', () => {
    expect(panelUi).toContain('const disclosed = new BoundedKeySet()');
    expect(panelUi).toContain('forceOnce');
    expect(panelUi).toContain('activityView.failures.unresolvedCount > 0');
    expect(viewState).toContain('records.find((record) => record.pending)');
    expect(html).toContain('id="fga-failure-count"');
    expect(panelUi).toContain('activityView.acknowledgeFailures()');
    expect(panelUi).toContain("if (tab === 'activity') acknowledgeActivity()");
    expect(activityView).toContain('failures.unresolvedCount');
  });

  it('uses named transitions and honors reduced motion', () => {
    expect(chrome).not.toMatch(/transition[^;]*:\s*[^;]*\ball\b/);
    expect(html).toContain('@media (prefers-reduced-motion: reduce)');
    expect(html).toContain('.is-spinning');
  });

  it('retains theme provenance and no-left-accent owner decision', () => {
    expect(html).toContain('kinetic-swiss-punk');
    expect(html).toContain('html.figma-light');
    expect(chrome).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(chrome).not.toMatch(/box-shadow:\s*inset\b/);
    expect(chrome).not.toMatch(/border-left:\s*(?!0)/);
  });
});
