// `ui.vars.*` — variable + mode lifecycle over exec-js (absorption phase-01, Basket B).
// Reuse, do not re-implement: ref resolution goes through `resolveVariable`
// (executor-variables.ts) and value comparison through its exported `valuesEqual` —
// a second resolver/comparator here would be the mistake exec-stdlib.ts:5-10 warns
// against. Every helper verifies its own write by re-reading the canvas and throws
// `withCode(..., 'E_EVAL')` on a mismatch — an unverified success is exactly the
// silent-failure class this stdlib exists to kill.
import { resolveVariable, valuesEqual } from './executor-variables';
import { withCode } from './executor-styles';

/** A candidate list for an error message, capped so one huge file can't flood a
 * reply — with an explicit "+N more" tail so a truncated list never reads as
 * complete (stage-4 review, PR #10 minor 5: the old 20-item cap silently cut the
 * list with no sign anything was missing). Used for BOTH collection names and mode
 * names — one convention, not two. */
function listWithMore(names: readonly string[], cap = 20): string {
  const shown = names.slice(0, cap).join(', ');
  const rest = names.length - cap;
  return rest > 0 ? `${shown} (+${rest} more)` : shown;
}

/** Collection resolution: id (`VariableCollectionId:…`) or exact name. Mirrors
 * `byPath`'s error style (exec-stdlib.ts:93-101) — name the candidates so a miss is
 * correctable without a second round-trip. */
async function resolveCollection(ref: string): Promise<VariableCollection> {
  const all = await figma.variables.getLocalVariableCollectionsAsync();
  const byId = all.find((c) => c.id === ref);
  if (byId) return byId;
  const byName = all.find((c) => c.name === ref);
  if (byName) return byName;
  throw withCode(
    new Error(`collection not found: "${ref}" — available: ${listWithMore(all.map((c) => c.name))}`),
    'E_INVALID_ARGS',
  );
}

function modeList(collection: VariableCollection): { modeId: string; name: string }[] {
  return collection.modes.map((m) => ({ modeId: m.modeId, name: m.name }));
}

function findMode(collection: VariableCollection, modeId: string): { modeId: string; name: string } {
  const mode = collection.modes.find((m) => m.modeId === modeId);
  if (!mode) {
    throw withCode(
      new Error(`mode not found: "${modeId}" on collection "${collection.name}" — available: ${listWithMore(collection.modes.map((m) => m.name))}`),
      'E_INVALID_ARGS',
    );
  }
  return mode;
}

async function rename(ref: string, newName: string): Promise<{ id: string; name: string; oldName: string }> {
  if (typeof newName !== 'string' || newName.length === 0) {
    throw withCode(new Error('rename requires a non-empty newName'), 'E_INVALID_ARGS');
  }
  const variable = await resolveVariable(ref);
  const oldName = variable.name;
  variable.name = newName;
  if (variable.name !== newName) {
    throw withCode(new Error(`rename applied but variable.name is still "${variable.name}"`), 'E_EVAL');
  }
  return { id: variable.id, name: variable.name, oldName };
}

/**
 * `[re-verify]` whether `Variable.remove()` leaves dangling `boundVariables` entries
 * on nodes that referenced it — the fork does not say (code.js:763-797 just calls
 * `remove()`, no reference check at all). Rather than guess, this counts bound
 * references the CHEAP, HONEST way: `figma.currentPage.findAll` only sees the
 * current page, so a total across the file would under-report on a multi-page
 * file and silently lie. We do not use it and claim a total.
 * es-debt: page-scoped reference counting omitted, not faked. Upgrade trigger: a
 * real task needs the count, or a file-wide bound-reference reader lands.
 */
async function remove(ref: string): Promise<{ id: string; name: string; boundReferencesChecked: boolean }> {
  const variable = await resolveVariable(ref);
  const id = variable.id;
  const name = variable.name;
  variable.remove();
  return { id, name, boundReferencesChecked: false };
}

async function describe(ref: string, description: string): Promise<{ id: string; name: string; description: string }> {
  if (typeof description !== 'string') {
    throw withCode(new Error('describe requires a string description'), 'E_INVALID_ARGS');
  }
  const variable = await resolveVariable(ref);
  variable.description = description;
  if (variable.description !== description) {
    throw withCode(new Error(`describe applied but variable.description is still "${variable.description}"`), 'E_EVAL');
  }
  return { id: variable.id, name: variable.name, description: variable.description };
}

async function addMode(
  collectionRef: string,
  modeName: string,
): Promise<{ collectionId: string; name: string; modes: { modeId: string; name: string }[] }> {
  if (typeof modeName !== 'string' || modeName.length === 0) {
    throw withCode(new Error('addMode requires a non-empty modeName'), 'E_INVALID_ARGS');
  }
  const collection = await resolveCollection(collectionRef);
  const before = collection.modes.length;
  let modeId: string;
  try {
    modeId = collection.addMode(modeName);
  } catch (err) {
    // Free-plan mode caps surface as the thrown Figma error, not a warning — this
    // is a plan LIMIT, the same "let it throw" contract as §5.1 rule 6 (never
    // swallow the way createVariablesFromTokens does for *import*).
    throw withCode(new Error(`addMode "${modeName}" failed: ${String(err)}`), 'E_EVAL');
  }
  if (collection.modes.length !== before + 1 || !collection.modes.some((m) => m.modeId === modeId)) {
    throw withCode(new Error(`addMode "${modeName}" did not take — modes: ${collection.modes.map((m) => m.name).join(', ')}`), 'E_EVAL');
  }
  return { collectionId: collection.id, name: collection.name, modes: modeList(collection) };
}

async function renameMode(
  collectionRef: string,
  modeId: string,
  newName: string,
): Promise<{ collectionId: string; modes: { modeId: string; name: string }[]; oldName: string }> {
  if (typeof newName !== 'string' || newName.length === 0) {
    throw withCode(new Error('renameMode requires a non-empty newName'), 'E_INVALID_ARGS');
  }
  const collection = await resolveCollection(collectionRef);
  const mode = findMode(collection, modeId);
  const oldName = mode.name;
  collection.renameMode(modeId, newName);
  const after = findMode(collection, modeId);
  if (after.name !== newName) {
    throw withCode(new Error(`renameMode applied but mode "${modeId}" is still "${after.name}"`), 'E_EVAL');
  }
  return { collectionId: collection.id, modes: modeList(collection), oldName };
}

async function removeMode(
  collectionRef: string,
  modeId: string,
): Promise<{ collectionId: string; modes: { modeId: string; name: string }[] }> {
  const collection = await resolveCollection(collectionRef);
  findMode(collection, modeId); // throws E_INVALID_ARGS with the available names if absent
  collection.removeMode(modeId);
  if (collection.modes.some((m) => m.modeId === modeId)) {
    throw withCode(new Error(`removeMode applied but "${modeId}" is still present`), 'E_EVAL');
  }
  return { collectionId: collection.id, modes: modeList(collection) };
}

/**
 * Set a variable's value for a named mode. Throws on an unknown mode name — the
 * deliberate opposite of the CREATE_VARIABLE `--mode` bug fixed alongside this file
 * (executor-variables.ts §5.4): that command now throws for the same mistake, so
 * the two no longer disagree about it.
 */
async function setModeValue(
  ref: string,
  modeName: string,
  value: unknown,
): Promise<{ id: string; name: string; mode: { modeId: string; name: string }; value: unknown }> {
  const variable = await resolveVariable(ref);
  const collection = await resolveCollectionOfVariable(variable);
  const mode = collection.modes.find((m) => m.name === modeName);
  if (!mode) {
    throw withCode(
      new Error(`mode "${modeName}" not found on collection "${collection.name}" — available: ${listWithMore(collection.modes.map((m) => m.name))}`),
      'E_INVALID_ARGS',
    );
  }
  variable.setValueForMode(mode.modeId, value as VariableValue);
  const actual = variable.valuesByMode[mode.modeId];
  // Stage-4 review (PR #10 issue 1): valuesEqual handles every real VariableValue
  // shape (RGBA epsilon, VARIABLE_ALIAS by target id, primitives strict) — it is
  // never reference equality, which broke every non-COLOR alias write.
  if (!valuesEqual(actual, value as VariableValue)) {
    throw withCode(new Error(`setModeValue applied but "${modeName}" reads back ${JSON.stringify(actual)}, not ${JSON.stringify(value)}`), 'E_EVAL');
  }
  return { id: variable.id, name: variable.name, mode: { modeId: mode.modeId, name: mode.name }, value: actual };
}

/** The collection a variable belongs to — `variable.variableCollectionId` is the
 * link; look it up rather than asking the caller to pass the collection too. */
async function resolveCollectionOfVariable(variable: Variable): Promise<VariableCollection> {
  const all = await figma.variables.getLocalVariableCollectionsAsync();
  const collection = all.find((c) => c.id === variable.variableCollectionId);
  if (!collection) {
    throw withCode(new Error(`collection not found for variable "${variable.name}" (${variable.variableCollectionId})`), 'E_EVAL');
  }
  return collection;
}

export interface ExecStdlibVars {
  rename(ref: string, newName: string): Promise<{ id: string; name: string; oldName: string }>;
  remove(ref: string): Promise<{ id: string; name: string; boundReferencesChecked: boolean }>;
  describe(ref: string, description: string): Promise<{ id: string; name: string; description: string }>;
  addMode(collection: string, modeName: string): Promise<{ collectionId: string; name: string; modes: { modeId: string; name: string }[] }>;
  renameMode(collection: string, modeId: string, newName: string): Promise<{ collectionId: string; modes: { modeId: string; name: string }[]; oldName: string }>;
  removeMode(collection: string, modeId: string): Promise<{ collectionId: string; modes: { modeId: string; name: string }[] }>;
  setModeValue(ref: string, modeName: string, value: unknown): Promise<{ id: string; name: string; mode: { modeId: string; name: string }; value: unknown }>;
}

export function createExecStdlibVars(): ExecStdlibVars {
  return { rename, remove, describe, addMode, renameMode, removeMode, setModeValue };
}
