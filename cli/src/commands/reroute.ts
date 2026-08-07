// `figma-agent reroute` — recompute drawn connectors against the canvas as it stands.
import type { CommandArgs } from '../figma-agent.ts';
import { runCommand } from '../transport/broker-client.ts';

export async function run(args: CommandArgs): Promise<unknown> {
  return runCommand('REROUTE', {
    id: args.str('id'),
    flow: args.str('flow'),
  }, { activity: 'Reroute connectors' });
}
