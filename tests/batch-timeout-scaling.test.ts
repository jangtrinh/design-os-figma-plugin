// Backlog 2.10 audit, phase 2 — BATCH's per-attempt wire timeout scales by op count
// instead of one fixed ceiling, mirroring southleft/figma-console-mcp's
// componentSetTimeoutMs (per-unit budget, floor, cap, hop buffer) adapted per-OP
// (this codebase has no CREATE_COMPONENT_SET-equivalent single command — BATCH, N ops
// in one uncancellable round trip, is the structurally closest analog). `batchTimeoutMs`
// and `execute` did not exist before this fix (batch.ts only had `run`, which called
// runCommand with no timeoutMs override at all — every batch used the flat
// COMMAND_TIMEOUTS.BATCH regardless of size).
import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { batchTimeoutMs, execute, type Runner } from '../cli/src/commands/batch.ts';
import { COMMAND_TIMEOUTS } from '../shared/protocol.ts';

const BASE_MS = COMMAND_TIMEOUTS.BATCH!;

describe('batchTimeoutMs — scales past the fixed default, never below it', () => {
  it('an ordinary small batch keeps the EXACT unchanged default', () => {
    expect(batchTimeoutMs(1)).toBe(BASE_MS);
    expect(batchTimeoutMs(10)).toBe(BASE_MS);
  });

  it('REGRESSION LOCK: a batch large enough that 1.2s/op + the hop buffer exceeds the default scales UP past it', () => {
    // 1.2s * 100 + 5s = 125s, well past the 60s default and above the 120s cap.
    const scaledButUncapped = batchTimeoutMs(46); // 1.2*46+5 = 60.2s > 60s base
    expect(scaledButUncapped).toBeGreaterThan(BASE_MS);
  });

  it('caps at 120s regardless of how large the batch is', () => {
    expect(batchTimeoutMs(1_000)).toBe(120_000);
    expect(batchTimeoutMs(1_000_000)).toBe(120_000);
  });

  it('is monotonically non-decreasing in op count', () => {
    let prev = batchTimeoutMs(0);
    for (const n of [1, 5, 20, 46, 60, 100, 200]) {
      const cur = batchTimeoutMs(n);
      expect(cur).toBeGreaterThanOrEqual(prev);
      prev = cur;
    }
  });
});

describe('batch execute() — threads the scaled timeout into the transport call', () => {
  let scratchDir: string;

  function writeBatchFile(ops: Array<{ cmd: string; params: unknown }>): string {
    scratchDir = mkdtempSync(join(tmpdir(), 'fa-batch-timeout-'));
    const filePath = join(scratchDir, 'ops.json');
    writeFileSync(filePath, JSON.stringify(ops));
    return filePath;
  }

  function cleanup(): void {
    if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
  }

  it('a small batch gets the unchanged default timeout', async () => {
    const ops = Array.from({ length: 3 }, () => ({ cmd: 'SET_TEXT', params: { nodeId: '1:1', text: 'x' } }));
    const filePath = writeBatchFile(ops);
    try {
      const calls: Array<{ cmd: string; params: unknown; opts?: { timeoutMs?: number } }> = [];
      const runner: Runner = async (cmd, params, opts) => {
        calls.push({ cmd, params, opts });
        return { ok: true };
      };
      await execute(filePath, false, runner);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.cmd).toBe('BATCH');
      expect(calls[0]?.opts?.timeoutMs).toBe(BASE_MS);
      expect((calls[0]?.params as { ops: unknown[] }).ops).toHaveLength(3);
    } finally {
      cleanup();
    }
  });

  it('a large batch gets a scaled timeout matching batchTimeoutMs(opCount)', async () => {
    const ops = Array.from({ length: 60 }, () => ({ cmd: 'SET_TEXT', params: { nodeId: '1:1', text: 'x' } }));
    const filePath = writeBatchFile(ops);
    try {
      const calls: Array<{ opts?: { timeoutMs?: number } }> = [];
      const runner: Runner = async (cmd, params, opts) => {
        calls.push({ opts });
        return { ok: true };
      };
      await execute(filePath, false, runner);
      expect(calls[0]?.opts?.timeoutMs).toBe(batchTimeoutMs(60));
      expect(calls[0]?.opts?.timeoutMs).toBeGreaterThan(BASE_MS);
    } finally {
      cleanup();
    }
  });

  it('threads stopOnError through unchanged', async () => {
    const filePath = writeBatchFile([{ cmd: 'SET_TEXT', params: {} }]);
    try {
      const calls: Array<{ params: unknown }> = [];
      const runner: Runner = async (cmd, params) => {
        calls.push({ params });
        return { ok: true };
      };
      await execute(filePath, true, runner);
      expect((calls[0]?.params as { stopOnError: boolean }).stopOnError).toBe(true);
    } finally {
      cleanup();
    }
  });
});
