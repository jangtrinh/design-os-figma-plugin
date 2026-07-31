// `ui.vars.*` — variable + mode lifecycle (absorption phase-01, Basket B). Every
// helper is verified (re-reads its own write); these tests prove both the happy
// path AND the failed-verification / bad-input throws, per the repo's own contract
// (exec-stdlib.ts:1-4).
import { describe, it, expect } from 'vitest';
import {
  installMockFigma, setMockLocalVariables, makeMockVariable, setMockModeCap,
} from './helpers/mock-figma.ts';
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

  // Stage-4 review, PR #10 minor 3 — this catch (exec-stdlib-variables.ts's addMode)
  // was previously never exercised by any test; the mock now has a real refusal path.
  it('wraps a plan-limit refusal (or any addMode throw) as E_EVAL, not the raw Figma error', async () => {
    const figma = installMockFigma();
    const collection = figma.variables.createVariableCollection('Tokens');
    setMockModeCap(1); // collection already has 'Mode 1' — the next addMode hits the cap
    await expect(createExecStdlibVars().addMode(collection.name, 'Dark'))
      .rejects.toMatchObject({ code: 'E_EVAL', message: expect.stringContaining('Limited to 1 modes only') });
  });

  it('resolveCollection truncates a long candidate list with a "+N more" tail, never a silent cut', async () => {
    const figma = installMockFigma();
    for (let i = 0; i < 25; i++) figma.variables.createVariableCollection(`Collection ${i}`);
    await expect(createExecStdlibVars().addMode('Nope', 'Dark'))
      .rejects.toMatchObject({ message: expect.stringContaining('+5 more') });
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

  // Stage-4 review, PR #10 issue 1 — a VARIABLE_ALIAS write (the semantic→primitive
  // token layer) used to throw E_EVAL even though the canvas took it correctly: the
  // comparison for non-COLOR types was reference equality, and the mock stored the
  // caller's own object, so no test could see it. Both are fixed now: the mock stores
  // a structural clone, and the comparator understands VARIABLE_ALIAS by shape.
  it('sets a VARIABLE_ALIAS value (semantic token → primitive) and verifies it structurally', async () => {
    const figma = installMockFigma();
    const collection = figma.variables.createVariableCollection('Tokens');
    const primitive = figma.variables.createVariable('color/blue/600', collection, 'COLOR');
    const semantic = figma.variables.createVariable('color/bg/action', collection, 'COLOR');

    const result = await createExecStdlibVars().setModeValue(
      semantic.name, 'Mode 1', { type: 'VARIABLE_ALIAS', id: primitive.id },
    );

    expect(result.value).toEqual({ type: 'VARIABLE_ALIAS', id: primitive.id });
  });
});
