import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MutationAdmissionGate, mutationGatePathFor } from '../cli/src/transport/mutation-admission-gate.ts';

let scratchDirs: string[] = [];

function makeStorePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fa-mutation-gate-'));
  scratchDirs.push(dir);
  return mutationGatePathFor(join(dir, 'broker.json'));
}

afterEach(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
  scratchDirs = [];
});

describe('MutationAdmissionGate — durable raw-key admission', () => {
  it('treats a missing store as open and does not create it for a read', () => {
    const storePath = makeStorePath();
    const gate = new MutationAdmissionGate(storePath);

    expect(gate.admit('AbC123')).toMatchObject({ ok: true, state: 'open', lastTransitionRevision: 0 });
    expect(existsSync(storePath)).toBe(false);
    expect(gate.status()).toMatchObject({ health: { state: 'missing' }, gates: [] });
  });

  it('persists exact keys, target-local revisions, monotonic order, and a latest transition audit', () => {
    const storePath = makeStorePath();
    let now = 1_000;
    const gate = new MutationAdmissionGate(storePath, { now: () => now++ });

    expect(gate.transition('A Key', 'paused')).toMatchObject({
      ok: true,
      state: 'paused',
      lastTransitionRevision: 1,
      sequence: 1,
    });
    expect(gate.transition('B Key', 'paused')).toMatchObject({
      ok: true,
      state: 'paused',
      lastTransitionRevision: 2,
      sequence: 2,
    });
    expect(gate.transition('A Key', 'open')).toMatchObject({
      ok: true,
      state: 'open',
      lastTransitionRevision: 3,
      sequence: 3,
    });

    const persisted = JSON.parse(readFileSync(storePath, 'utf8')) as Record<string, unknown>;
    expect(persisted).toMatchObject({
      schemaVersion: 1,
      sequence: 3,
      gates: {
        'A Key': { state: 'open', lastTransitionRevision: 3 },
        'B Key': { state: 'paused', lastTransitionRevision: 2 },
      },
      latestTransition: { fileKey: 'A Key', from: 'paused', to: 'open', revision: 3, at: 1_002 },
    });
    expect(readdirSync(join(storePath, '..')).filter((name) => name.includes('.tmp'))).toEqual([]);
  });

  it('keeps an unrelated target fresh when another target transitions', () => {
    const storePath = makeStorePath();
    const gate = new MutationAdmissionGate(storePath);
    gate.transition('A', 'paused');
    gate.transition('B', 'paused');
    const parkedB = gate.admit('B');
    expect(parkedB).toMatchObject({ ok: false, error: { code: 'E_MUTATIONS_PAUSED' }, lastTransitionRevision: 2 });

    gate.transition('A', 'open');
    const status = gate.status();
    expect(status.gates).toEqual(expect.arrayContaining([
      { fileKey: 'A', state: 'open', lastTransitionRevision: 3 },
      { fileKey: 'B', state: 'paused', lastTransitionRevision: 2 },
    ]));
  });

  it('fails closed and preserves corrupt evidence instead of replacing it', () => {
    const storePath = makeStorePath();
    const corrupt = '{not-json';
    writeFileSync(storePath, corrupt, 'utf8');
    const gate = new MutationAdmissionGate(storePath);

    expect(gate.admit('AbC123')).toMatchObject({ ok: false, error: { code: 'E_MUTATION_GATE_UNAVAILABLE' } });
    expect(gate.transition('AbC123', 'paused')).toMatchObject({ ok: false, error: { code: 'E_MUTATION_GATE_UNAVAILABLE' } });
    expect(readFileSync(storePath, 'utf8')).toBe(corrupt);
  });

  it('fails closed for wrong schema and malformed gate records', () => {
    const storePath = makeStorePath();
    writeFileSync(storePath, JSON.stringify({ schemaVersion: 2, sequence: 0, gates: {} }), 'utf8');
    expect(new MutationAdmissionGate(storePath).admit('A')).toMatchObject({
      ok: false,
      error: { code: 'E_MUTATION_GATE_UNAVAILABLE' },
    });

    writeFileSync(storePath, JSON.stringify({
      schemaVersion: 1,
      sequence: 1,
      gates: { A: { state: 'paused', lastTransitionRevision: 'wrong' } },
      latestTransition: { fileKey: 'A', from: 'open', to: 'paused', at: 1, revision: 1 },
    }), 'utf8');
    expect(new MutationAdmissionGate(storePath).admit('A')).toMatchObject({
      ok: false,
      error: { code: 'E_MUTATION_GATE_UNAVAILABLE' },
    });

    writeFileSync(storePath, JSON.stringify({
      schemaVersion: 1,
      sequence: 1,
      gates: { A: { state: 'paused', lastTransitionRevision: 2 } },
      latestTransition: { fileKey: 'A', from: 'open', to: 'paused', at: 1, revision: 1 },
    }), 'utf8');
    expect(new MutationAdmissionGate(storePath).admit('A')).toMatchObject({
      ok: false,
      error: { code: 'E_MUTATION_GATE_UNAVAILABLE' },
    });
  });

  it('fails closed when the store path is unreadable and preserves its evidence', () => {
    const storePath = makeStorePath();
    mkdirSync(storePath);

    expect(new MutationAdmissionGate(storePath).admit('A')).toMatchObject({
      ok: false,
      error: { code: 'E_MUTATION_GATE_UNAVAILABLE' },
    });
    expect(existsSync(storePath)).toBe(true);
  });

  it('fails closed on an atomic-write failure and leaves prior bytes untouched', () => {
    const storePath = makeStorePath();
    const before = JSON.stringify({
      schemaVersion: 1,
      sequence: 1,
      gates: { A: { state: 'paused', lastTransitionRevision: 1 } },
      latestTransition: { fileKey: 'A', from: 'open', to: 'paused', at: 1, revision: 1 },
    });
    writeFileSync(storePath, before, 'utf8');
    const gate = new MutationAdmissionGate(storePath, {
      writeFile: () => { throw new Error('disk full'); },
    });

    expect(gate.transition('A', 'open')).toMatchObject({ ok: false, error: { code: 'E_MUTATION_GATE_UNAVAILABLE' } });
    expect(gate.admit('A')).toMatchObject({ ok: false, error: { code: 'E_MUTATION_GATE_UNAVAILABLE' } });
    expect(readFileSync(storePath, 'utf8')).toBe(before);
  });

  it('uses distinct missing-key and paused denials', () => {
    const storePath = makeStorePath();
    const gate = new MutationAdmissionGate(storePath);
    expect(gate.admit('  ')).toMatchObject({ ok: false, error: { code: 'E_FILE_KEY_UNAVAILABLE' } });
    gate.transition('A', 'paused');
    expect(gate.admit('A')).toMatchObject({ ok: false, error: { code: 'E_MUTATIONS_PAUSED' } });
  });
});
