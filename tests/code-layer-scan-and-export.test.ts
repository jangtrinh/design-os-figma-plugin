// A Figma code layer (a live React/HTML layer on the Design canvas) reaches the plugin as
// node.type "CODE_INSTANCE". Two honest-reporting gaps, both measured on a live layer:
//   - the scan mapped it to FRAME with nothing saying so, so an agent read "frame" and
//     planned children, fills or a rebuild that a code layer cannot take;
//   - exportAsync renders its static shell (a flat background), never the running code,
//     so inspect's required visual check looked at an empty image as if it were real.
// The mock node encodes the live facts: no fills, and an export that is just bytes.
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeAll, describe, expect, it } from 'vitest';
import { installMockFigma, type FakeNode } from './helpers/mock-figma.ts';
import { inspectTarget } from '../cli/src/commands/inspect';

beforeAll(() => { installMockFigma(); });

const { nodeToSpec } = await import('../plugin/src/main/scan-node.ts');
const { opExportPng } = await import('../plugin/src/main/executor-ops.ts');

function codeLayer(): FakeNode {
  const node = figma.createFrame() as unknown as FakeNode;
  node.type = 'CODE_INSTANCE';
  node.name = 'Code';
  node.width = 1512;
  node.height = 982;
  node.exportAsync = async () => new Uint8Array([137, 80, 78, 71]);
  return node;
}

describe('scan of a node type the payload schema cannot model', () => {
  it('keeps the raw type of a code layer visible', () => {
    const spec = nodeToSpec(codeLayer() as unknown as SceneNode) as Record<string, unknown>;
    expect(spec.figmaScanSourceType).toBe('CODE_INSTANCE');
  });

  it('keeps the raw type of any other unmodelled type visible', () => {
    const node = figma.createFrame() as unknown as FakeNode;
    node.type = 'BOOLEAN_OPERATION';
    const spec = nodeToSpec(node as unknown as SceneNode) as Record<string, unknown>;
    expect(spec.figmaScanSourceType).toBe('BOOLEAN_OPERATION');
  });

  it('adds nothing for types the schema models', () => {
    for (const type of ['FRAME', 'SECTION', 'GROUP', 'RECTANGLE', 'ELLIPSE']) {
      const node = figma.createFrame() as unknown as FakeNode;
      node.type = type;
      const spec = nodeToSpec(node as unknown as SceneNode) as Record<string, unknown>;
      expect(spec.figmaScanSourceType, type).toBeUndefined();
    }
  });
});

describe('PNG export of a code layer', () => {
  it('says the image is the static shell, not the running code', async () => {
    (figma as unknown as { base64Encode: (b: Uint8Array) => string }).base64Encode =
      (bytes) => Buffer.from(bytes).toString('base64');
    const node = codeLayer();
    const reply = await opExportPng({ nodeId: node.id, scale: 1 }) as Record<string, unknown>;
    expect(reply.staticRender).toMatchObject({ nodeType: 'CODE_INSTANCE' });
  });

  it('says so when the exported frame contains a visible code layer', async () => {
    const parent = figma.createFrame() as unknown as FakeNode;
    parent.width = 1600; parent.height = 1000;
    parent.exportAsync = async () => new Uint8Array([1]);
    parent.appendChild(codeLayer());
    const reply = await opExportPng({ nodeId: parent.id, scale: 1 }) as { staticRender?: { nodeType: string; reason: string } };
    expect(reply.staticRender?.nodeType).toBe('CODE_INSTANCE');
    expect(reply.staticRender?.reason).toMatch(/contains/i);
  });

  it('ignores a hidden code layer inside the frame (it is not in the image)', async () => {
    const parent = figma.createFrame() as unknown as FakeNode;
    parent.exportAsync = async () => new Uint8Array([1]);
    const hidden = codeLayer();
    hidden.visible = false;
    parent.appendChild(hidden);
    const reply = await opExportPng({ nodeId: parent.id, scale: 1 }) as Record<string, unknown>;
    expect(reply.staticRender).toBeUndefined();
  });

  it('adds no note for an ordinary frame', async () => {
    const node = figma.createFrame() as unknown as FakeNode;
    node.width = 10; node.height = 10;
    node.exportAsync = async () => new Uint8Array([1]);
    const reply = await opExportPng({ nodeId: node.id, scale: 1 }) as Record<string, unknown>;
    expect(reply.staticRender).toBeUndefined();
  });
});

describe('inspect of a code layer', () => {
  const png = { base64: Buffer.from('png').toString('base64'), w: 1512, h: 982 };
  const scanned = { result: { type: 'FRAME', name: 'Code', figmaScanSourceType: 'CODE_INSTANCE' }, console: [], ms: 1 };

  it('marks the screenshot unreliable when the plugin flags a static render', async () => {
    const runner = async (cmd: string): Promise<unknown> => {
      if (cmd === 'EXEC_JS') return scanned;
      if (cmd === 'EXPORT_PNG') return { ...png, staticRender: { nodeType: 'CODE_INSTANCE', reason: 'static shell' } };
      throw new Error(`unexpected ${cmd}`);
    };
    const result = await inspectTarget({ explicit: '1:2', out: join(tmpdir(), `inspect-code-${Date.now()}.png`) }, runner) as {
      visualArtifact: { reliable?: boolean; reason?: string };
    };
    expect(result.visualArtifact.reliable).toBe(false);
    expect(result.visualArtifact.reason).toMatch(/static shell/);
    // A caller that reads only the contract must not be told this PNG is the check.
    expect((result.visualArtifact as { contract?: string }).contract).not.toMatch(/inspect this screenshot/);
  });

  it('still marks it unreliable when an older plugin sends no flag', async () => {
    const runner = async (cmd: string): Promise<unknown> => {
      if (cmd === 'EXEC_JS') return scanned;
      if (cmd === 'EXPORT_PNG') return png;
      throw new Error(`unexpected ${cmd}`);
    };
    const result = await inspectTarget({ explicit: '1:2', out: join(tmpdir(), `inspect-code-old-${Date.now()}.png`) }, runner) as {
      visualArtifact: { reliable?: boolean; reason?: string };
    };
    expect(result.visualArtifact.reliable).toBe(false);
    expect(result.visualArtifact.reason).toMatch(/window/i);
  });
});
