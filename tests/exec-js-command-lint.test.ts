import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../cli/src/transport/broker-client.ts', () => ({ runCommand: vi.fn() }));

import { parseArgs } from '../cli/src/arg-parse.ts';
import { run } from '../cli/src/commands/exec-js.ts';
import { runCommand } from '../cli/src/transport/broker-client.ts';

const scratch = mkdtempSync(join(tmpdir(), 'figma-agent-exec-lint-'));

function script(name: string, code: string): string {
  const path = join(scratch, name);
  writeFileSync(path, code, 'utf8');
  return path;
}

describe('exec-js command pre-dispatch lint', () => {
  beforeEach(() => {
    vi.mocked(runCommand).mockReset();
    vi.mocked(runCommand).mockResolvedValue({ ok: true });
    vi.restoreAllMocks();
  });

  it('rejects hard findings before broker dispatch with rule id and fix', async () => {
    const path = script('hard.js', 'return figma.getNodeById("1:2")');
    await expect(run(parseArgs([path]))).rejects.toMatchObject({
      code: 'E_INVALID_ARGS',
      message: expect.stringMatching(/sync-get-node-by-id.*getNodeByIdAsync/s),
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('writes warnings to stderr and still dispatches unchanged', async () => {
    const path = script('warning.js', 'return instance.mainComponent');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await run(parseArgs([path, '--timeout', '5000']));
    expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/^warning: \[sync-main-component-property\]/));
    expect(runCommand).toHaveBeenCalledOnce();
    expect(runCommand).toHaveBeenCalledWith(
      'EXEC_JS',
      { code: 'return instance.mainComponent', timeoutMs: 5000 },
      { timeoutMs: 7000, activity: `Run script · ${path}` },
    );
  });

  it('--no-lint bypasses errors and warnings without changing dispatch', async () => {
    const path = script('bypass.js', 'return figma.getNodeById("1:2")');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await run(parseArgs([path, '--no-lint']));
    expect(stderr).not.toHaveBeenCalled();
    expect(runCommand).toHaveBeenCalledOnce();
  });

  it('--no-lint=false leaves lint enabled', async () => {
    const path = script('lint-enabled.js', 'return figma.getNodeById("1:2")');
    await expect(run(parseArgs([path, '--no-lint=false']))).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('refuses the parser footgun when --no-lint swallows the following file', async () => {
    const path = script('swallowed.js', 'return 1');
    await expect(run(parseArgs(['--no-lint', path]))).rejects.toMatchObject({
      code: 'E_INVALID_ARGS',
      message: expect.stringMatching(/place --no-lint after the script file/i),
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('a clean script keeps the current broker call and return value', async () => {
    const path = script('clean.js', 'return await figma.getNodeByIdAsync("1:2")');
    vi.mocked(runCommand).mockResolvedValue({ result: 1 });
    await expect(run(parseArgs([path]))).resolves.toEqual({ result: 1 });
    expect(runCommand).toHaveBeenCalledOnce();
  });
});
