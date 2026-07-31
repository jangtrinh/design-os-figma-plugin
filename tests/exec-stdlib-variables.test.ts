// `ui.vars.*` — variable + mode lifecycle (absorption phase-01, Basket B). Every
// helper is verified (re-reads its own write); these tests prove both the happy
// path AND the failed-verification / bad-input throws, per the repo's own contract
// (exec-stdlib.ts:1-4).
import { describe, it, expect } from 'vitest';
import { installMockFigma, setMockLocalVariables, makeMockVariable } from './helpers/mock-figma.ts';
import { createExecStdlibVars } from '../plugin/src/main/exec-stdlib-variables.ts';

describe('ui.vars.rename', () => {
  it('renames and reads the new name back', async () => {
    installMockFigma();
    const variable = makeMockVariable('color/old');
    setMockLocalVariables([variable]);

    const result = await createExecStdlibVars().rename(variable.name, 'color/new');

    expect(result).toEqual({ id: variable.id, name: 'color/new', oldName: 'color/old' });
  });

  it('throws E_INVALID_ARGS on an empty newName', async () => {
    installMockFigma();
    const variable = makeMockVariable('color/old');
    setMockLocalVariables([variable]);

    await expect(createExecStdlibVars().rename(variable.name, '')).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
  });

  it('throws E_INVALID_ARGS when the variable cannot be resolved (resolveVariable\'s own error)', async () => {
    installMockFigma();
    await expect(createExecStdlibVars().rename('missing', 'x')).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
  });
});

describe('ui.vars.remove', () => {
  it('removes the variable and reports boundReferencesChecked:false — never a faked 0', async () => {
    const figma = installMockFigma();
    const variable = makeMockVariable('color/dead');
    setMockLocalVariables([variable]);

    const result = await createExecStdlibVars().remove(variable.name);

    expect(result).toEqual({ id: variable.id, name: variable.name, boundReferencesChecked: false });
    // A REAL removal, not a stub: the variable is actually gone from the local list.
    expect(await figma.variables.getLocalVariablesAsync()).toEqual([]);
  });
});

describe('ui.vars.describe', () => {
  it('sets and reads the description back', async () => {
    installMockFigma();
    const variable = makeMockVariable('color/brand');
    setMockLocalVariables([variable]);

    const result = await createExecStdlibVars().describe(variable.name, 'Primary brand color');
    expect(result).toEqual({ id: variable.id, name: variable.name, description: 'Primary brand color' });
  });

  it('throws E_INVALID_ARGS on a non-string description', async () => {
    installMockFigma();
    const variable = makeMockVariable('color/brand');
    setMockLocalVariables([variable]);
    await expect(createExecStdlibVars().describe(variable.name, null as unknown as string))
      .rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
  });
});

describe('ui.vars.addMode / renameMode / removeMode', () => {
  it('addMode returns the mode list read back off the collection, never the caller\'s echoed name alone', async () => {
    const figma = installMockFigma();
    const collection = figma.variables.createVariableCollection('Tokens');

    const result = await createExecStdlibVars().addMode(collection.name, 'Dark');

    expect(result.collectionId).toBe(collection.id);
    expect(result.modes.map((m) => m.name)).toEqual(['Mode 1', 'Dark']);
  });

  it('renameMode renames and returns the old name alongside the fresh mode list', async () => {
    const figma = installMockFigma();
    const collection = figma.variables.createVariableCollection('Tokens');
    const modeId = collection.modes[0]!.modeId;

    const result = await createExecStdlibVars().renameMode(collection.id, modeId, 'Light');

    expect(result.oldName).toBe('Mode 1');
    expect(result.modes).toEqual([{ modeId, name: 'Light' }]);
  });

  it('renameMode throws E_INVALID_ARGS naming the available modes when modeId is unknown', async () => {
    const figma = installMockFigma();
    const collection = figma.variables.createVariableCollection('Tokens');
    await expect(createExecStdlibVars().renameMode(collection.id, 'bogus', 'Light'))
      .rejects.toMatchObject({ code: 'E_INVALID_ARGS', message: expect.stringContaining('Mode 1') });
  });

  it('removeMode removes a non-default mode', async () => {
    const figma = installMockFigma();
    const collection = figma.variables.createVariableCollection('Tokens');
    const darkId = collection.addMode('Dark');

    const result = await createExecStdlibVars().removeMode(collection.id, darkId);
    expect(result.modes.map((m) => m.name)).toEqual(['Mode 1']);
  });

  it('resolveCollection lists the available collection names on a miss', async () => {
    const figma = installMockFigma();
    figma.variables.createVariableCollection('Tokens');
    await expect(createExecStdlibVars().addMode('Nope', 'Dark'))
      .rejects.toMatchObject({ code: 'E_INVALID_ARGS', message: expect.stringContaining('Tokens') });
  });
});

describe('ui.vars.setModeValue', () => {
  it('sets a COLOR value for a named mode and reads it back with epsilon comparison', async () => {
    const figma = installMockFigma();
    const collection = figma.variables.createVariableCollection('Tokens');
    const variable = figma.variables.createVariable('color/bg', collection, 'COLOR');

    const result = await createExecStdlibVars().setModeValue(
      variable.name, 'Mode 1', { r: 1, g: 0, b: 0, a: 1 },
    );

    expect(result.value).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(result.mode).toEqual({ modeId: collection.modes[0]!.modeId, name: 'Mode 1' });
  });

  it('throws E_INVALID_ARGS naming the available modes when the mode name does not exist', async () => {
    const figma = installMockFigma();
    const collection = figma.variables.createVariableCollection('Tokens');
    const variable = figma.variables.createVariable('color/bg', collection, 'COLOR');

    await expect(createExecStdlibVars().setModeValue(variable.name, 'Nonexistent', { r: 0, g: 0, b: 0, a: 1 }))
      .rejects.toMatchObject({ code: 'E_INVALID_ARGS', message: expect.stringContaining('Mode 1') });
  });

  it('sets a non-COLOR (FLOAT) value with strict equality', async () => {
    const figma = installMockFigma();
    const collection = figma.variables.createVariableCollection('Tokens');
    const variable = figma.variables.createVariable('space/lg', collection, 'FLOAT');

    const result = await createExecStdlibVars().setModeValue(variable.name, 'Mode 1', 24);
    expect(result.value).toBe(24);
  });
});
