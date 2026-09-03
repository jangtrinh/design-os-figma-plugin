// Keeps drawn connectors true after the canvas moves under them.
//
// A native FigJam connector has Figma itself holding the endpoint binding. In a Design file
// there is no such node to make — `figma.createConnector` is undefined and cloning an
// existing CONNECTOR is refused outright — so the binding lives in the record and this file
// is what makes it behave like one.
//
// The index is keyed on each endpoint's WHOLE ANCESTOR CHAIN, not on the endpoint id.
// Moving a frame fires a property change for that frame alone; its descendants report
// nothing. An endpoint-keyed index would therefore see no event whenever the endpoint sits
// inside the thing that moved — which is every annotation pointer, and every flow screen
// that lives in a column.

import { route } from '../../../shared/connector-route';
import { ROUTER_VERSION, type ConnectionRecord, type Point, type Rect } from '../../../shared/connector-types';
import { beginAgentMutation } from './correction-edge-store';
import { listConnections, upsertConnection } from './connector-store';
import { renderConnector } from './connector-render';
import { pageOf } from './page-of-node';

const DEBOUNCE_MS = 120;

/** ancestor (or endpoint) node id -> the connections that depend on it. */
let watchIndex: Map<string, Set<string>> | null = null;
/** The connector nodes we draw ourselves — their changes must never trigger a reroute. */
let ownNodes = new Set<string>();

const pendingConnections = new Set<string>();
let debounce: ReturnType<typeof setTimeout> | null = null;

function addWatch(map: Map<string, Set<string>>, nodeId: string, connectionId: string): void {
  const existing = map.get(nodeId);
  if (existing) existing.add(connectionId);
  else map.set(nodeId, new Set([connectionId]));
}

async function buildIndex(): Promise<Map<string, Set<string>>> {
  const map = new Map<string, Set<string>>();
  const own = new Set<string>();
  for (const record of listConnections()) {
    own.add(record.vectorNodeId);
    if (record.labelNodeId) own.add(record.labelNodeId);
    for (const endpoint of [record.from, record.to]) {
      let node: BaseNode | null = await figma.getNodeByIdAsync(endpoint);
      while (node) {
        addWatch(map, node.id, record.id);
        node = node.parent;
      }
    }
  }
  ownNodes = own;
  return map;
}

/** Drop the cached index — call after any change to the connection set or the tree shape. */
export function invalidateConnectorIndex(): void {
  watchIndex = null;
}

function boxOf(node: SceneNode): Rect | null {
  const box = node.absoluteBoundingBox;
  return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
}

function samePoints(a: readonly Point[], b: readonly Point[]): boolean {
  return a.length === b.length && a.every((point, i) => point.x === b[i].x && point.y === b[i].y);
}

export interface RerouteOutcome {
  connectionId: string;
  status: 'redrawn' | 'unchanged' | 'orphan';
}

/**
 * Recompute and redraw the given connections (all of them when `ids` is omitted).
 *
 * A connection whose recomputed route already matches the stored one is left ALONE. That is
 * not an optimisation: without it, a designer's undo of a reroute fires a change, which
 * triggers another reroute, which undoes their undo — the connector would win every ⌘Z and
 * the file would be impossible to back out of.
 */
export async function rerouteConnections(ids?: readonly string[]): Promise<RerouteOutcome[]> {
  const wanted = ids ? new Set(ids) : null;
  const outcomes: RerouteOutcome[] = [];

  for (const record of listConnections()) {
    if (wanted && !wanted.has(record.id)) continue;

    const source = await figma.getNodeByIdAsync(record.from);
    const target = await figma.getNodeByIdAsync(record.to);
    const sourceBox = source && 'absoluteBoundingBox' in source ? boxOf(source as SceneNode) : null;
    const targetBox = target && 'absoluteBoundingBox' in target ? boxOf(target as SceneNode) : null;
    if (!sourceBox || !targetBox) {
      // An endpoint is gone. Reported, never silently deleted — removing the drawing would
      // destroy the only evidence that an edge was ever there.
      outcomes.push({ connectionId: record.id, status: 'orphan' });
      continue;
    }

    const points = route({ source: sourceBox, target: targetBox, intent: record.intent });
    const vectorNode = await figma.getNodeByIdAsync(record.vectorNodeId);

    // Matching the endpoints is not enough to call a connector correct: the DRAWING can be
    // dragged away while the record still agrees with both ends. The live hook deliberately
    // ignores changes to our own nodes (or it would fight the designer on every nudge), so
    // this explicit repair is the only thing that can put a displaced line back.
    const drawnAtRoute = vectorNode && vectorNode.type === 'VECTOR'
      && Math.abs(vectorNode.x - Math.min(...points.map((p) => p.x))) <= 0.5
      && Math.abs(vectorNode.y - Math.min(...points.map((p) => p.y))) <= 0.5;

    if (samePoints(points, record.routePoints) && drawnAtRoute) {
      outcomes.push({ connectionId: record.id, status: 'unchanged' });
      continue;
    }

    const page = pageOf(source as SceneNode);
    if (!page) { outcomes.push({ connectionId: record.id, status: 'orphan' }); continue; }
    const labelNode = record.labelNodeId ? await figma.getNodeByIdAsync(record.labelNodeId) : null;
    const rendered = await renderConnector({
      connectionId: record.id,
      page,
      points,
      intent: record.intent,
      label: record.label,
      existingVector: vectorNode && vectorNode.type === 'VECTOR' ? vectorNode : null,
      existingLabel: labelNode && labelNode.type === 'FRAME' ? labelNode : null,
    });

    // Arm AFTER the writes, for the same reason the dispatch path arms post-dispatch: the
    // documentchange batch for what we just drew is delivered later, and a window armed
    // before an awaited render can expire before that batch ever lands. A reroute is not a
    // dispatch, so nothing upstream arms it for us.
    beginAgentMutation([rendered.vectorNodeId, ...(rendered.labelNodeId ? [rendered.labelNodeId] : [])]);

    const next: ConnectionRecord = {
      ...record,
      vectorNodeId: rendered.vectorNodeId,
      labelNodeId: rendered.labelNodeId,
      routePoints: points,
      routerVersion: ROUTER_VERSION,
    };
    upsertConnection(next);
    outcomes.push({ connectionId: record.id, status: 'redrawn' });
  }

  invalidateConnectorIndex();
  return outcomes;
}

async function flushPending(): Promise<void> {
  debounce = null;
  const ids = [...pendingConnections];
  pendingConnections.clear();
  if (ids.length === 0) return;
  try {
    await rerouteConnections(ids);
  } catch {
    // A live reroute is best-effort: a failure here must never take the capture loop with
    // it. The on-demand `reroute` command remains the way to repair deliberately.
  }
}

/**
 * Feed every node id a documentchange batch touched. Ids that no connection depends on cost
 * one map lookup; ids that do queue a redraw behind a short debounce, so dragging a frame
 * reroutes once at the end rather than on every frame of the drag.
 */
export async function noteChangedNodes(nodeIds: readonly string[]): Promise<void> {
  if (listConnections().length === 0) return;
  if (watchIndex === null) watchIndex = await buildIndex();

  let queued = false;
  for (const nodeId of nodeIds) {
    if (ownNodes.has(nodeId)) continue; // our own drawing, not a reason to redraw it
    const affected = watchIndex.get(nodeId);
    if (!affected) continue;
    for (const connectionId of affected) pendingConnections.add(connectionId);
    queued = true;
  }
  if (!queued) return;

  if (debounce !== null) clearTimeout(debounce);
  debounce = setTimeout(() => { void flushPending(); }, DEBOUNCE_MS);
}
