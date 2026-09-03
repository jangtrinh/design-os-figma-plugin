// `figma-agent export-png --assert <script.js>` — craft gate 9 in one command: the
// structural assert runs FIRST as a plugin-enforced read-only EXEC_JS, and the PNG is
// written only when it passes. Every failure shape (falsy, {ok:false}, a throw, a
// mutation caught by the plugin's read-only guard) leaves no PNG behind.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../cli/src/transport/broker-client.ts', () => ({ runCommand: vi.fn() }));

import { parseArgs } from '../cli/src/arg-parse.ts';
import { assertPasses, run } from '../cli/src/commands/export-png.ts';
import { CliError } from '../cli/src/transport/protocol-helpers.ts';
import { runCommand } from '../cli/src/transport/broker-client.ts';

const scratch = mkdtempSync(join(tmpdir(), 'figma-agent-export-assert-'));
const PNG = { base64: Buffer.from('png-bytes').toString('base64'), w: 10, h: 20 };

function script(name: string, code: string): string {
  const path = join(scratch, name);
  writeFileSync(path, code, 'utf8');
  return path;
}

function mockBroker(execReply: unknown | Error): void {
  vi.mocked(runCommand).mockImplementation(async (cmd: string) => {
    if (cmd === 'EXEC_JS') {
      if (execReply instanceof Error) throw execReply;
      return execReply;
    }
    if (cmd === 'EXPORT_PNG') return PNG;
    throw new Error(`unexpected ${cmd}`);
  });
}

describe('assertPasses — what counts as a passing assert reply', () => {
  it.each([
    [{ result: true }, true],
    [{ result: { ok: true, checks: 3 } }, true],
    [{ result: 'shell instance lineage verified' }, true],
    [{ result: false }, false],
    [{ result: { ok: false, reason: 'slot detached' } }, false],
    [{ result: null }, false],
    [{ result: undefined }, false],
    [{ result: 0 }, false],
    [null, false],
  ])('%j → %s', (reply, expected) => {
    expect(assertPasses(reply)).toBe(expected);
  });
});

describe('export-png --assert', () => {
  beforeEach(() => {
    vi.mocked(runCommand).mockReset();
  });

  it('runs the assert as plugin-enforced read-only EXEC_JS BEFORE the export, then writes the PNG', async () => {
    mockBroker({ result: { ok: true, checks: 3 }, console: [], ms: 1 });
    const assertPath = script('ok.js', 'return { ok: true, checks: 3 }');
    const out = join(scratch, 'ok.png');
    const result = await run(parseArgs(['--node', '1:2', '--out', out, '--assert', assertPath]));
    expect(result).toEqual({ path: out, w: 10, h: 20, assert: { script: assertPath, result: { ok: true, checks: 3 } } });
    expect(readFileSync(out, 'utf8')).toBe('png-bytes');
    const calls = vi.mocked(runCommand).mock.calls.map((c) => c[0]);
    expect(calls).toEqual(['EXEC_JS', 'EXPORT_PNG']);
    expect(vi.mocked(runCommand).mock.calls[0]![1]).toEqual({ code: 'return { ok: true, checks: 3 }', timeoutMs: 30_000 });
    expect(vi.mocked(runCommand).mock.calls[0]![2]).toMatchObject({ pluginEnforcedReadOnly: true, activity: `Assert · ${assertPath}` });
  });

  it('a plain truthy return passes too', async () => {
    mockBroker({ result: true, console: [], ms: 1 });
    const out = join(scratch, 'truthy.png');
    await run(parseArgs(['--node', '1:2', '--out', out, '--assert', script('truthy.js', 'return true')]));
    expect(existsSync(out)).toBe(true);
  });

  it('a falsy return → E_ASSERT_FAILED, no EXPORT_PNG call, no file', async () => {
    mockBroker({ result: false, console: [], ms: 1 });
    const out = join(scratch, 'falsy.png');
    await expect(run(parseArgs(['--node', '1:2', '--out', out, '--assert', script('falsy.js', 'return false')])))
      .rejects.toMatchObject({ code: 'E_ASSERT_FAILED', message: expect.stringMatching(/false.*PNG not written/s) });
    expect(vi.mocked(runCommand).mock.calls.map((c) => c[0])).toEqual(['EXEC_JS']);
    expect(existsSync(out)).toBe(false);
  });

  it('{ok:false, reason} → E_ASSERT_FAILED carrying the reason verbatim', async () => {
    mockBroker({ result: { ok: false, reason: 'slot detached from master' }, console: [], ms: 1 });
    const out = join(scratch, 'reason.png');
    await expect(run(parseArgs(['--node', '1:2', '--out', out, '--assert', script('reason.js', 'return x')])))
      .rejects.toMatchObject({ code: 'E_ASSERT_FAILED', message: expect.stringContaining('slot detached from master') });
    expect(existsSync(out)).toBe(false);
  });

  it('an assert script that throws keeps its own error code and names the assert; nothing is exported', async () => {
    mockBroker(new CliError('E_PLUGIN_ERROR', 'Cannot read properties of null'));
    const out = join(scratch, 'throws.png');
    await expect(run(parseArgs(['--node', '1:2', '--out', out, '--assert', script('throws.js', 'null.x')])))
      .rejects.toMatchObject({ code: 'E_PLUGIN_ERROR', message: expect.stringMatching(/assert.*throws\.js.*Cannot read properties of null/s) });
    expect(vi.mocked(runCommand).mock.calls.map((c) => c[0])).toEqual(['EXEC_JS']);
    expect(existsSync(out)).toBe(false);
  });

  it('an assert that mutates is refused by the plugin read-only guard — surfaced as-is, PNG not written', async () => {
    mockBroker(new CliError('E_READONLY_VIOLATION', 'EXEC_JS declared --read-only but mutated the scene'));
    const out = join(scratch, 'mutating.png');
    await expect(run(parseArgs(['--node', '1:2', '--out', out, '--assert', script('mutating.js', 'figma.createFrame()')])))
      .rejects.toMatchObject({ code: 'E_READONLY_VIOLATION' });
    expect(existsSync(out)).toBe(false);
  });

  it('an assert script with a hard lint finding is refused before any broker round-trip', async () => {
    mockBroker({ result: true });
    const out = join(scratch, 'lint.png');
    await expect(run(parseArgs(['--node', '1:2', '--out', out, '--assert', script('lint.js', 'return figma.getNodeById("1:2")')])))
      .rejects.toMatchObject({ code: 'E_INVALID_ARGS', message: expect.stringMatching(/sync-get-node-by-id/) });
    expect(runCommand).not.toHaveBeenCalled();
    expect(existsSync(out)).toBe(false);
  });

  it('an unreadable --assert path is E_INVALID_ARGS, before any broker round-trip', async () => {
    mockBroker({ result: true });
    await expect(run(parseArgs(['--node', '1:2', '--out', join(scratch, 'x.png'), '--assert', join(scratch, 'missing.js')])))
      .rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('without --assert the command is unchanged: one EXPORT_PNG, same output shape', async () => {
    mockBroker({ result: true });
    const out = join(scratch, 'plain.png');
    await expect(run(parseArgs(['--node', 'selection', '--out', out]))).resolves.toEqual({ path: out, w: 10, h: 20 });
    expect(vi.mocked(runCommand).mock.calls.map((c) => c[0])).toEqual(['EXPORT_PNG']);
  });
});
