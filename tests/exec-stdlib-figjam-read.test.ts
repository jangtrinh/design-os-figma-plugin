// `ui.figjam.board` / `ui.figjam.connections` (absorption phase-03). Covers: the
// corrected `truncated` computation (exhausted-source, not results.length>=maxNodes)
// and the unresolved-edge labelling.
import { describe, it, expect } from 'vitest';
import { installMockFigma, setMockEditorType, type FakeNode } from './helpers/mock-figma.ts';
import { board, connections } from '../plugin/src/main/exec-stdlib-figjam-read.ts';

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
});
