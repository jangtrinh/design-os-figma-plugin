// Issue #16 (follow-up to PR #14) — PR #14's op-scaled BATCH timeout clamps at 120s
// (CAP_MS in cli/src/commands/batch.ts), so from ~96 ops up the UNCAPPED formula
// (opCount * PER_OP_MS + HOP_BUFFER_MS) already exceeds the cap: batchTimeoutMs
// silently returns 120s regardless, but that is now LESS than what the formula says
// the pass needs. Dispatching anyway sends an uncancellable, sequential plugin-side
// pass that keeps running past its own reported timeout — the CLI declares failure
// while ops keep landing, inviting a double-apply retry.
//
// RULING: hard refusal before dispatch, not a raised cap. `assertBatchAdmissible`
// (and its `execute()` call site) did not exist before this fix — pre-fix, `execute`
// called `runner('BATCH', ...)` unconditionally for any op count, so an over-ceiling
// batch was dispatched and left to time out mid-flight.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertBatchAdmissible, execute, maxBatchOps, type Runner } from '../cli/src/commands/batch.ts';

describe('maxBatchOps — derived from the exact PR #14 formula, not re-guessed', () => {
  it('REGRESSION LOCK: the boundary is 95 ops (95*1200+5000=119000 <= 120000; 96*1200+5000=120200 > 120000)', () => {
    expect(maxBatchOps()).toBe(95);
  });
});

describe('assertBatchAdmissible — hard refusal above the 120s scaled-timeout ceiling', () => {
  it('accepts exactly the boundary op count (M)', () => {
    expect(() => assertBatchAdmissible(maxBatchOps())).not.toThrow();
  });

  it('accepts anything below the boundary', () => {
    expect(() => assertBatchAdmissible(1)).not.toThrow();
    expect(() => assertBatchAdmissible(60)).not.toThrow();
  });

  it('refuses M+1 — one op past the boundary', () => {
    expect(() => assertBatchAdmissible(maxBatchOps() + 1)).toThrow();
  });

  it('refuses with a stable E_INVALID_ARGS code and an actionable message naming the op count, the ceiling, and the max that fits', () => {
    const opCount = maxBatchOps() + 1;
    try {
      assertBatchAdmissible(opCount);
      throw new Error('expected assertBatchAdmissible to throw');
    } catch (err) {
      const cliErr = err as { code?: string; message?: string };
      expect(cliErr.code).toBe('E_INVALID_ARGS');
      expect(cliErr.message).toContain(String(opCount));
      expect(cliErr.message).toContain('120s');
      expect(cliErr.message).toContain(String(maxBatchOps()));
    }
  });

  it('refuses a grossly over-ceiling batch too, not just the boundary+1', () => {
    expect(() => assertBatchAdmissible(1_000)).toThrow();
  });
});

describe('execute() — the refusal fires BEFORE any dispatch, so the runner is never called', () => {
  let scratchDir: string;

  function writeBatchFile(count: number): string {
    scratchDir = mkdtempSync(join(tmpdir(), 'fa-batch-ceiling-'));
    const filePath = join(scratchDir, 'ops.json');
    const ops = Array.from({ length: count }, () => ({ cmd: 'SET_TEXT', params: { nodeId: '1:1', text: 'x' } }));
    writeFileSync(filePath, JSON.stringify(ops));
    return filePath;
  }

  function cleanup(): void {
    if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
  }

  it('a batch at the boundary (M ops) is dispatched normally', async () => {
    const filePath = writeBatchFile(maxBatchOps());
    try {
      let called = false;
      const runner: Runner = async () => {
        called = true;
        return { ok: true };
      };
      await execute(filePath, false, runner);
      expect(called).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('a batch one op past the boundary (M+1 ops) is refused — the runner is never invoked, no job is ever created for a pass that would time out mid-flight', async () => {
    const filePath = writeBatchFile(maxBatchOps() + 1);
    try {
      let called = false;
      const runner: Runner = async () => {
        called = true;
        return { ok: true };
      };
      await expect(execute(filePath, false, runner)).rejects.toThrow();
      expect(called).toBe(false);
    } finally {
      cleanup();
    }
  });
});
