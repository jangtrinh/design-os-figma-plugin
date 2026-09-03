// `figma-agent resolve-component --name <n> [--page <p>]` — exactly one node or an honest
// refusal. The pure picker is exercised on the shapes the real file produces (two live
// `Table / Cell` sets on different pages); `run()` is exercised with a mocked broker to
// prove it rides SCAN_DESIGN_SYSTEM as a declared read-only safe read.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../cli/src/transport/broker-client.ts', () => ({ runCommand: vi.fn() }));

import { parseArgs } from '../cli/src/arg-parse.ts';
import { pickComponent, run, type ComponentCandidate } from '../cli/src/commands/resolve-component.ts';
import { runCommand } from '../cli/src/transport/broker-client.ts';

function candidate(over: Partial<ComponentCandidate> & { id: string }): ComponentCandidate {
  return { key: `key-${over.id}`, name: 'Table / Cell', type: 'COMPONENT_SET', page: { id: 'pg', name: '01 Design System' }, ...over };
}

describe('pickComponent', () => {
  it('a unique name resolves to that node', () => {
    const only = candidate({ id: '1:1', name: 'Button' });
    expect(pickComponent([only, candidate({ id: '1:2', name: 'Chip' })], 'Button')).toEqual({ ok: true, node: only, matched: 1 });
  });

  it('two live sets with the same name on different pages → the design-system page wins, and says so', () => {
    const ds = candidate({ id: '10:1', page: { id: 'p1', name: '01 Design System' } });
    const stray = candidate({ id: '20:1', page: { id: 'p2', name: '03 Screens' } });
    expect(pickComponent([stray, ds], 'Table / Cell')).toEqual({ ok: true, node: ds, matched: 2, preferred: 'design-system-page' });
  });

  it('duplicates that the page heuristic cannot separate → E_AMBIGUOUS listing every candidate', () => {
    const a = candidate({ id: '10:1', page: { id: 'p1', name: 'Design System' } });
    const b = candidate({ id: '10:2', page: { id: 'p2', name: '02 Components' } });
    const result = pickComponent([a, b], 'Table / Cell');
    expect(result).toMatchObject({ ok: false, code: 'E_AMBIGUOUS', candidates: [a, b] });
  });

  it('two duplicates on the SAME page → E_AMBIGUOUS (the page cannot break that tie)', () => {
    const a = candidate({ id: '10:1' });
    const b = candidate({ id: '10:2' });
    expect(pickComponent([a, b], 'Table / Cell')).toMatchObject({ ok: false, code: 'E_AMBIGUOUS' });
  });

  it('--page filters first; a page named exactly wins even over the design-system heuristic', () => {
    const ds = candidate({ id: '10:1', page: { id: 'p1', name: '01 Design System' } });
    const stray = candidate({ id: '20:1', page: { id: 'p2', name: '03 Screens' } });
    expect(pickComponent([ds, stray], 'Table / Cell', '03 screens')).toEqual({ ok: true, node: stray, matched: 1 });
  });

  it('nothing by that name → E_NOT_FOUND; with a --page that drops every hit the refusal names the page', () => {
    const ds = candidate({ id: '10:1' });
    expect(pickComponent([ds], 'Missing')).toMatchObject({ ok: false, code: 'E_NOT_FOUND' });
    const paged = pickComponent([ds], 'Table / Cell', 'Nowhere');
    expect(paged).toMatchObject({ ok: false, code: 'E_NOT_FOUND' });
    expect((paged as { message: string }).message).toContain('Nowhere');
  });

  it('name matching is exact after trim, case-insensitive — never a substring match', () => {
    const cell = candidate({ id: '1:1', name: 'Table / Cell' });
    const header = candidate({ id: '1:2', name: 'Table / Cell Header' });
    expect(pickComponent([cell, header], '  table / cell ')).toEqual({ ok: true, node: cell, matched: 1 });
  });

  it('the page heuristic never invents a page: a page-less candidate is not "design-system"', () => {
    const noPage = candidate({ id: '1:1', page: null });
    const stray = candidate({ id: '1:2', page: { id: 'p', name: 'Screens' } });
    expect(pickComponent([noPage, stray], 'Table / Cell')).toMatchObject({ ok: false, code: 'E_AMBIGUOUS' });
  });
});

describe('resolve-component run()', () => {
  beforeEach(() => {
    vi.mocked(runCommand).mockReset();
  });

  it('rides SCAN_DESIGN_SYSTEM as a declared read-only safe read and prints exactly one node', async () => {
    vi.mocked(runCommand).mockResolvedValue({
      components: [
        { id: '10:1', key: 'k1', name: 'Table / Cell', type: 'COMPONENT_SET', page: { id: 'p1', name: 'Design System' } },
        { id: '20:1', key: 'k2', name: 'Table / Cell', type: 'COMPONENT_SET', page: { id: 'p2', name: 'Screens' } },
      ],
    });
    await expect(run(parseArgs(['--name', 'Table / Cell']))).resolves.toEqual({
      id: '10:1', key: 'k1', name: 'Table / Cell', type: 'COMPONENT_SET', page: { id: 'p1', name: 'Design System' },
      matched: 2, preferred: 'design-system-page',
    });
    expect(runCommand).toHaveBeenCalledWith('SCAN_DESIGN_SYSTEM', {}, expect.objectContaining({ readOnly: true }));
  });

  it('ambiguity is exit 1 with E_AMBIGUOUS and every candidate in the message', async () => {
    vi.mocked(runCommand).mockResolvedValue({
      components: [
        { id: '10:1', key: 'k1', name: 'Table / Cell', type: 'COMPONENT_SET', page: { id: 'p1', name: 'Design System' } },
        { id: '10:2', key: 'k2', name: 'Table / Cell', type: 'COMPONENT_SET', page: { id: 'p1', name: 'Design System' } },
      ],
    });
    await expect(run(parseArgs(['--name', 'Table / Cell']))).rejects.toMatchObject({
      code: 'E_AMBIGUOUS',
      message: expect.stringMatching(/10:1.*10:2/s),
      // Structured too, so an agent picks by id without parsing prose.
      candidates: [
        { id: '10:1', name: 'Table / Cell', type: 'COMPONENT_SET', page: { id: 'p1', name: 'Design System' } },
        { id: '10:2', name: 'Table / Cell', type: 'COMPONENT_SET', page: { id: 'p1', name: 'Design System' } },
      ],
    });
  });

  it('a missing --name refuses before any broker round-trip', async () => {
    await expect(run(parseArgs([]))).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('a scan whose entries predate the page field (older plugin) still resolves a unique name, page: null', async () => {
    vi.mocked(runCommand).mockResolvedValue({ components: [{ id: '1:1', key: 'k', name: 'Button', type: 'COMPONENT' }] });
    await expect(run(parseArgs(['--name', 'Button']))).resolves.toMatchObject({ id: '1:1', page: null, matched: 1 });
  });
});
