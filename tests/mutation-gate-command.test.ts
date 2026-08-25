import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandArgs } from '../cli/src/arg-parse.ts';

vi.mock('../cli/src/transport/broker-client.ts', () => ({ runCommand: vi.fn() }));

const { runCommand } = await import('../cli/src/transport/broker-client.ts');
const { run } = await import('../cli/src/commands/mutation-gate.ts');

function fakeArgs(positionals: string[], flags: Record<string, string | boolean> = {}): CommandArgs {
  return {
    positionals,
    str: (name) => (typeof flags[name] === 'string' ? flags[name] as string : undefined),
    req: (name) => {
      const value = flags[name];
      if (typeof value !== 'string') throw new Error(`missing --${name}`);
      return value;
    },
    num: () => undefined,
    bool: (name) => flags[name] === true || flags[name] === 'true',
  };
}

describe('mutation-gate command', () => {
  beforeEach(() => vi.mocked(runCommand).mockReset());

  it.each(['pause', 'resume', 'status'] as const)('sends %s with the exact raw file key', async (mode) => {
    vi.mocked(runCommand).mockResolvedValue({ mode });

    await expect(run(fakeArgs([mode], { 'file-key': '  Raw Key / unchanged  ' }))).resolves.toEqual({ mode });
    expect(runCommand).toHaveBeenCalledWith('MUTATION_GATE', {
      mode,
      fileKey: '  Raw Key / unchanged  ',
    });
  });

  it.each([
    [[], { 'file-key': 'Raw' }],
    [['unknown'], { 'file-key': 'Raw' }],
    [['pause'], {}],
    [['pause'], { 'file-key': '' }],
    [['pause'], { 'file-key': ' \t\n ' }],
  ] as const)('rejects invalid CLI input with E_INVALID_ARGS: %j', async (positionals, flags) => {
    await expect(run(fakeArgs([...positionals], { ...flags }))).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
    expect(runCommand).not.toHaveBeenCalled();
  });
});
