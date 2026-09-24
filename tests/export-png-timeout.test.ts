// `figma-agent export-png --timeout` — the export waits 60s by default (a large frame at
// scale 2 outlasts the generic 15s round-trip), `--timeout ms` overrides, and anything
// above the 120s ceiling is clamped with one stderr notice. stdout stays one JSON object.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../cli/src/transport/broker-discovery.ts', () => ({
  ensureBroker: vi.fn(async () => { throw new Error('refusing to reach a real broker from a test'); }),
}));
vi.mock('../cli/src/transport/broker-client.ts', () => ({ runCommand: vi.fn() }));

import { parseArgs } from '../cli/src/arg-parse.ts';
import { run } from '../cli/src/commands/export-png.ts';
import { COMMAND_TIMEOUTS } from '../shared/protocol.ts';
import { CliError } from '../cli/src/transport/protocol-helpers.ts';
import { runCommand } from '../cli/src/transport/broker-client.ts';

const scratch = mkdtempSync(join(tmpdir(), 'figma-agent-export-timeout-'));
const out = join(scratch, 'shot.png');
const PNG = { base64: Buffer.from('png-bytes').toString('base64'), w: 10, h: 20 };

let stderr: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.mocked(runCommand).mockReset();
  vi.mocked(runCommand).mockResolvedValue(PNG);
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => stderr.mockRestore());

function exportOpts(): { timeoutMs?: number } | undefined {
  const call = vi.mocked(runCommand).mock.calls.find(([cmd]) => cmd === 'EXPORT_PNG');
  return call?.[2] as { timeoutMs?: number } | undefined;
}

describe('export-png timeout budget', () => {
  it('registers a 60s default for EXPORT_PNG', () => {
    expect(COMMAND_TIMEOUTS.EXPORT_PNG).toBe(60_000);
  });

  it('sends the 60s default when --timeout is absent', async () => {
    await run(parseArgs(['--node', '1:2', '--out', out]));
    expect(exportOpts()?.timeoutMs).toBe(60_000);
    expect(stderr).not.toHaveBeenCalled();
  });

  it('honours --timeout inside the ceiling with no notice', async () => {
    await run(parseArgs(['--node', '1:2', '--out', out, '--timeout', '90000']));
    expect(exportOpts()?.timeoutMs).toBe(90_000);
    expect(stderr).not.toHaveBeenCalled();
  });

  it('clamps --timeout above the ceiling and prints exactly one notice naming both values', async () => {
    await run(parseArgs(['--node', '1:2', '--out', out, '--timeout', '300000']));
    expect(exportOpts()?.timeoutMs).toBe(120_000);
    expect(stderr).toHaveBeenCalledTimes(1);
    const line = String(stderr.mock.calls[0][0]);
    expect(line).toContain('300000');
    expect(line).toContain('120000');
  });

  it.each([['0'], ['-5'], ['abc']])('rejects --timeout %s with E_INVALID_ARGS before any broker call', async (value) => {
    const err = await run(parseArgs(['--node', '1:2', '--out', out, '--timeout', value])).catch((e) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe('E_INVALID_ARGS');
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('rejects a bare --timeout (parsed as true) with E_INVALID_ARGS', async () => {
    const err = await run(parseArgs(['--node', '1:2', '--out', out, '--timeout'])).catch((e) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe('E_INVALID_ARGS');
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('keeps the reply shape: one object with path, w, h', async () => {
    const reply = await run(parseArgs(['--node', '1:2', '--out', out, '--timeout', '90000']));
    expect(reply).toEqual({ path: out, w: 10, h: 20 });
  });

  it('leaves the --assert leg on its own --assert-timeout', async () => {
    vi.mocked(runCommand).mockImplementation(async (cmd: string) => (cmd === 'EXEC_JS' ? { result: true } : PNG));
    const script = join(scratch, 'ok.js');
    (await import('node:fs')).writeFileSync(script, 'return true;', 'utf8');
    await run(parseArgs(['--node', '1:2', '--out', out, '--assert', script, '--assert-timeout', '5000', '--timeout', '90000']));
    const assertCall = vi.mocked(runCommand).mock.calls.find(([cmd]) => cmd === 'EXEC_JS');
    expect((assertCall?.[1] as { timeoutMs: number }).timeoutMs).toBe(5_000);
    expect(exportOpts()?.timeoutMs).toBe(90_000);
  });
});
