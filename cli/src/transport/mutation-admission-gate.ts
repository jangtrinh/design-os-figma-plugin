import { mkdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ErrorCode, MutationGateRow, MutationGateState, MutationGateStoreHealth } from '../../../shared/protocol.ts';
import { durableFileKey } from './file-identity.ts';
import { writePrivateFileExclusive } from './private-file-write.ts';

export const MUTATION_GATE_FILENAME = 'mutation-gates.json';
const SCHEMA_VERSION = 1;

interface PersistedGate { state: MutationGateState; lastTransitionRevision: number; }
interface PersistedTransition { fileKey: string; from: MutationGateState; to: MutationGateState; at: number; revision: number; }
interface PersistedSnapshot { schemaVersion: 1; sequence: number; gates: Record<string, PersistedGate>; latestTransition?: PersistedTransition; }

export interface MutationGateStatus { health: MutationGateStoreHealth; gates: MutationGateRow[]; }
export type MutationGateDecision =
  | { ok: true; fileKey: string; state: MutationGateState; lastTransitionRevision: number; health: MutationGateStoreHealth }
  | { ok: false; fileKey?: string; lastTransitionRevision?: number; error: { code: ErrorCode; message: string }; health: MutationGateStoreHealth };
type MutationGateDenied = Extract<MutationGateDecision, { ok: false }>;
export type MutationGateTransition =
  | { ok: true; fileKey: string; state: MutationGateState; previousState: MutationGateState; lastTransitionRevision: number; sequence: number; health: MutationGateStoreHealth }
  | MutationGateDenied;

export interface MutationAdmissionGateOptions {
  now?: () => number;
  writeFile?: (path: string, data: string) => void;
  rename?: (from: string, to: string) => void;
}

export function mutationGatePathFor(advertisePath: string): string {
  return join(dirname(advertisePath), MUTATION_GATE_FILENAME);
}

function validState(value: unknown): value is MutationGateState {
  return value === 'paused' || value === 'open';
}

function validSnapshot(value: unknown): value is PersistedSnapshot {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  if (snapshot.schemaVersion !== SCHEMA_VERSION || !Number.isSafeInteger(snapshot.sequence) || (snapshot.sequence as number) < 0) return false;
  if (snapshot.gates === null || typeof snapshot.gates !== 'object' || Array.isArray(snapshot.gates)) return false;
  const sequence = snapshot.sequence as number;
  const gates = snapshot.gates as Record<string, unknown>;
  for (const [fileKey, record] of Object.entries(gates)) {
    if (fileKey.trim() === '' || record === null || typeof record !== 'object') return false;
    const gate = record as Record<string, unknown>;
    if (!validState(gate.state) || !Number.isSafeInteger(gate.lastTransitionRevision)
      || (gate.lastTransitionRevision as number) < 0 || (gate.lastTransitionRevision as number) > sequence) return false;
  }
  if (sequence === 0) return snapshot.latestTransition === undefined || snapshot.latestTransition === null;
  const latest = snapshot.latestTransition;
  if (latest === null || typeof latest !== 'object' || Array.isArray(latest)) return false;
  const transition = latest as Record<string, unknown>;
  const latestGate = typeof transition.fileKey === 'string' ? gates[transition.fileKey] : undefined;
  if (latestGate === null || typeof latestGate !== 'object') return false;
  const gate = latestGate as Record<string, unknown>;
  return typeof transition.fileKey === 'string' && transition.fileKey.trim() !== '' && validState(transition.from)
    && validState(transition.to) && Number.isFinite(transition.at) && transition.revision === sequence
    && gate.lastTransitionRevision === sequence && gate.state === transition.to;
}

function freshSnapshot(): PersistedSnapshot {
  return { schemaVersion: SCHEMA_VERSION, sequence: 0, gates: Object.create(null) };
}

export class MutationAdmissionGate {
  private readonly now: () => number;
  private readonly writeFile: (path: string, data: string) => void;
  private readonly rename: (from: string, to: string) => void;
  private unavailableReason: string | null = null;

  constructor(readonly path: string, options: MutationAdmissionGateOptions = {}) {
    this.now = options.now ?? Date.now;
    this.writeFile = options.writeFile ?? writePrivateFileExclusive;
    this.rename = options.rename ?? renameSync;
  }

  private health(state: MutationGateStoreHealth['state'], reason?: string): MutationGateStoreHealth {
    return { state, path: this.path, ...(reason !== undefined && { reason }) };
  }

  private unavailable(reason: string, fileKey?: string, lastTransitionRevision?: number): MutationGateDenied {
    this.unavailableReason = reason;
    return { ok: false, ...(fileKey !== undefined && { fileKey }), ...(lastTransitionRevision !== undefined && { lastTransitionRevision }),
      error: { code: 'E_MUTATION_GATE_UNAVAILABLE', message: `mutation gate store is unavailable: ${reason}` }, health: this.health('unavailable', reason) };
  }

  private load(): { snapshot: PersistedSnapshot; health: MutationGateStoreHealth } | null {
    if (this.unavailableReason !== null) return null;
    let raw: string;
    try { raw = readFileSync(this.path, 'utf8'); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { snapshot: freshSnapshot(), health: this.health('missing') };
      this.unavailableReason = (err as Error).message;
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!validSnapshot(parsed)) throw new Error('invalid schema or gate entry');
      return { snapshot: parsed, health: this.health('healthy') };
    } catch (err) {
      this.unavailableReason = (err as Error).message;
      return null;
    }
  }

  admit(fileKey: string | null | undefined): MutationGateDecision {
    const rawKey = durableFileKey(fileKey);
    if (rawKey === null) {
      return { ok: false, error: { code: 'E_FILE_KEY_UNAVAILABLE', message: 'mutation admission requires a nonempty raw Figma fileKey' }, health: this.health('missing') };
    }
    const loaded = this.load();
    if (!loaded) return this.unavailable(this.unavailableReason ?? 'unreadable store', rawKey);
    const gate = loaded.snapshot.gates[rawKey] ?? { state: 'open', lastTransitionRevision: 0 };
    if (gate.state === 'paused') {
      return { ok: false, fileKey: rawKey, lastTransitionRevision: gate.lastTransitionRevision,
        error: { code: 'E_MUTATIONS_PAUSED', message: `mutations are paused for fileKey ${JSON.stringify(rawKey)}` }, health: loaded.health };
    }
    return { ok: true, fileKey: rawKey, state: gate.state, lastTransitionRevision: gate.lastTransitionRevision, health: loaded.health };
  }

  transition(fileKey: string | null | undefined, state: MutationGateState): MutationGateTransition {
    const rawKey = durableFileKey(fileKey);
    if (rawKey === null) return { ok: false, error: { code: 'E_FILE_KEY_UNAVAILABLE', message: 'mutation admission requires a nonempty raw Figma fileKey' }, health: this.health('missing') };
    const loaded = this.load();
    if (!loaded) return this.unavailable(this.unavailableReason ?? 'unreadable store', rawKey);
    const previous = loaded.snapshot.gates[rawKey] ?? { state: 'open', lastTransitionRevision: 0 };
    const sequence = loaded.snapshot.sequence + 1;
    const gates = Object.assign(Object.create(null), loaded.snapshot.gates, { [rawKey]: { state, lastTransitionRevision: sequence } });
    const next: PersistedSnapshot = { schemaVersion: SCHEMA_VERSION, sequence, gates,
      latestTransition: { fileKey: rawKey, from: previous.state, to: state, at: this.now(), revision: sequence } };
    const tmpPath = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    let written = false;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      this.writeFile(tmpPath, JSON.stringify(next));
      written = true;
      this.rename(tmpPath, this.path);
    } catch (err) {
      if (written) {
        try { unlinkSync(tmpPath); } catch { /* evidence remains in the prior atomic target */ }
      }
      return this.unavailable((err as Error).message, rawKey, previous.lastTransitionRevision) as MutationGateTransition;
    }
    return { ok: true, fileKey: rawKey, state, previousState: previous.state, lastTransitionRevision: sequence, sequence, health: this.health('healthy') };
  }

  status(): MutationGateStatus {
    const loaded = this.load();
    if (!loaded) return { health: this.health('unavailable', this.unavailableReason ?? 'unreadable store'), gates: [] };
    const gates = Object.entries(loaded.snapshot.gates)
      .map(([fileKey, gate]) => ({ fileKey, state: gate.state, lastTransitionRevision: gate.lastTransitionRevision }))
      .sort((a, b) => a.fileKey.localeCompare(b.fileKey));
    return { health: loaded.health, gates };
  }
}
