// `figma-agent disconnect` — remove a connector, by connection id or by endpoint pair.
import type { CommandArgs } from '../figma-agent.ts';
import { runCommand } from '../transport/broker-client.ts';

export async function run(args: CommandArgs): Promise<unknown> {
  return runCommand('DISCONNECT', {
    id: args.str('id'),
    from: args.str('from'),
    to: args.str('to'),
  }, { activity: 'Disconnect' });
}
