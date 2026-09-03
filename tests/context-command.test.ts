// `figma-agent context` — the CLI half. Three things worth a test: the target resolution it
// shares with `inspect`, the read-only assertion (which is what keeps a context read out of
// the mutation FIFO, so it never queues behind someone's build), and the refusal of the
// flag that is RESERVED but not implemented — a silently-ignored `--format tree` would have
// the caller believe it got a tree.
import { describe, expect, it } from 'vitest';
import { contextTarget, resolveContextParams, run } from '../cli/src/commands/context.ts';
import { parseArgs } from '../cli/src/arg-parse.ts';
import { COMMAND_TIMEOUTS } from '../shared/protocol.ts';

const reply = { schema: 'context/1', nodes: [{ id: '1:2' }], refs: {}, budget: { complete: true } };

describe('context command — params', () => {
  it('defaults to a 64 KB budget and a soft deadline 2s inside the wire timeout', () => {
    expect(resolveContextParams({})).toEqual({
      params: { budgetBytes: 65_536, deadlineMs: (COMMAND_TIMEOUTS.GET_CONTEXT ?? 0) - 2_000 },
      timeoutMs: COMMAND_TIMEOUTS.GET_CONTEXT,
    });
  });

  it('converts --budget from KB, passes depth and no-css through, and follows --timeout', () => {
    expect(resolveContextParams({ budgetKb: 8, depth: 2, noCss: true, timeout: 9_000 })).toEqual({
      params: { budgetBytes: 8_192, deadlineMs: 7_000, depth: 2, noCss: true },
      timeoutMs: 9_000,
    });
  });

  it('never hands the plugin a non-positive deadline, however short --timeout is', () => {
    expect(resolveContextParams({ timeout: 500 }).params.deadlineMs).toBe(250);
  });

  it('refuses a budget or depth it cannot honestly convert', () => {
    expect(() => resolveContextParams({ budgetKb: 0 })).toThrow(/--budget/);
    expect(() => resolveContextParams({ budgetKb: -4 })).toThrow(/--budget/);
    expect(() => resolveContextParams({ depth: -1 })).toThrow(/--depth/);
    expect(() => resolveContextParams({ depth: 1.5 })).toThrow(/--depth/);
  });
});

describe('context command — the call', () => {
  it('asserts read-only so the read bypasses the mutation FIFO, and prints the reply', async () => {
    const calls: { cmd: string; params: unknown; opts?: Record<string, unknown> }[] = [];
    const runner = async (cmd: string, params: unknown, opts?: Record<string, unknown>): Promise<unknown> => {
      calls.push({ cmd, params, opts });
      if (cmd === 'GET_CONTEXT') return reply;
      throw new Error(`unexpected ${cmd}`);
    };
    const out = await contextTarget({ explicit: '1:2' }, runner) as Record<string, unknown>;
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('GET_CONTEXT');
    expect(calls[0].params).toMatchObject({ nodeId: '1:2', budgetBytes: 65_536 });
    expect(calls[0].opts).toMatchObject({ readOnly: true });
    expect(out).toMatchObject({ schema: 'context/1', targetSource: 'explicit' });
  });

  it('resolves the target from the selection exactly as inspect does', async () => {
    const runner = async (cmd: string): Promise<unknown> => {
      if (cmd === 'GET_SELECTION') return { selection: [{ id: '9:9' }] };
      if (cmd === 'GET_CONTEXT') return reply;
      throw new Error(`unexpected ${cmd}`);
    };
    const out = await contextTarget({}, runner) as Record<string, unknown>;
    expect(out).toMatchObject({ nodeId: '9:9', targetSource: 'selection' });
  });

  it('falls back to the most recently corrected node when nothing is selected', async () => {
    const runner = async (cmd: string): Promise<unknown> => {
      if (cmd === 'GET_SELECTION') return { selection: [] };
      if (cmd === 'GET_CORRECTION_MEMORY') return {
        events: [
          { nodeId: 'old', timestamp: '2026-07-01T00:00:00.000Z' },
          { nodeId: 'recent', timestamp: '2026-07-02T00:00:00.000Z' },
        ],
      };
      if (cmd === 'GET_CONTEXT') return reply;
      throw new Error(`unexpected ${cmd}`);
    };
    const out = await contextTarget({}, runner) as Record<string, unknown>;
    expect(out).toMatchObject({ nodeId: 'recent', targetSource: 'recent' });
  });

  it('refuses with the caller-actionable message when there is no target at all', async () => {
    const runner = async (cmd: string): Promise<unknown> => {
      if (cmd === 'GET_SELECTION') return { selection: [] };
      if (cmd === 'GET_CORRECTION_MEMORY') return { events: [] };
      throw new Error(`unexpected ${cmd}`);
    };
    await expect(contextTarget({}, runner)).rejects.toThrow(/no target/);
  });
});

describe('context command — a valueless numeric flag is refused, never defaulted', () => {
  // `parseArgs` stores a flag whose next token starts with `--` as boolean true, so `num()`
  // answers undefined and the default silently applies: `--depth --no-css` walked the
  // subtree UNBOUNDED after the caller asked to bound it, and `--budget --no-css` reported
  // requestedBytes 65536, a number the caller never stated. Same refusal figma-agent.ts
  // already makes for a valueless --file / --instance / --target-file-key.
  it.each(['budget', 'depth', 'timeout'])('refuses a valueless --%s by name', async (flag) => {
    await expect(run(parseArgs(['1:2', `--${flag}`, '--no-css']))).rejects.toMatchObject({
      code: 'E_INVALID_ARGS',
    });
    await expect(run(parseArgs(['1:2', `--${flag}`]))).rejects.toThrow(new RegExp(`--${flag}`));
  });

  it('refuses a --budget that floors to zero bytes before spending a round trip', async () => {
    await expect(run(parseArgs(['1:2', '--budget', '0.0001']))).rejects.toMatchObject({
      code: 'E_INVALID_ARGS',
    });
  });
});

describe('context command — --format is reserved, not implemented', () => {
  it('exits with E_INVALID_ARGS before any broker traffic', async () => {
    await expect(run(parseArgs(['1:2', '--format', 'tree']))).rejects.toMatchObject({
      code: 'E_INVALID_ARGS',
    });
    await expect(run(parseArgs(['1:2', '--format']))).rejects.toThrow(/--format/);
  });
});
