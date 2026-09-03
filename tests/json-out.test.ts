// Single-JSON stdout contract — `printErrorJson`'s {error:{code,message}} shape, plus the
// additive `rolledBack`/`jobId`/`fileContext` fields. No prior test file existed for this
// module; added alongside concurrency & jobs' (backlog 1.1+2.6+4.3) `jobId` addition so
// the byte-identical-when-absent guarantee is actually verified, not just asserted in a
// comment.
import { describe, expect, it, vi, afterEach } from 'vitest';
import { printErrorJson } from '../cli/src/util/json-out.ts';
import { CliError } from '../cli/src/transport/protocol-helpers.ts';

function captureExit(fn: () => void): { out: string; code: number | undefined } {
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  fn();
  // Read the mock history BEFORE restoring — `mockRestore()` also clears `.mock.calls`.
  const out = writeSpy.mock.calls.map((c) => String(c[0])).join('');
  const code = exitSpy.mock.calls[0]?.[0] as number | undefined;
  writeSpy.mockRestore();
  exitSpy.mockRestore();
  return { out, code };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('printErrorJson', () => {
  it('a plain CliError with none of the additive fields prints exactly {code,message}', () => {
    const { out, code } = captureExit(() => printErrorJson(new CliError('E_NO_PLUGIN', 'no plugin')));
    expect(code).toBe(1);
    expect(JSON.parse(out)).toEqual({ error: { code: 'E_NO_PLUGIN', message: 'no plugin' } });
  });

  it('includes jobId only when the CliError carries one (concurrency & jobs)', () => {
    const { out } = captureExit(() => printErrorJson(new CliError('E_TIMEOUT', 'still running', { jobId: 'j_1_1' })));
    expect(JSON.parse(out)).toEqual({ error: { code: 'E_TIMEOUT', message: 'still running', jobId: 'j_1_1' } });
  });

  it('an E_TIMEOUT with no jobId omits the key entirely (byte-identical to before this wave)', () => {
    const { out } = captureExit(() => printErrorJson(new CliError('E_TIMEOUT', 'timed out')));
    const parsed = JSON.parse(out) as { error: Record<string, unknown> };
    expect('jobId' in parsed.error).toBe(false);
  });

  it('prints E_AMBIGUOUS candidates as structured data only when the CliError carries them', () => {
    const candidates = [{ id: '10:1', name: 'Table / Cell', type: 'COMPONENT_SET', page: { id: 'p', name: 'DS' } }];
    const { out, code } = captureExit(() => printErrorJson(new CliError('E_AMBIGUOUS', '2 live nodes', { candidates })));
    expect(JSON.parse(out)).toEqual({ error: { code: 'E_AMBIGUOUS', message: '2 live nodes', candidates } });
    expect(code).toBe(1);
    const { out: plain } = captureExit(() => printErrorJson(new CliError('E_NOT_FOUND', 'none')));
    expect(JSON.parse(plain)).toEqual({ error: { code: 'E_NOT_FOUND', message: 'none' } });
  });

  it('carries both rolledBack and jobId together when both are set', () => {
    const { out } = captureExit(() => printErrorJson(new CliError('E_EVAL', 'boom', { rolledBack: true, jobId: 'j_2_2' })));
    expect(JSON.parse(out)).toEqual({ error: { code: 'E_EVAL', message: 'boom', rolledBack: true, jobId: 'j_2_2' } });
  });

  it('a non-CliError maps to E_INTERNAL, never leaking a jobId field', () => {
    const { out } = captureExit(() => printErrorJson(new Error('plain')));
    expect(JSON.parse(out)).toEqual({ error: { code: 'E_INTERNAL', message: 'plain' } });
  });

  it('fileContext is attached alongside the error object when given', () => {
    const { out } = captureExit(() => printErrorJson(new CliError('E_NO_PLUGIN', 'x'), { fileName: 'VSF - PCP' }));
    expect(JSON.parse(out)).toEqual({
      error: { code: 'E_NO_PLUGIN', message: 'x' },
      fileContext: { fileName: 'VSF - PCP' },
    });
  });

  it('projects exact structured recovery while ordinary errors remain unchanged', () => {
    const recovery = {
      kind: 'inspect-and-force-release' as const,
      command: 'figma-agent job j_3_3 --force-release',
      requiresCanvasInspection: true as const,
      retryAllowed: false as const,
    };
    const { out } = captureExit(() => printErrorJson(new CliError(
      'E_OUTCOME_UNKNOWN', 'uncertain', { jobId: 'j_3_3', recovery },
    )));
    expect(JSON.parse(out)).toEqual({
      error: { code: 'E_OUTCOME_UNKNOWN', message: 'uncertain', jobId: 'j_3_3', recovery },
    });
  });
});
