import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { allContentChecks, lintA11y, lintLayout, lintTaste } from 'ease-design/lint';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const read = (path: string): string => readFileSync(`${ROOT}/${path}`, 'utf8');
const html = read('plugin/src/ui/panel.html');
const model = read('plugin/src/ui/panel-model.ts');
const panelUi = read('plugin/src/ui/panel-ui.ts');
const activityView = read('plugin/src/ui/panel-activity-view.ts');
const thinkingOrb = existsSync(`${ROOT}/plugin/src/ui/thinking-orb.ts`) ? read('plugin/src/ui/thinking-orb.ts') : '';
const viewState = read('plugin/src/ui/panel-view-state.ts');
const main = read('plugin/src/main/main.ts');
const icons = existsSync(`${ROOT}/plugin/src/ui/lucide-icons.ts`) ? read('plugin/src/ui/lucide-icons.ts') : '';
const packageJson = JSON.parse(read('package.json')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

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
  it('loads panel linters from the exact dev-only ease-design package', () => {
    expect(packageJson.dependencies?.['ease-design']).toBeUndefined();
    expect(packageJson.devDependencies?.['ease-design']).toBe('0.5.0');
  });

  it('passes the shared layout, accessibility, taste, and content linters', () => {
    expect(lintLayout(html).errorCount, 'layout errors').toBe(0);
    expect(lintA11y(html).errorCount, 'a11y errors').toBe(0);
    expect(lintTaste(html).errorCount, 'taste errors').toBe(0);
    expect(contentErrors(html), 'content errors').toBe(0);
  });

  it('opens at the width the host title needs and accepts only a hug request', () => {
    expect(model).toContain('RAIL_MIN_WIDTH = 240');
    expect(model).toContain('RAIL_MAX_WIDTH = 560');
    expect(model).toContain('RAIL_HEIGHT = 44');
    expect(main).toMatch(/width:\s*RAIL_MIN_WIDTH,\s*height:\s*RAIL_HEIGHT/);
    expect(main).toContain("title: 'design:os by JANG'");
    expect(main).toContain('resolveViewportRequest(msg)');
    expect(main).toContain('figma.ui.resize(viewport.width, viewport.height)');
    // main never reads a dimension off the wire: the clamp is the only source.
    expect(main).not.toMatch(/chrome\.(?:width|height|mode)/);
    expect(model).toContain('Math.min(RAIL_MAX_WIDTH, Math.max(RAIL_MIN_WIDTH');
  });

  it('measures the rendered row and only asks for a width that changed', () => {
    expect(panelUi).toContain("type: 'PANEL_VIEWPORT', mode: 'hug'");
    expect(panelUi).toContain('rail.getBoundingClientRect().width');
    expect(panelUi).toContain('Math.abs(width - lastWidth) < 1');
    expect(declarationsFor('body')).toMatch(/width:\s*max-content/);
    expect(declarationsFor('.agent-rail')).toMatch(/width:\s*max-content/);
    expect(declarationsFor('body')).not.toMatch(/min-width/);
  });

  it('is one row and nothing else — no expanded state anywhere', () => {
    for (const id of [
      'fga-rail', 'fga-orb', 'fga-sentence', 'fga-sentence-lead', 'fga-sentence-rest',
      'fga-failure-count', 'fga-target-rail-btn', 'fga-sync-rail-btn', 'fga-sync-badge',
    ]) expect(html, `missing #${id}`).toContain(`id="${id}"`);
    for (const gone of [
      'fga-inspector', 'fga-toggle-btn', 'fga-tab-activity', 'fga-onboarding',
      'fga-version', 'fga-sync-later', 'fga-sync-now', 'fga-activity', 'fga-ctx-file',
      'role="tab"', 'role="tablist"', 'role="tabpanel"',
    ]) expect(html, `${gone} must be gone`).not.toContain(gone);
    // Prose may still explain what the surface used to be; no code may name it.
    for (const source of [model, panelUi, activityView, main]) {
      for (const dead of [
        "'inspector'", 'INSPECTOR_WIDTH', 'INSPECTOR_HEIGHT', 'shouldForceInspector',
        'setInspector', 'inspectorOpen', 'railViewportMode', 'viewportFor(',
      ]) expect(source, `${dead} must be gone`).not.toContain(dead);
    }
  });

  it('keeps the sentence on one line and the full text reachable', () => {
    const sentence = declarationsFor('.rail-sentence');
    expect(sentence).toMatch(/white-space:\s*nowrap/);
    expect(sentence).toMatch(/overflow:\s*hidden/);
    expect(sentence).toMatch(/max-width:\s*\d+px/);
    expect(panelUi).toContain('sentence.title = view.title');
    expect(panelUi).toContain('railSentence({');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-atomic="true"');
  });

  it('spends the ellipsis on the tail, never on a lost edit', () => {
    // The lead carries the lost-edit note at its own width; only the tail may be cut.
    expect(declarationsFor('.sentence-lead')).toMatch(/flex:\s*0\s+0\s+auto/);
    const tail = declarationsFor('.sentence-rest');
    expect(tail).toMatch(/text-overflow:\s*ellipsis/);
    expect(tail).toMatch(/min-width:\s*0/);
    expect(declarationsFor('.rail-sentence')).toMatch(/display:\s*flex/);
    expect(panelUi).toContain('sentenceLead.textContent = view.lead');
    expect(panelUi).toContain('sentenceRest.textContent = view.rest');
    expect(model).toContain('if (dropped > 0) layers.push');
  });

  it('makes the failure count itself the acknowledgement, with no surface to open', () => {
    // The count is the one control that clears itself: a real button, self-labelled, hidden
    // at zero. The sentence is plain live text — a button that does nothing at zero failures
    // would be a control with no action.
    const chip = /<button[^>]*id="fga-failure-count"[^>]*>/s.exec(html)?.[0] ?? '';
    expect(chip, 'the failure count must be a real button').toContain('type="button"');
    expect(chip).not.toContain('role="status"'); // a status role would erase the button
    expect(chip).toContain('aria-label=');
    expect(/<p[^>]*id="fga-sentence"[^>]*>/s.test(html), 'the sentence is plain text').toBe(true);
    expect(panelUi).toContain('failureChip.onclick');
    expect(panelUi).toContain('activityView.acknowledgeFailures()');
    expect(activityView).toContain('this.failures.acknowledge()');
    expect(viewState).toContain('acknowledge(): void');
    expect(declarationsFor('.failure-count')).toMatch(/cursor:\s*pointer/);
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

  it('uses the exact engine package without pulling React into the panel', () => {
    expect(packageJson.dependencies?.['thinking-orbs']).toBeUndefined();
    expect(packageJson.devDependencies?.['thinking-orbs']).toBe('0.3.1');
    expect(thinkingOrb).toContain("from 'thinking-orbs/engine'");
    expect(thinkingOrb).not.toMatch(/from ['"]thinking-orbs['"]|from ['"]react['"]/);
    expect(panelUi).toContain('mountThinkingOrb(orbHost)');
  });

  it('uses one aggregate canvas status and never an icon in the orb cell', () => {
    expect(thinkingOrb).toContain("document.createElement('canvas')");
    expect((thinkingOrb.match(/document\.createElement\('canvas'\)/g) ?? []).length).toBe(1);
    expect(panelUi).not.toContain('replaceIcon(orbHost');
    expect(activityView).toContain('railPhase()');
    // The rail carries the current sentence and the count; the feed list is gone with the
    // surface that showed it, so this view builds no DOM of its own.
    expect(activityView).not.toContain('document.createElement');
  });

  it('recomputes the aggregate orb status on every render', () => {
    expect(panelUi).toContain('function renderOrb()');
    const render = /function render\(\): void \{([\s\S]*?)\n\}/.exec(panelUi)?.[1] ?? '';
    expect(render).toContain('renderOrb()');
    expect(render).toContain('hugViewport()');
    expect(panelUi).toContain('orbHost.title = `${orb.status}');
    expect(panelUi).toContain("orbHost.setAttribute('aria-label', orb.status)");
  });

  it('names the orb and gives every rail button a title, name, and native type', () => {
    const orb = /<div[^>]*id="fga-orb"[^>]*>/s.exec(html)?.[0] ?? '';
    expect(orb).toContain('role="img"');
    expect(orb).toContain('aria-label=');
    expect(orb).toContain('title=');
    for (const id of ['fga-target-rail-btn', 'fga-sync-rail-btn']) {
      const button = new RegExp(`<button[^>]*id="${id}"[^>]*>`, 's').exec(html)?.[0] ?? '';
      expect(button, `${id} must be a button`).toContain('<button');
      expect(button, `${id} missing title`).toContain('title=');
      expect(button, `${id} missing aria-label`).toContain('aria-label=');
      expect(button, `${id} missing type`).toContain('type="button"');
    }
    expect(declarationsFor('.rail-control')).toMatch(/(?:width|min-width):\s*32px/);
    expect(declarationsFor('.rail-control')).toMatch(/height:\s*32px/);
    expect(declarationsFor('.rail-orb')).toMatch(/width:\s*32px/);
    expect(declarationsFor('.fga-icon')).toMatch(/width:\s*16px/);
    expect(declarationsFor('.fga-icon')).toMatch(/height:\s*16px/);
    expect(declarationsFor('.rail-control:focus-visible')).toMatch(/outline:\s*2px/);
  });
});

describe('disclosure, authority, and motion', () => {
  it('keeps target conditional and PEERS-authoritative', () => {
    expect(html).toMatch(/id="fga-target-rail-btn"[^>]*hidden/);
    expect(panelUi).toContain('targetRailBtn.hidden = peersCount <= 1');
    expect(panelUi).toContain("peersPinned ? 'figma-agent:clear-target' : 'figma-agent:set-target'");
    expect(panelUi).toContain('targetRailBtn.onclick = toggleTarget');
    expect(panelUi).not.toContain('peersPinned = !peersPinned');
  });

  it('runs the sync from the rail button and keeps a failure retryable', () => {
    expect(html).toMatch(/id="fga-sync-rail-btn"[^>]*hidden/);
    expect(panelUi).toContain('syncRailBtn.onclick');
    expect(panelUi).toContain("new CustomEvent('figma-agent:sync-request')");
    expect(panelUi).toContain('pendingSyncCount');
    expect(panelUi).toContain('shouldClearPendingCount(ok)');
    expect(panelUi).toContain('syncNowLabel(syncUnbound)');
    expect(panelUi).toContain('SYNC_STUCK_TIMEOUT_MS');
    expect(panelUi).toContain("type: 'SYNC_DONE', commit");
    // A failure keeps the button on the rail; only a genuine success clears the count.
    expect(panelUi).toContain('const showSync = pendingSyncCount > 0 || syncFailure');
    expect(panelUi).toContain('syncFailure = !ok');
  });

  it('leaves unresolved failures visible on the rail', () => {
    expect(panelUi).toContain('activityView.failures.unresolvedCount > 0');
    expect(viewState).toContain('records.find((record) => record.pending)');
    expect(html).toContain('id="fga-failure-count"');
    expect(activityView).toContain('failures.unresolvedCount');
    expect(panelUi).toContain('activityView.renderBadge()');
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
