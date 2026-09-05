import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnReconcileApply, type SyncApplyResult } from '../cli/src/transport/figma-sync-apply.ts';

const capture = vi.hoisted(() => vi.fn());
vi.mock('../cli/src/transport/figma-mirror-capture-run.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../cli/src/transport/figma-mirror-capture-run.ts')>()),
  captureMirror: capture,
}));
let scratch: string;

function kernel(folder: string, name = 'ui', malformed = false): string {
  const directory = join(scratch, folder);
  mkdirSync(directory, { recursive: true });
  const file = join(directory, name);
  writeFileSync(file, `#!${process.execPath}\nconst fs=require('node:fs');
    fs.appendFileSync(${JSON.stringify(join(scratch, 'invocations.jsonl'))},JSON.stringify({file:__filename,dry:process.argv.includes('--dry-run')})+'\\n');
    console.log(${malformed ? "'invalid JSON'" : "JSON.stringify({ok:true,data:{delta:{added:[],updated:[]},pending:[],apply:{added:[],updated:[],deprecated:[],mirrored:[],pending:[],skipped:[],mirrorSkipped:[]}}})"});\n`);
  chmodSync(file, 0o755);
  return file;
}

function run(): Promise<SyncApplyResult> {
  return new Promise((resolve) => spawnReconcileApply(scratch, undefined, undefined, resolve));
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'reconcile-executable-'));
  vi.stubEnv('FIGMA_AGENT_UI_BIN', undefined);
  vi.stubEnv('DESIGN_OS_UI_BIN', undefined);
  capture.mockReset().mockResolvedValue({ captured: 0, failed: 0, dropped: 0, droppedTargets: [] });
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(scratch, { recursive: true, force: true }); });

describe.skipIf(process.platform === 'win32')('reconcile executable evidence on POSIX', () => {
  it('records the first executable on PATH and keeps it when PATH changes before apply', async () => {
    const selected = kernel('local-bin');
    const alternative = kernel('global-bin');
    vi.stubEnv('PATH', `${join(scratch, 'local-bin')}:${join(scratch, 'global-bin')}`);
    capture.mockImplementation(async () => {
      process.env.PATH = join(scratch, 'global-bin');
      process.env.FIGMA_AGENT_UI_BIN = alternative;
      return { captured: 0, failed: 0, dropped: 0, droppedTargets: [] };
    });
    const result = await run();
    expect(result.ok).toBe(true);
    const invocations = readFileSync(join(scratch, 'invocations.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(invocations).toEqual([{ file: realpathSync(selected), dry: true }, { file: realpathSync(selected), dry: false }]);
    expect(result.evidence).toMatchObject({ uiCommand: 'ui', uiExecutable: selected });
  });

  it.each(['relative', 'absolute'])('honors the primary %s override ahead of legacy override and PATH', async (kind) => {
    const selected = kernel('chosen', 'ui with spaces');
    kernel('other');
    const requested = kind === 'relative' ? './chosen/ui with spaces' : selected;
    vi.stubEnv('FIGMA_AGENT_UI_BIN', requested);
    vi.stubEnv('DESIGN_OS_UI_BIN', join(scratch, 'other', 'ui'));
    vi.stubEnv('PATH', join(scratch, 'other'));
    const result = await run();
    expect(result.ok).toBe(true);
    expect(result.evidence).toMatchObject({ uiCommand: requested, uiExecutable: selected });
  });

  it('records a legacy override and reports incomplete preview without starting apply', async () => {
    const selected = kernel('legacy', 'ui', true);
    vi.stubEnv('DESIGN_OS_UI_BIN', selected);
    const result = await run();
    expect(result.ok).toBe(false);
    expect(result.evidence).toMatchObject({ phase: 'dry', envelopeParsed: false, uiExecutable: selected });
    expect(capture).not.toHaveBeenCalled();
    expect(readFileSync(join(scratch, 'invocations.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('records an explicit missing path as the attempted executable without claiming successful start', async () => {
    const selected = join(scratch, 'missing', 'ui');
    vi.stubEnv('FIGMA_AGENT_UI_BIN', selected);
    const result = await run();
    expect(result.ok).toBe(false);
    expect(result.evidence).toMatchObject({ uiCommand: selected, uiExecutable: selected, exitCode: null, envelopeParsed: false });
    expect(capture).not.toHaveBeenCalled();
  });

  it('does not invent a resolved identity for a missing bare command', async () => {
    vi.stubEnv('PATH', scratch);
    const result = await run();
    expect(result.ok).toBe(false);
    expect(result.evidence).toMatchObject({ uiCommand: 'ui', uiExecutable: null, envelopeParsed: false });
    expect(capture).not.toHaveBeenCalled();
  });
});
