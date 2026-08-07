// CONNECT / DISCONNECT / LIST_CONNECTIONS — the agent-facing connector commands.
//
// Design files only. A FigJam board has native connectors and a Slides deck has no flow to
// draw, so this refuses both through the shared editor guard rather than half-working.

import { editorRefusal, type EditorType } from '../../../shared/editor-surface';
import { route } from '../../../shared/connector-route';
import { ROUTER_VERSION, type ConnectionRecord, type ConnectorIntent, type Rect } from '../../../shared/connector-types';
import { withCode } from './executor-styles';
import { pageOf, renderConnector } from './connector-render';
import { invalidateConnectorIndex, rerouteConnections } from './connector-reroute';
import {
  findConnection, findConnectionByEndpoints, listConnections, removeConnection, upsertConnection,
} from './connector-store';

type Params = Record<string, unknown>;

let connectionSequence = 0;

function requireDesignFile(capability: string): void {
  const refusal = editorRefusal({
    capability,
    required: ['figma'],
    found: (figma.editorType ?? null) as EditorType,
  });
  if (refusal) throw withCode(new Error(refusal), 'E_WRONG_EDITOR');
}

function str(params: Params, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

async function resolveEndpoint(id: string, role: string): Promise<SceneNode> {
  const node = await figma.getNodeByIdAsync(id);
  if (!node) throw withCode(new Error(`${role} node not found: ${id}`), 'E_INVALID_ARGS');
  if (!('absoluteBoundingBox' in node)) {
    throw withCode(new Error(`${role} node ${id} has no geometry (${node.type})`), 'E_INVALID_ARGS');
  }
  return node as SceneNode;
}

function boxOf(node: SceneNode, role: string): Rect {
  const box = node.absoluteBoundingBox;
  if (!box) throw withCode(new Error(`${role} node ${node.id} reports no bounding box`), 'E_INVALID_ARGS');
  return { x: box.x, y: box.y, width: box.width, height: box.height };
}

/** An existing node, or null when it is gone — a redraw must never resurrect a stale id. */
async function existingNode<T extends SceneNode>(id: string | null, type: T['type']): Promise<T | null> {
  if (!id) return null;
  const node = await figma.getNodeByIdAsync(id);
  return node && node.type === type ? node as T : null;
}

export async function opConnect(params: Params): Promise<Record<string, unknown>> {
  requireDesignFile('drawing a connector');

  const fromId = str(params, 'from', 'source');
  const toId = str(params, 'to', 'target');
  if (!fromId || !toId) throw withCode(new Error('CONNECT requires params.from and params.to'), 'E_INVALID_ARGS');
  if (fromId === toId) throw withCode(new Error('CONNECT needs two different nodes'), 'E_INVALID_ARGS');

  const intent: ConnectorIntent = str(params, 'intent') === 'annotation' ? 'annotation' : 'flow';
  const label = str(params, 'label');
  const flowName = str(params, 'flow', 'flowName');
  const transitionId = str(params, 'transition', 'transitionId');
  const clearance = typeof params.clearance === 'number' ? params.clearance : undefined;

  const source = await resolveEndpoint(fromId, 'source');
  const target = await resolveEndpoint(toId, 'target');

  const page = pageOf(source);
  if (!page || pageOf(target) !== page) {
    throw withCode(new Error('CONNECT needs both nodes on the same page'), 'E_INVALID_ARGS');
  }

  const points = route({ source: boxOf(source, 'source'), target: boxOf(target, 'target'), intent, clearance });

  // Connecting the same pair twice is a REDRAW, not a second line: an agent re-running a
  // flow must converge on one edge per transition, or the canvas grows a duplicate every run.
  const existing = findConnectionByEndpoints(fromId, toId);
  connectionSequence += 1;
  const connectionId = existing?.id ?? `conn-${Date.now()}-${connectionSequence}`;

  const rendered = await renderConnector({
    connectionId,
    page,
    points,
    intent,
    label,
    existingVector: await existingNode<VectorNode>(existing?.vectorNodeId ?? null, 'VECTOR'),
    existingLabel: await existingNode<TextNode>(existing?.labelNodeId ?? null, 'TEXT'),
  });

  const record: ConnectionRecord = {
    id: connectionId,
    from: fromId,
    to: toId,
    intent,
    // Provenance is what makes the canvas a projection of the linted graph rather than a
    // second graph: an edge that cannot name its transition can be measured but not checked.
    flow: flowName && transitionId ? { name: flowName, transitionId } : null,
    label,
    vectorNodeId: rendered.vectorNodeId,
    labelNodeId: rendered.labelNodeId,
    routePoints: points,
    routerVersion: ROUTER_VERSION,
  };
  upsertConnection(record);
  invalidateConnectorIndex();

  // `id` is the created node — main.ts reads it to record this dispatch's provenance and
  // arm the fresh node's suppression window.
  return { id: rendered.vectorNodeId, connectionId, redrawn: existing !== null, points, record };
}

export async function opDisconnect(params: Params): Promise<Record<string, unknown>> {
  requireDesignFile('removing a connector');
  const id = str(params, 'id', 'connectionId');
  const fromId = str(params, 'from');
  const toId = str(params, 'to');

  const record = id
    ? findConnection(id)
    : (fromId && toId ? findConnectionByEndpoints(fromId, toId) : null);
  if (!record) throw withCode(new Error('DISCONNECT requires params.id, or both params.from and params.to'), 'E_INVALID_ARGS');

  const vector = await existingNode<VectorNode>(record.vectorNodeId, 'VECTOR');
  const text = await existingNode<TextNode>(record.labelNodeId, 'TEXT');
  if (vector) vector.remove();
  if (text) text.remove();
  removeConnection(record.id);
  invalidateConnectorIndex();

  // A node already gone is reported, not silently counted as removed.
  return { connectionId: record.id, removedVector: vector !== null, removedLabel: text !== null };
}

/**
 * Recompute every connector (or the named ones) against the canvas as it stands now.
 *
 * This is the deliberate repair door. The live hook redraws on its own, but a connector can
 * still fall behind it — a geometry read taken while an auto-layout parent had not settled
 * yet returns pre-layout numbers, and nothing fires afterwards to say so.
 */
export async function opReroute(params: Params): Promise<Record<string, unknown>> {
  requireDesignFile('rerouting connectors');
  const id = str(params, 'id', 'connectionId');
  const flowName = str(params, 'flow', 'flowName');
  const scoped = id
    ? [id]
    : (flowName ? listConnections().filter((r) => r.flow?.name === flowName).map((r) => r.id) : undefined);

  const outcomes = await rerouteConnections(scoped);
  const counts = { redrawn: 0, unchanged: 0, orphan: 0 };
  for (const outcome of outcomes) counts[outcome.status] += 1;
  return { checked: outcomes.length, ...counts, outcomes };
}

export function opListConnections(): Record<string, unknown> {
  const connections = listConnections();
  return { count: connections.length, connections };
}
