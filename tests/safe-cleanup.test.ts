import { describe, expect, it, vi } from 'vitest';
import { safeCleanup } from '../shared/safe-cleanup';

describe('safeCleanup', () => {
  it('rethrows the original error unchanged when cleanup succeeds', () => {
    const original = new Error('original failure');
    const cleanup = vi.fn();
    expect(() => safeCleanup(original, cleanup)).toThrow(original);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect((original as Error & { cleanupError?: unknown }).cleanupError).toBeUndefined();
  });

  it('surfaces the original error, with the cleanup failure attached, when cleanup throws', () => {
    const original = new Error('original failure');
    const cleanupError = new Error('cleanup failure');
    let thrown: unknown;
    try {
      safeCleanup(original, () => { throw cleanupError; });
    } catch (err) {
      thrown = err;
    }
    // The ORIGINAL error propagates — never substituted by the cleanup failure.
    expect(thrown).toBe(original);
    expect((thrown as Error).message).toBe('original failure');
    expect((thrown as Error & { cleanupError?: unknown }).cleanupError).toBe(cleanupError);
  });

  it('preserves a custom error subclass\'s code and message byte-for-byte', () => {
    class CliError extends Error {
      constructor(readonly code: string, message: string) {
        super(message);
      }
    }
    const original = new CliError('E_EVAL', 'exact message must survive');
    try {
      safeCleanup(original, () => { throw new Error('cleanup boom'); });
      throw new Error('safeCleanup did not throw');
    } catch (err) {
      expect(err).toBe(original);
      expect((err as CliError).code).toBe('E_EVAL');
      expect((err as CliError).message).toBe('exact message must survive');
    }
  });

  // The airtight case PR #23's reviewer flagged: a frozen/non-extensible
  // originalError. A naive `err.cleanupError = cleanupErr` assignment throws a
  // TypeError in strict mode against a frozen object — which would itself
  // replace the original error and re-mask it. This test fails against that
  // naive implementation and passes only when the attachment is guarded.
  it('does not re-mask when originalError is frozen (non-extensible)', () => {
    const original = Object.freeze(new Error('frozen original failure'));
    const cleanupError = new Error('cleanup failure');
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      let thrown: unknown;
      try {
        safeCleanup(original, () => { throw cleanupError; });
      } catch (err) {
        thrown = err;
      }
      // The un-masking guarantee must never itself throw: the frozen original
      // error propagates unchanged, not a TypeError from the attempted assignment.
      expect(thrown).toBe(original);
      expect((thrown as Error).message).toBe('frozen original failure');
      expect((thrown as Error).constructor).toBe(Error);
      // Since attachment onto a frozen object is impossible, the cleanup failure
      // must be surfaced some other way (logging) rather than silently dropped.
      expect(consoleErrorSpy).toHaveBeenCalled();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('does not call cleanupFn\'s throw path when cleanup does not throw, even for a frozen originalError', () => {
    const original = Object.freeze(new Error('frozen but fine'));
    const cleanup = vi.fn();
    let thrown: unknown;
    try {
      safeCleanup(original, cleanup);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBe(original);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
