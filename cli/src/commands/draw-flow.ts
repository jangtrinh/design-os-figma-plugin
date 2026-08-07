// `figma-agent draw-flow --flow flow.json` — render a linted navigation graph as real
// connectors. Screens resolve BY NAME, never by id: ids drift between sessions, and the
// screen id is the only handle an author controls in both files.
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { CommandArgs } from '../figma-agent.ts';
import { CliError } from '../transport/protocol-helpers.ts';
import { runCommand } from '../transport/broker-client.ts';
import { planFlow } from '../../../shared/flow-plan.ts';

export async function run(args: CommandArgs): Promise<unknown> {
  const path = resolve(args.req('flow'));
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new CliError('E_INVALID_ARGS', `cannot read flow "${path}": ${(error as Error).message}`);
  }

  const page = args.str('page');
  const plan = planFlow(document, basename(path).replace(/\.json$/i, ''));

  // Sequential on purpose: the connection store is authoritative in memory on the plugin
  // side, and overlapping dispatches would interleave at their awaits.
  const drawn: unknown[] = [];
  const failed: Array<{ transitionId: string; from: string; to: string; error: string }> = [];
  for (const edge of plan.edges) {
    try {
      const result = await runCommand('CONNECT', {
        fromName: edge.fromScreen,
        toName: edge.toScreen,
        page,
        label: edge.trigger,
        flow: plan.name,
        transition: edge.transitionId,
      }, { activity: `Flow · ${edge.fromScreen} to ${edge.toScreen}` }) as Record<string, unknown>;
      drawn.push({ transitionId: edge.transitionId, connectionId: result.connectionId, redrawn: result.redrawn });
    } catch (error) {
      // A screen with no frame is REPORTED, never quietly left out — a flow that silently
      // renders 4 of its 6 edges looks finished and is not.
      failed.push({
        transitionId: edge.transitionId,
        from: edge.fromScreen,
        to: edge.toScreen,
        error: (error as Error).message,
      });
    }
  }

  return {
    flow: plan.name,
    screens: plan.screens.length,
    edges: plan.edges.length,
    drawn: drawn.length,
    failedCount: failed.length,
    skippedCount: plan.skipped.length,
    drawnEdges: drawn,
    failed,
    skipped: plan.skipped,
  };
}
