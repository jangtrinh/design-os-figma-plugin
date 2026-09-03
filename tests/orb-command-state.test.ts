import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { COMMANDS } from '../shared/protocol.ts';
import { commandOrbPresentation } from '../plugin/src/ui/orb-command-state.ts';
import { orbPresentation } from '../plugin/src/ui/thinking-orb.ts';
import { labelControl } from '../plugin/src/ui/panel-activity-view.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const groups = [
  ['searching', 'Searching', ['STATUS', 'GET_SELECTION', 'SCAN_DESIGN_SYSTEM',
    'GET_CORRECTION_MEMORY', 'LIST_CONNECTIONS', 'SHADER_GRADIENT_PROBE']],
  ['solving', 'Analyzing', ['AUDIT_DS', 'VERIFY_CONNECTIONS']],
  ['composing', 'Composing', ['CREATE_FRAME', 'CREATE_INSTANCE', 'CREATE_VARIABLE',
    'SET_TEXT', 'HTML_TO_FIGMA', 'IMPORT_PAYLOAD', 'SHADER_GRADIENT',
    'IMPORT_GRADIENT', 'EXPORT_PNG']],
  ['shaping', 'Shaping', ['SET_VARIANT', 'BIND_VARIABLE', 'SET_AUTOLAYOUT',
    'SET_CONSTRAINTS', 'CLONE_TRAITS']],
  ['weaving', 'Coordinating', ['BATCH', 'CONNECT', 'DISCONNECT', 'REROUTE', 'RECONCILE']],
  ['working', 'Processing', ['EXEC_JS', 'SET_CORRECTION_MEMORY', 'PROJECT_BIND', 'JOB', 'MUTATION_GATE']],
  ['listening', 'Listening', ['COWORK']],
] as const;

describe('commandOrbPresentation', () => {
  it('covers every wire command exactly, plus only local RECONCILE', () => {
    const mapped = groups.flatMap(([, , commands]) => [...commands]).sort();
    expect(mapped).toEqual([...COMMANDS, 'RECONCILE'].sort());
    expect(new Set(mapped).size).toBe(mapped.length);
  });

  it.each(groups)('maps %s commands from stable command identity', (state, status, commands) => {
    for (const command of commands) {
      expect(commandOrbPresentation(command), command).toEqual({ state, status });
    }
  });

  it('uses working for unknown future commands', () => {
    expect(commandOrbPresentation('FUTURE_COMMAND')).toEqual({
      state: 'working', status: 'Processing',
    });
  });

  it.each(groups)('carries %s through the one-task aggregate', (state, status, commands) => {
    expect(orbPresentation({
      connection: 'connected', connectionFailure: false, syncFailure: false,
      activityFailure: false, pendingTools: [commands[0]], syncPending: false,
    })).toMatchObject({ state, status, paused: false, dimmed: false });
  });

  it('keeps the semantic status as the orb accessible name, build identity aside', () => {
    const panelUi = readFileSync(`${ROOT}/plugin/src/ui/panel-ui.ts`, 'utf8');
    // The orb opens nothing now, so it is a labelled image: the name is the status alone,
    // and the build id rides only on the tooltip.
    expect(panelUi).toContain("orbHost.setAttribute('aria-label', orb.status)");
    expect(panelUi).toContain('orbHost.title = `${orb.status} · ${BUILD_LINE}`');
    const orb = orbPresentation({
      connection: 'connected', connectionFailure: false, syncFailure: false,
      activityFailure: false, pendingTools: ['AUDIT_DS'], syncPending: false,
    });
    expect(orb.status).toBe('Analyzing');
    const labels = new Map<string, string>();
    const target = {
      title: '', setAttribute: (name: string, value: string) => labels.set(name, value),
    } as unknown as HTMLButtonElement;
    // A rail control still says the same thing twice — tooltip and accessible name.
    labelControl(target, `${orb.status}. Run sync`);
    expect(target.title).toBe('Analyzing. Run sync');
    expect(labels.get('aria-label')).toBe('Analyzing. Run sync');
  });
});
