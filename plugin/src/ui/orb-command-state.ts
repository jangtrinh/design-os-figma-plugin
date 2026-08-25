import type { OrbState } from 'thinking-orbs/engine';

export interface CommandOrbPresentation {
  state: OrbState;
  status: string;
}

const COMMANDS_BY_STATE = {
  searching: new Set([
    'STATUS', 'GET_SELECTION', 'SCAN_DESIGN_SYSTEM', 'GET_CORRECTION_MEMORY',
    'LIST_CONNECTIONS', 'SHADER_GRADIENT_PROBE',
  ]),
  solving: new Set(['AUDIT_DS', 'VERIFY_CONNECTIONS']),
  composing: new Set([
    'CREATE_FRAME', 'CREATE_INSTANCE', 'CREATE_VARIABLE', 'SET_TEXT', 'HTML_TO_FIGMA',
    'IMPORT_PAYLOAD', 'SHADER_GRADIENT', 'IMPORT_GRADIENT', 'EXPORT_PNG',
  ]),
  shaping: new Set([
    'SET_VARIANT', 'BIND_VARIABLE', 'SET_AUTOLAYOUT', 'SET_CONSTRAINTS', 'CLONE_TRAITS',
  ]),
  weaving: new Set(['BATCH', 'CONNECT', 'DISCONNECT', 'REROUTE', 'RECONCILE']),
  working: new Set(['EXEC_JS', 'SET_CORRECTION_MEMORY', 'PROJECT_BIND', 'JOB', 'MUTATION_GATE']),
  listening: new Set(['COWORK']),
} satisfies Partial<Record<OrbState, ReadonlySet<string>>>;

const STATUS_BY_STATE = {
  searching: 'Searching',
  solving: 'Analyzing',
  composing: 'Composing',
  shaping: 'Shaping',
  weaving: 'Coordinating',
  listening: 'Listening',
  working: 'Processing',
} satisfies Partial<Record<OrbState, string>>;

export function commandOrbPresentation(command: string): CommandOrbPresentation {
  for (const state of Object.keys(COMMANDS_BY_STATE) as Array<keyof typeof COMMANDS_BY_STATE>) {
    if (COMMANDS_BY_STATE[state].has(command)) {
      return { state, status: STATUS_BY_STATE[state] };
    }
  }
  return { state: 'working', status: STATUS_BY_STATE.working };
}
