// `figma-agent list-connections` — every connector this file remembers. Read-only.
import type { CommandArgs } from '../figma-agent.ts';
import { runCommand } from '../transport/broker-client.ts';

export async function run(_args: CommandArgs): Promise<unknown> {
  return runCommand('LIST_CONNECTIONS', {}, { activity: 'Read connections', readOnly: true });
}
