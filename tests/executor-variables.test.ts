// CREATE_VARIABLE's --mode handling. Regression for the swallowed no-op fixed in
// absorption phase-01 §5.4: a mode name that doesn't exist on the collection used
// to set nothing and report success — the exact mistake `ui.vars.setModeValue`
// (exec-stdlib-variables.ts) exists to never repeat. Now it throws, naming the
// modes that do exist, matching that sibling helper's behavior for the same case.
import { describe, it, expect } from 'vitest';
import { installMockFigma } from './helpers/mock-figma.ts';
import { opCreateVariable } from '../plugin/src/main/executor-variables.ts';

describe('opCreateVariable — params.mode', () => {
  it('sets the value for an existing named mode', async () => {
    const figma = installMockFigma();
    const collection = figma.variables.createVariableCollection('Tokens');
    collection.renameMode(collection.modes[0]!.modeId, 'Light');
    const darkModeId = collection.addMode('Dark');

    const result = await opCreateVariable({
      name: 'color/bg', type: 'COLOR', value: '#000000', collection: 'Tokens', mode: 'Dark',
    });

    const variable = (await figma.variables.getLocalVariablesAsync()).find((v) => v.id === result.id);
    expect(variable?.valuesByMode?.[darkModeId]).toEqual({ r: 0, g: 0, b: 0, a: 1 });
  });

  it('throws E_INVALID_ARGS naming the available modes when params.mode does not exist', async () => {
    const figma = installMockFigma();
    figma.variables.createVariableCollection('Tokens'); // default mode: 'Mode 1'

    await expect(opCreateVariable({
      name: 'color/bg', type: 'COLOR', value: '#000000', collection: 'Tokens', mode: 'Nonexistent',
    })).rejects.toMatchObject({
      code: 'E_INVALID_ARGS',
      message: expect.stringContaining('Mode 1'),
    });
  });

  it('creates the variable with no mode write at all when params.mode is absent', async () => {
    installMockFigma();
    const result = await opCreateVariable({ name: 'color/bg', type: 'COLOR', value: '#000000' });
    expect(result.name).toBe('color/bg');
    expect(result.reused).toBe(false);
  });
});
