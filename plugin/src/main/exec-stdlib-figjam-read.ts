// `ui.figjam.board` / `ui.figjam.connections` — read-only helpers (absorption
// phase-03). Adapted from the fork's board-walk/connections handlers (MIT; see
// THIRD-PARTY.md), code.js:6361-6501.
import { requireEditor } from './exec-stdlib-editor';
import { figmaColorToHex } from './executor-styles';
import { MAX_BOARD_READ_NODES, MAX_CONNECTORS_READ, type BoardOpts } from './exec-stdlib-figjam-types';

const TABLE_READ_ROW_CAP = 10;

/** Absorbed fact 13 — the FigJam node types the read path recognises, plus FRAME/TEXT
 *  which exist in both editors (figjam-tools.ts:36-45). */
const FIGJAM_READABLE_TYPES = new Set([
  'STICKY', 'SHAPE_WITH_TEXT', 'CONNECTOR', 'CODE_BLOCK', 'TABLE', 'SECTION', 'FRAME', 'TEXT',
]);

function firstSolidFillHex(fills: unknown): string | null {
  if (!Array.isArray(fills) || fills.length === 0) return null;
  const solid = fills.find((f: { type?: string }) => f?.type === 'SOLID');
  if (!solid) return null;
  return figmaColorToHex((solid as { color: { r: number; g: number; b: number } }).color as never);
}

function extractBoardNode(node: SceneNode): Record<string, unknown> {
  const base = { id: node.id, name: node.name, type: node.type };
  switch (node.type) {
    case 'STICKY': {
      const sticky = node as StickyNode;
      return { ...base, text: sticky.text.characters, color: firstSolidFillHex(sticky.fills) };
    }
    case 'SHAPE_WITH_TEXT': {
      const shapeNode = node as ShapeWithTextNode;
      return { ...base, text: shapeNode.text.characters, shapeType: shapeNode.shapeType };
    }
    case 'CONNECTOR': {
      const conn = node as ConnectorNode;
      return {
        ...base,
        label: conn.text.characters || null,
        start: 'endpointNodeId' in conn.connectorStart ? conn.connectorStart.endpointNodeId : null,
        end: 'endpointNodeId' in conn.connectorEnd ? conn.connectorEnd.endpointNodeId : null,
      };
    }
    case 'CODE_BLOCK': {
      const code = node as CodeBlockNode;
      return { ...base, code: code.code, language: code.codeLanguage };
    }
    case 'TABLE': {
      const tableNode = node as TableNode;
      const rowCap = Math.min(TABLE_READ_ROW_CAP, tableNode.numRows);
      const data: string[][] = [];
      for (let r = 0; r < rowCap; r++) {
        const row: string[] = [];
        for (let c = 0; c < tableNode.numColumns; c++) row.push(tableNode.cellAt(r, c).text.characters);
        data.push(row);
      }
      return {
        ...base, rows: tableNode.numRows, columns: tableNode.numColumns, data,
        cellDataTruncated: tableNode.numRows > TABLE_READ_ROW_CAP,
      };
    }
    case 'SECTION': {
      const sectionNode = node as SectionNode;
      return { ...base, childCount: sectionNode.children.length };
    }
    case 'TEXT': {
      const text = node as TextNode;
      return { ...base, text: text.characters };
    }
    default:
      return base;
  }
}

export async function board(opts: BoardOpts = {}): Promise<{
  nodes: Record<string, unknown>[]; totalFound: number; truncated: boolean; page: string; scope: 'page-top-level';
}> {
  requireEditor('ui.figjam.board', ['figjam']);
  const maxNodes = opts.maxNodes ?? MAX_BOARD_READ_NODES;
  // Absorbed fact 10: TOP-LEVEL children only — never a deep findAll. Named in the
  // reply (`scope`) so a caller cannot mistake this for a full board dump.
  const topLevel = figma.currentPage.children;
  const matching = opts.nodeTypes
    ? topLevel.filter((c) => opts.nodeTypes!.includes(c.type))
    : topLevel.filter((c) => FIGJAM_READABLE_TYPES.has(c.type));
  // Absorbed fact 10 (their bug, fixed): `truncated` computed from whether the SOURCE
  // list was exhausted, not `results.length >= maxNodes` — the latter is wrong when
  // the board has EXACTLY maxNodes matching nodes.
  const truncated = matching.length > maxNodes;
  const nodes = matching.slice(0, maxNodes).map(extractBoardNode);
  return { nodes, totalFound: matching.length, truncated, page: figma.currentPage.name, scope: 'page-top-level' };
}

interface EndpointResult { nodeId: string | null; unresolved: boolean; position: { x: number; y: number } | null }

/** `resolveEndpoint`'s internal result — carries the already-fetched node alongside
 * the serializable `EndpointResult` so the caller below can reuse it instead of
 * calling `getNodeByIdAsync` a second time for the same id. Never returned as-is
 * from `connections()` (see `toEndpointResult`) — a live Figma node isn't
 * serializable across the plugin/UI boundary anyway. */
interface ResolvedEndpoint extends EndpointResult { node: BaseNode | null }

function toEndpointResult(ep: ResolvedEndpoint): EndpointResult {
  return { nodeId: ep.nodeId, unresolved: ep.unresolved, position: ep.position };
}

async function resolveEndpoint(ep: ConnectorEndpoint): Promise<ResolvedEndpoint> {
  if (!('endpointNodeId' in ep)) {
    return { nodeId: null, unresolved: false, position: 'position' in ep ? ep.position : null, node: null };
  }
  const node = await figma.getNodeByIdAsync(ep.endpointNodeId);
  // Absorbed fact 11: an endpoint whose node cannot be resolved appears as
  // `unresolved: true`, never dropped — a dropped edge silently changes the graph.
  return { nodeId: ep.endpointNodeId, unresolved: !node, position: null, node };
}

export async function connections(): Promise<{
  edges: { id: string; label: string | null; start: EndpointResult; end: EndpointResult }[];
  connectedNodes: Record<string, { id: string; type: string; name: string; text: string | null }>;
  totalConnectors: number; totalConnectedNodes: number; truncated: boolean;
}> {
  requireEditor('ui.figjam.connections', ['figjam']);
  // Absorbed fact 11: findAll(type === 'CONNECTOR') — connectors can nest, unlike
  // board()'s top-level-only read, so the deep walk stays. Only the RESULT is
  // capped (same truncated-flag pattern as board()'s MAX_BOARD_READ_NODES) so a
  // page with an unbounded number of connectors can't force an unbounded async
  // fetch loop below; nothing past the cap is silently merged into what IS read.
  const allConnectors = figma.currentPage.findAll((n) => n.type === 'CONNECTOR') as ConnectorNode[];
  const truncated = allConnectors.length > MAX_CONNECTORS_READ;
  const connectors = allConnectors.slice(0, MAX_CONNECTORS_READ);
  const connectedNodes: Record<string, { id: string; type: string; name: string; text: string | null }> = {};
  const edges: { id: string; label: string | null; start: EndpointResult; end: EndpointResult }[] = [];

  for (const conn of connectors) {
    const start = await resolveEndpoint(conn.connectorStart);
    const end = await resolveEndpoint(conn.connectorEnd);
    edges.push({ id: conn.id, label: conn.text.characters || null, start: toEndpointResult(start), end: toEndpointResult(end) });
    // Reuse the node `resolveEndpoint` already fetched above — the loop used to
    // call `getNodeByIdAsync` a second time for the same id here (4 fetches per
    // connector where 2 suffice).
    for (const ep of [start, end]) {
      if (!ep.nodeId || ep.unresolved || connectedNodes[ep.nodeId]) continue;
      const node = ep.node;
      if (!node) continue;
      const asText = 'characters' in node ? (node as { characters?: unknown }).characters : undefined;
      connectedNodes[ep.nodeId] = {
        id: node.id, type: node.type, name: (node as { name?: string }).name ?? node.id,
        text: typeof asText === 'string' ? asText : null,
      };
    }
  }
  return {
    edges, connectedNodes, totalConnectors: allConnectors.length,
    totalConnectedNodes: Object.keys(connectedNodes).length, truncated,
  };
}
