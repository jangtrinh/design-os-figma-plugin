// The `--agent`/`FIGMA_AGENT_ID` label, envelope half: it must be additive to
// makeRequestFrame — an unset agent produces the exact byte-identical frame a
// pre-flag CLI always sent (see activity-labels.test.ts's own template for the
// `activity` field this mirrors). Also covers `resolveAgent`'s own guards
// (trim/empty/length/control-char/env-fallback) and the built-CLI subprocess
// path for the one guard that exits the process (`printErrorJson`), which a
// direct unit call cannot safely exercise.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_VERSION, makeRequestFrame } from '../shared/protocol.ts';
import { resolveAgent } from '../cli/src/figma-agent.ts';
import type { CommandArgs } from '../cli/src/arg-parse.ts';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CLI_DIST = `${ROOT}/cli/dist/figma-agent.js`;

function fakeArgs(flags: Record<string, string | boolean> = {}): CommandArgs {
  return {
    positionals: [],
    str: (name) => (typeof flags[name] === 'string' ? (flags[name] as string) : undefined),
    req: (name) => {
      const v = flags[name];
      if (typeof v !== 'string') throw new Error(`missing --${name}`);
      return v;
    },
    num: (name) => (typeof flags[name] === 'string' ? Number(flags[name]) : undefined),
    bool: (name) => flags[name] === true || flags[name] === 'true',
  };
}

describe('makeRequestFrame — agent label is additive, never a wire change', () => {
  it('carries the agent label when one is given, as the 9th positional', () => {
    expect(makeRequestFrame('c_1', 'STATUS', {}, undefined, undefined, undefined, undefined, undefined, 'claude'))
      .toEqual({ id: 'c_1', cmd: 'STATUS', params: {}, v: PROTOCOL_VERSION, agent: 'claude' });
  });

  it('BACKWARD-COMPAT: an unset agent is byte-identical to the pre-agent wire', () => {
    const frame = makeRequestFrame('c_1', 'STATUS', {});
    expect('agent' in frame).toBe(false);
    expect(JSON.stringify(frame)).toBe(JSON.stringify({ id: 'c_1', cmd: 'STATUS', params: {}, v: PROTOCOL_VERSION }));
  });

  it('treats a blank agent as unset — never ships an empty label to the panel', () => {
    expect('agent' in makeRequestFrame('c_1', 'STATUS', {}, undefined, undefined, undefined, undefined, undefined, '   ')).toBe(false);
  });

  it('composes with every other optional field already on the envelope', () => {
    const frame = makeRequestFrame('c_1', 'EXEC_JS', { code: '1' }, 'Scan · 1:23', 'My File', '/proj', true, 'p_1', 'claude');
    expect(frame).toEqual({
      id: 'c_1', cmd: 'EXEC_JS', params: { code: '1' }, v: PROTOCOL_VERSION,
      activity: 'Scan · 1:23', expectedFile: 'My File', projectDir: '/proj', readOnly: true,
      expectedInstance: 'p_1', agent: 'claude',
    });
  });
});

describe('resolveAgent — CLI boundary guards (--agent / FIGMA_AGENT_ID)', () => {
  const originalEnv = process.env.FIGMA_AGENT_ID;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.FIGMA_AGENT_ID;
    else process.env.FIGMA_AGENT_ID = originalEnv;
  });

  it('unset flag, unset env → undefined', () => {
    delete process.env.FIGMA_AGENT_ID;
    expect(resolveAgent(fakeArgs())).toBeUndefined();
  });

  it('the --agent flag wins over FIGMA_AGENT_ID', () => {
    process.env.FIGMA_AGENT_ID = 'from-env';
    expect(resolveAgent(fakeArgs({ agent: 'from-flag' }))).toBe('from-flag');
  });

  it('falls back to FIGMA_AGENT_ID when no flag is given', () => {
    process.env.FIGMA_AGENT_ID = 'from-env';
    expect(resolveAgent(fakeArgs())).toBe('from-env');
  });

  it('trims whitespace before validating', () => {
    delete process.env.FIGMA_AGENT_ID;
    expect(resolveAgent(fakeArgs({ agent: '  claude  ' }))).toBe('claude');
  });

  it('accepts the full allowlist: lowercase letters, digits, dot, underscore, hyphen', () => {
    delete process.env.FIGMA_AGENT_ID;
    expect(resolveAgent(fakeArgs({ agent: 'claude-code_v2.1' }))).toBe('claude-code_v2.1');
  });

  it('accepts exactly 32 characters, the allowlist\'s own cap', () => {
    delete process.env.FIGMA_AGENT_ID;
    const exact32 = 'a'.repeat(32);
    expect(resolveAgent(fakeArgs({ agent: exact32 }))).toBe(exact32);
  });
});

describe('--agent — subprocess, against the BUILT cli/dist bundle', () => {
  beforeAll(() => {
    execFileSync(process.execPath, ['scripts/build.mjs', 'cli'], { cwd: ROOT });
  });

  function runAgent(agentValue: string | null): { status: number | null; stdout: string } {
    const args = ['status', '--peek'];
    if (agentValue !== null) args.push('--agent', agentValue);
    else args.push('--agent'); // bare flag, no value
    try {
      const out = execFileSync(process.execPath, [CLI_DIST, ...args], { cwd: ROOT, encoding: 'utf8' });
      return { status: 0, stdout: out };
    } catch (err) {
      const e = err as { status: number | null; stdout: string };
      return { status: e.status, stdout: e.stdout };
    }
  }

  it('a bare --agent with no value refuses with E_INVALID_ARGS, exit non-zero', () => {
    const result = runAgent(null);
    expect(result.status).not.toBe(0);
    const parsed = JSON.parse(result.stdout || '{}') as { error?: { code?: string } };
    expect(parsed.error?.code).toBe('E_INVALID_ARGS');
  });

  it('a value with 33 characters (over the allowlist cap) refuses with E_INVALID_ARGS', () => {
    const result = runAgent('a'.repeat(33));
    expect(result.status).not.toBe(0);
    const parsed = JSON.parse(result.stdout || '{}') as { error?: { code?: string; message?: string } };
    expect(parsed.error?.code).toBe('E_INVALID_ARGS');
    expect(parsed.error?.message).toContain('--agent');
  });

  it('uppercase, spaces, and control/bidi characters are all rejected, never silently sanitized', () => {
    // Built via String.fromCharCode/fromCodePoint, never as literal source characters —
    // this source file must never carry a raw control/bidi byte itself.
    const bell = String.fromCharCode(7); // BEL, 0x07
    const rlo = String.fromCodePoint(0x202e); // Right-to-Left Override
    const zwsp = String.fromCodePoint(0x200b); // Zero Width Space
    const cases = ['Claude', 'claude code', `claude${bell}bell`, `claude${rlo}evil`, `cla${zwsp}ude`];
    for (const bad of cases) {
      const result = runAgent(bad);
      expect(result.status, `expected refusal for ${JSON.stringify(bad)}`).not.toBe(0);
      const parsed = JSON.parse(result.stdout || '{}') as { error?: { code?: string } };
      expect(parsed.error?.code, `expected E_INVALID_ARGS for ${JSON.stringify(bad)}`).toBe('E_INVALID_ARGS');
    }
  });

  it('a well-formed --agent value is accepted end to end (status --peek still exits 0)', () => {
    const result = runAgent('claude-code_v2.1');
    expect(result.status).toBe(0);
  });
});
