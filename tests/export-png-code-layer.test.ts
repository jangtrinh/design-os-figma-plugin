// `figma-agent export-png` on a code layer: the plugin's reply carries `staticRender`
// (the PNG is the layer's static shell, not its running code) and the CLI must pass that
// on, so a caller never treats the file as a render of what the canvas shows.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../cli/src/transport/broker-discovery.ts', () => ({
  ensureBroker: vi.fn(async () => { throw new Error('refusing to reach a real broker from a test'); }),
}));
vi.mock('../cli/src/transport/broker-client.ts', () => ({ runCommand: vi.fn() }));

import { parseArgs } from '../cli/src/arg-parse.ts';
import { run } from '../cli/src/commands/export-png.ts';
import { runCommand } from '../cli/src/transport/broker-client.ts';

const out = join(mkdtempSync(join(tmpdir(), 'figma-agent-export-code-layer-')), 'shot.png');
const PNG = { base64: Buffer.from('png-bytes').toString('base64'), w: 10, h: 20 };

beforeEach(() => { vi.mocked(runCommand).mockReset(); });

describe('export-png of a code layer', () => {
  it('reports the PNG as unreliable with the plugin\'s reason', async () => {
    vi.mocked(runCommand).mockResolvedValue({ ...PNG, staticRender: { nodeType: 'CODE_INSTANCE', reason: 'static shell only' } });
    const result = await run(parseArgs(['--node', '1:2', '--out', out])) as Record<string, unknown>;
    expect(result).toMatchObject({ path: out, reliable: false, reason: 'static shell only' });
  });

  it('adds nothing for an ordinary node', async () => {
    vi.mocked(runCommand).mockResolvedValue(PNG);
    const result = await run(parseArgs(['--node', '1:2', '--out', out])) as Record<string, unknown>;
    expect(result.reliable).toBeUndefined();
    expect(result.reason).toBeUndefined();
  });
});
