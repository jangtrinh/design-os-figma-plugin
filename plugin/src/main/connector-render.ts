// Draws a connector on the canvas from a route. Everything geometric was decided in
// shared/connector-*.ts; this file only talks to Figma.
//
// Two measured facts drive the shape here:
//   - The sync `vectorNetwork` setter throws under documentAccess "dynamic-page"; only
//     `setVectorNetworkAsync` writes. A later `vectorPaths` write would wipe the per-vertex
//     caps that carry the arrowhead, so this file never touches `vectorPaths`.
//   - A vector auto-resizes to its network's bounding box but does NOT move, so x/y has to
//     be set from the network's absolute origin or the line lands wherever the node was.

import { pointsToVectorNetwork } from '../../../shared/connector-geometry';
import type { ConnectorIntent, Point, VectorNetworkSpec } from '../../../shared/connector-types';
import { loadBestFont } from './executor-fonts';
import { stampNodeConnectionId } from './connector-store';

const LABEL_SIZE = 11;
const STROKE: Paint = { type: 'SOLID', color: { r: 0.42, g: 0.42, b: 0.45 } };
const LABEL_FILL: Paint = { type: 'SOLID', color: { r: 0.42, g: 0.42, b: 0.45 } };

/** The page a node lives on. Connectors are parented here, never inside a frame. */
export function pageOf(node: BaseNode): PageNode | null {
  let current: BaseNode | null = node;
  while (current) {
    if (current.type === 'PAGE') return current;
    current = current.parent;
  }
  return null;
}

/** Where a label reads best: the middle of the polyline's longest straight run. */
function labelAnchor(points: readonly Point[]): Point {
  let best = 0;
  let bestLength = -1;
  for (let i = 1; i < points.length; i += 1) {
    const length = Math.abs(points[i].x - points[i - 1].x) + Math.abs(points[i].y - points[i - 1].y);
    if (length > bestLength) { bestLength = length; best = i; }
  }
  return {
    x: (points[best].x + points[best - 1].x) / 2,
    y: (points[best].y + points[best - 1].y) / 2,
  };
}

async function applyNetwork(vector: VectorNode, network: VectorNetworkSpec): Promise<void> {
  await vector.setVectorNetworkAsync({
    vertices: network.vertices.map((v) => ({ x: v.x, y: v.y, strokeCap: v.strokeCap })),
    segments: network.segments.map((s) => ({ start: s.start, end: s.end })),
  } as VectorNetwork);
  // A freshly created vector carries a default stroke; say what we mean rather than
  // inheriting whatever that default happens to be.
  vector.strokes = [STROKE];
  vector.strokeWeight = 1.5;
  vector.x = network.origin.x;
  vector.y = network.origin.y;
}

export interface RenderInput {
  connectionId: string;
  page: PageNode;
  points: Point[];
  intent: ConnectorIntent;
  label: string | null;
  /** Reuse these nodes when they still exist — a redraw must not orphan the old line. */
  existingVector: VectorNode | null;
  existingLabel: TextNode | null;
}

export interface RenderResult { vectorNodeId: string; labelNodeId: string | null }

/**
 * Draw (or redraw) one connector. A flow edge is directed and gets an arrowhead; an
 * annotation pointer points at something and gets one too — what differs is the route,
 * decided upstream, not the head.
 */
export async function renderConnector(input: RenderInput): Promise<RenderResult> {
  const network = pointsToVectorNetwork(input.points, { arrowAtEnd: true });

  const vector = input.existingVector ?? figma.createVector();
  if (!input.existingVector) input.page.appendChild(vector);
  vector.name = input.intent === 'flow' ? 'Flow connector' : 'Annotation pointer';
  await applyNetwork(vector, network);
  stampNodeConnectionId(vector, input.connectionId);

  let labelNodeId: string | null = null;
  if (input.label) {
    const font = await loadBestFont('Inter', 400);
    const text = input.existingLabel ?? figma.createText();
    if (!input.existingLabel) input.page.appendChild(text);
    text.fontName = font;
    text.fontSize = LABEL_SIZE;
    text.characters = input.label;
    text.fills = [LABEL_FILL];
    text.textAutoResize = 'WIDTH_AND_HEIGHT';
    text.name = `${input.label} — connector label`;
    const anchor = labelAnchor(input.points);
    text.x = Math.round(anchor.x - text.width / 2);
    text.y = Math.round(anchor.y - text.height - 4);
    stampNodeConnectionId(text, input.connectionId);
    labelNodeId = text.id;
  } else if (input.existingLabel) {
    // The label was removed from the record; leaving the old text behind would be a stray
    // caption no reader could trace back to anything.
    input.existingLabel.remove();
  }

  return { vectorNodeId: vector.id, labelNodeId };
}
