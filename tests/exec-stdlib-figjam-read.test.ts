// `ui.figjam.board` / `ui.figjam.connections` (absorption phase-03). Covers: the
// corrected `truncated` computation (exhausted-source, not results.length>=maxNodes)
// and the unresolved-edge labelling.
import { describe, it, expect, vi } from 'vitest';
import { installMockFigma, setMockEditorType, type FakeNode } from './helpers/mock-figma.ts';
import { board, connections } from '../plugin/src/main/exec-stdlib-figjam-read.ts';
import { MAX_CONNECTORS_READ } from '../plugin/src/main/exec-stdlib-figjam-types.ts';

function asFigma(): {
  createSticky(): FakeNode; createFrame(): FakeNode; createConnector(): FakeNode;
  currentPage: FakeNode;
} {
  return (globalThis as unknown as {
    figma: { createSticky(): FakeNode; createFrame(): FakeNode; createConnector(): FakeNode; currentPage: FakeNode };
  }).figma;
}

describe('ui.figjam.board', () => {
  it('refuses outside FigJam', async () => {
    installMockFigma();
    setMockEditorType('figma');
    await expect(board()).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
  });

  it('reports scope: page-top-level and reads real STICKY text/type back', async () => {
    installMockFigma();
    setMockEditorType('figjam');
    const figma = asFigma();
    const s = figma.createSticky();
    s.text.characters = 'Note one';
    const result = await board();
    expect(result.scope).toBe('page-top-level');
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]).toMatchObject({ type: 'STICKY', text: 'Note one' });
  });

  it('never walks past top-level children — a sticky nested inside a frame is invisible', async () => {
    installMockFigma();
    setMockEditorType('figjam');
    const figma = asFigma();
    const frame = figma.createFrame();
    const nestedSticky = figma.createSticky();
    frame.appendChild(nestedSticky); // moves it OFF the page's own top level
    figma.currentPage.children = figma.currentPage.children.filter((c) => c.id !== nestedSticky.id);
    const result = await board({ nodeTypes: ['STICKY'] });
    expect(result.nodes).toHaveLength(0);
  });

  it('truncated computed from whether the SOURCE list was exhausted — false when the board has EXACTLY maxNodes', async () => {
    installMockFigma();
    setMockEditorType('figjam');
    const figma = asFigma();
    figma.createSticky();
    figma.createSticky();
    const result = await board({ maxNodes: 2 });
    expect(result.totalFound).toBe(2);
    expect(result.truncated).toBe(false); // NOT the fork's `results.length >= maxNodes` bug
  });

  it('truncated is true only when the source list genuinely exceeds maxNodes', async () => {
    installMockFigma();
    setMockEditorType('figjam');
    const figma = asFigma();
    figma.createSticky();
    figma.createSticky();
    figma.createSticky();
    const result = await board({ maxNodes: 2 });
    expect(result.totalFound).toBe(3);
    expect(result.truncated).toBe(true);
    expect(result.nodes).toHaveLength(2);
  });
});

describe('ui.figjam.connections', () => {
  it('refuses outside FigJam', async () => {
    installMockFigma();
    setMockEditorType('figma');
    await expect(connections()).rejects.toMatchObject({ code: 'E_INVALID_ARGS' });
  });

  it('reports an edge with its label and both connected nodes', async () => {
    installMockFigma();
    setMockEditorType('figjam');
    const figma = asFigma();
    const a = figma.createFrame();
    const b = figma.createFrame();
    const conn = figma.createConnector();
    conn.connectorStart = { endpointNodeId: a.id, magnet: 'AUTO' };
    conn.connectorEnd = { endpointNodeId: b.id, magnet: 'AUTO' };
    conn.text.characters = 'flows to';
    const result = await connections();
    expect(result.totalConnectors).toBe(1);
    expect(result.edges[0]).toMatchObject({ label: 'flows to' });
    expect(result.totalConnectedNodes).toBe(2);
  });

  it('an unresolvable endpoint appears as unresolved, never silently dropped', async () => {
    installMockFigma();
    setMockEditorType('figjam');
    const figma = asFigma();
    const a = figma.createFrame();
    const conn = figma.createConnector();
    conn.connectorStart = { endpointNodeId: a.id, magnet: 'AUTO' };
    conn.connectorEnd = { endpointNodeId: 'nonexistent-node', magnet: 'AUTO' };
    const result = await connections();
    expect(result.edges).toHaveLength(1); // the edge itself is never dropped
    expect(result.edges[0]!.end).toMatchObject({ nodeId: 'nonexistent-node', unresolved: true });
    expect(result.totalConnectedNodes).toBe(1); // only the resolvable end counted
  });

  it('resolves each endpoint node exactly once — the loop reuses resolveEndpoint\'s fetch instead of re-fetching by id', async () => {
    installMockFigma();
    setMockEditorType('figjam');
    const figma = asFigma();
    const a = figma.createFrame();
    const b = figma.createFrame();
    const conn = figma.createConnector();
    conn.connectorStart = { endpointNodeId: a.id, magnet: 'AUTO' };
    conn.connectorEnd = { endpointNodeId: b.id, magnet: 'AUTO' };
    conn.text.characters = 'flows to';
    const mockFigma = (globalThis as unknown as { figma: { getNodeByIdAsync(id: string): Promise<unknown> } }).figma;
    const spy = vi.spyOn(mockFigma, 'getNodeByIdAsync');
    const result = await connections();
    // Output shape is unchanged from the pre-dedupe behavior.
    expect(result.edges[0]).toMatchObject({ label: 'flows to' });
    expect(result.totalConnectedNodes).toBe(2);
    // The perf assertion: one fetch per endpoint (2 total for this connector), not
    // the pre-fix 4 (resolveEndpoint's own fetch, then a second re-fetch per endpoint
    // in the loop below it).
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('caps the number of connectors processed and reports truncated: true when the page exceeds the cap', async () => {
    installMockFigma();
    setMockEditorType('figjam');
    const figma = asFigma();
    for (let i = 0; i < MAX_CONNECTORS_READ + 1; i++) figma.createConnector();
    const result = await connections();
    expect(result.totalConnectors).toBe(MAX_CONNECTORS_READ + 1);
    expect(result.edges).toHaveLength(MAX_CONNECTORS_READ);
    expect(result.truncated).toBe(true);
  });

  it('truncated is falsy when the page is at or under the cap — no edge is silently dropped', async () => {
    installMockFigma();
    setMockEditorType('figjam');
    const figma = asFigma();
    figma.createConnector();
    figma.createConnector();
    figma.createConnector();
    const result = await connections();
    expect(result.totalConnectors).toBe(3);
    expect(result.edges).toHaveLength(3);
    expect(result.truncated).toBeFalsy();
  });
});
