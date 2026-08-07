// Is every drawn connector still telling the truth?
//
// This is the half that makes the emitter trustworthy. Connectors are stale-by-default
// between reroutes, so without a checker there is no way to tell a correct canvas from one
// that quietly stopped matching — and a picture nobody can check is decoration.

import { route } from '../../../shared/connector-route';
import { routesMatch } from '../../../shared/flow-plan';
import { ROUTER_VERSION, type Rect } from '../../../shared/connector-types';
import { listConnections, readNodeConnectionId } from './connector-store';

/** Half a pixel: below it is float noise, above it the line has genuinely moved. */
const EPSILON = 0.5;

export type ConnectorFinding = 'orphan' | 'desync' | 'stale' | 'drift';

export interface ConnectorReport {
  connectionId: string;
  from: string;
  to: string;
  flow: { name: string; transitionId: string } | null;
  findings: ConnectorFinding[];
  detail: string[];
}

function boxOf(node: BaseNode | null): Rect | null {
  if (!node || !('absoluteBoundingBox' in node)) return null;
  const box = (node as SceneNode).absoluteBoundingBox;
  return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
}

export async function verifyConnections(): Promise<{
  checked: number;
  ok: number;
  findings: Record<ConnectorFinding, number>;
  reports: ConnectorReport[];
}> {
  const reports: ConnectorReport[] = [];
  const counts: Record<ConnectorFinding, number> = { orphan: 0, desync: 0, stale: 0, drift: 0 };

  for (const record of listConnections()) {
    const findings: ConnectorFinding[] = [];
    const detail: string[] = [];

    const source = await figma.getNodeByIdAsync(record.from);
    const target = await figma.getNodeByIdAsync(record.to);
    const sourceBox = boxOf(source);
    const targetBox = boxOf(target);
    if (!sourceBox || !targetBox) {
      findings.push('orphan');
      detail.push(`endpoint gone: ${!sourceBox ? record.from : record.to}`);
    }

    const vector = await figma.getNodeByIdAsync(record.vectorNodeId);
    if (!vector || vector.type !== 'VECTOR') {
      findings.push('desync');
      detail.push(`no vector node at ${record.vectorNodeId}`);
    } else if (readNodeConnectionId(vector as SceneNode) !== record.id) {
      // Copy/paste and page duplication carry plugin data along, so a second node can claim
      // this id. The record names exactly one node; anything else wearing the id is a copy.
      findings.push('desync');
      detail.push(`node ${vector.id} claims a different connection id`);
    }

    if (record.routerVersion !== ROUTER_VERSION) {
      findings.push('stale');
      detail.push(`drawn by router v${record.routerVersion}, current is v${ROUTER_VERSION}`);
    }

    if (sourceBox && targetBox) {
      const fresh = route({ source: sourceBox, target: targetBox, intent: record.intent });
      if (!routesMatch(record.routePoints, fresh, EPSILON)) {
        findings.push('drift');
        detail.push('the stored route no longer matches the endpoints');
      } else if (vector && vector.type === 'VECTOR') {
        // The record can agree with the endpoints while the DRAWING has been dragged away
        // from both — the record is a claim about the canvas, so check the canvas too.
        const drawn = boxOf(vector);
        const minX = Math.min(...fresh.map((p) => p.x));
        const minY = Math.min(...fresh.map((p) => p.y));
        if (drawn && (Math.abs(drawn.x - minX) > EPSILON || Math.abs(drawn.y - minY) > EPSILON)) {
          findings.push('drift');
          detail.push(`drawn at ${drawn.x},${drawn.y} but the route starts at ${minX},${minY}`);
        }
      }
    }

    for (const finding of findings) counts[finding] += 1;
    reports.push({
      connectionId: record.id,
      from: record.from,
      to: record.to,
      flow: record.flow,
      findings,
      detail,
    });
  }

  return {
    checked: reports.length,
    ok: reports.filter((r) => r.findings.length === 0).length,
    findings: counts,
    reports,
  };
}
