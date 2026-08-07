// `figma-agent verify-connections [--flow flow.json]` — the checker half of the connector
// contract. Canvas findings come from the plugin; PARITY against the graph is computed here,
// because flow.json lives on disk and the plugin has no filesystem.
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { CommandArgs } from '../figma-agent.ts';
import { CliError } from '../transport/protocol-helpers.ts';
import { runCommand } from '../transport/broker-client.ts';
import { planFlow } from '../../../shared/flow-plan.ts';

interface Report { connectionId: string; flow: { name: string; transitionId: string } | null; findings: string[] }

export async function run(args: CommandArgs): Promise<unknown> {
  const canvas = await runCommand('VERIFY_CONNECTIONS', {}, {
    activity: 'Verify connectors', readOnly: true,
  }) as { checked: number; ok: number; findings: Record<string, number>; reports: Report[] };

  const flowPath = args.str('flow');
  if (!flowPath) return { ...canvas, parity: null };

  const path = resolve(flowPath);
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new CliError('E_INVALID_ARGS', `cannot read flow "${path}": ${(error as Error).message}`);
  }
  const plan = planFlow(document, basename(path).replace(/\.json$/i, ''));

  // Parity is what makes the canvas a PROJECTION of the graph rather than a second graph:
  // every transition drawn exactly once, and nothing drawn that the graph does not declare.
  const drawnFor = new Map<string, string[]>();
  for (const report of canvas.reports) {
    if (report.flow?.name !== plan.name) continue;
    const existing = drawnFor.get(report.flow.transitionId);
    if (existing) existing.push(report.connectionId);
    else drawnFor.set(report.flow.transitionId, [report.connectionId]);
  }

  const missing = plan.edges.filter((e) => !drawnFor.has(e.transitionId)).map((e) => e.transitionId);
  const duplicated = [...drawnFor.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([transitionId, connectionIds]) => ({ transitionId, connectionIds }));
  const declared = new Set(plan.edges.map((e) => e.transitionId));
  const unexpected = [...drawnFor.keys()].filter((id) => !declared.has(id));

  return {
    ...canvas,
    parity: {
      flow: plan.name,
      transitions: plan.edges.length,
      drawn: drawnFor.size,
      missing,
      duplicated,
      unexpected,
      inSync: missing.length === 0 && duplicated.length === 0 && unexpected.length === 0,
    },
  };
}
