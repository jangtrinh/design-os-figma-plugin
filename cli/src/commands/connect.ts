// `figma-agent connect` — draw (or redraw) one connector between two nodes.
import type { CommandArgs } from '../figma-agent.ts';
import { runCommand } from '../transport/broker-client.ts';

export async function run(args: CommandArgs): Promise<unknown> {
  const from = args.req('from');
  const to = args.req('to');
  return runCommand('CONNECT', {
    from,
    to,
    intent: args.str('intent'),
    label: args.str('label'),
    flow: args.str('flow'),
    transition: args.str('transition'),
    clearance: args.num('clearance'),
  }, { activity: `Connect · ${from} to ${to}` });
}
