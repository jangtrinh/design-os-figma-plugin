import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../cli/src/arg-parse.ts';

vi.mock('../cli/src/transport/broker-client.ts', () => ({
  runCommand: vi.fn(async () => ({ fileKey: 'OwnedKey', migratedCount: 0, migratedEditCount: 0 })),
}));
import { run } from '../cli/src/commands/bind.ts';

let dir: string;
let project: string;
const previous = process.env['FIGMA_AGENT_BINDS_FILE'];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fa-bind-cache-command-'));
  project = join(dir, 'project');
  mkdirSync(project);
  process.env['FIGMA_AGENT_BINDS_FILE'] = join(dir, 'binds.json');
});
afterEach(() => {
  vi.restoreAllMocks();
  if (previous === undefined) delete process.env['FIGMA_AGENT_BINDS_FILE'];
  else process.env['FIGMA_AGENT_BINDS_FILE'] = previous;
  rmSync(dir, { recursive: true, force: true });
});

it('returns an honest cache warning while retaining the successful durable binding', async () => {
  const cache = process.env['FIGMA_AGENT_BINDS_FILE']!;
  writeFileSync(`${cache}.${process.pid}.tmp`, 'COLLISION');
  const stdout = vi.spyOn(process.stdout, 'write');
  const result = await run(parseArgs(['--file', 'Owned file', '--dir', project]));
  expect(result).toMatchObject({ fileKey: 'OwnedKey', pendingKey: false,
    warnings: [{ code: 'E_BIND_CACHE_WRITE', cause: 'EEXIST' }] });
  expect(JSON.parse(readFileSync(join(project, 'design', 'figma-bind.json'), 'utf8')).bindings)
    .toEqual([expect.objectContaining({ fileKey: 'OwnedKey' })]);
  expect(readFileSync(`${cache}.${process.pid}.tmp`, 'utf8')).toBe('COLLISION');
  expect(stdout).not.toHaveBeenCalled();
});

it('keeps the existing successful command shape without a warning', async () => {
  const result = await run(parseArgs(['--file', 'Owned file', '--dir', project]));
  expect(result).toMatchObject({ fileKey: 'OwnedKey', pendingKey: false });
  expect(result).not.toHaveProperty('warnings');
});
