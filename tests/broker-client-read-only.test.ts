// `--read-only` is an explicit broker safe-read declaration. EXEC_JS and every other
// non-member remain on the mutation path; already safe-read commands retain a harmless
// no-op declaration.
import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { exchange, refusesReadOnlyAssertion, setTargetFileKey } from '../cli/src/transport/broker-client.ts';
import { BROKER_SAFE_READ_COMMANDS, MUTATING_COMMANDS } from '../shared/mutating-commands.ts';

function fakeWs(): EventEmitter & { send: (text: string) => void; sent: string[] } {
  const emitter = new EventEmitter() as EventEmitter & { send: (text: string) => void; sent: string[] };
  emitter.sent = [];
  emitter.send = (text: string) => { emitter.sent.push(text); };
  return emitter;
}

afterEach(() => setTargetFileKey(undefined));

describe('refusesReadOnlyAssertion', () => {
  it('refuses a mutating-by-name command (SET_TEXT) asserting --read-only', () => {
    expect(refusesReadOnlyAssertion('SET_TEXT', true)).toBe(true);
  });

  it('permits only the broker-owned safe-read allowlist when readOnly is true', () => {
    for (const cmd of BROKER_SAFE_READ_COMMANDS) expect(refusesReadOnlyAssertion(cmd, true)).toBe(false);
    for (const cmd of MUTATING_COMMANDS) expect(refusesReadOnlyAssertion(cmd, true)).toBe(true);
    for (const cmd of ['BATCH', 'AUDIT_DS'] as const) expect(refusesReadOnlyAssertion(cmd, true)).toBe(true);
  });

  it('an already-read-only command (STATUS) makes the flag a harmless no-op', () => {
    expect(refusesReadOnlyAssertion('STATUS', true)).toBe(false);
  });

  it('readOnly=false never refuses anything, regardless of command', () => {
    expect(refusesReadOnlyAssertion('SET_TEXT', false)).toBe(false);
    expect(refusesReadOnlyAssertion('EXEC_JS', false)).toBe(false);
  });

  it('stamps only the exact global target-file-key on outgoing request frames', async () => {
    setTargetFileKey('Raw/Key 7');
    const ws = fakeWs();
    const pending = exchange(ws as unknown as WebSocket, 'STATUS', {}, 5_000);
    const sent = JSON.parse(ws.sent[0]!) as { id: string; targetFileKey?: string };
    expect(sent.targetFileKey).toBe('Raw/Key 7');
    ws.emit('message', Buffer.from(JSON.stringify({ id: sent.id, ok: true, result: { ok: true } })));
    await expect(pending).resolves.toEqual({ ok: true });

    setTargetFileKey(undefined);
    const withoutTarget = fakeWs();
    const noTargetPending = exchange(withoutTarget as unknown as WebSocket, 'STATUS', {}, 5_000);
    const noTargetSent = JSON.parse(withoutTarget.sent[0]!) as { id: string; targetFileKey?: string };
    expect(noTargetSent).not.toHaveProperty('targetFileKey');
    withoutTarget.emit('message', Buffer.from(JSON.stringify({ id: noTargetSent.id, ok: true, result: { ok: true } })));
    await expect(noTargetPending).resolves.toEqual({ ok: true });
  });
});
