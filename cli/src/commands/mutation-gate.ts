// Broker-terminal mutation-admission control. This command deliberately accepts
// only a raw durable file key: a filename is neither an equivalent nor a fallback.
import type { CommandArgs } from '../figma-agent.ts';
import { runCommand } from '../transport/broker-client.ts';
import { CliError } from '../transport/protocol-helpers.ts';

const MODES = ['pause', 'resume', 'status'] as const;
type MutationGateMode = typeof MODES[number];

function isMode(value: string | undefined): value is MutationGateMode {
  return value !== undefined && (MODES as readonly string[]).includes(value);
}

export async function run(args: CommandArgs): Promise<unknown> {
  const mode = args.positionals[0];
  if (args.positionals.length !== 1 || !isMode(mode)) {
    throw new CliError('E_INVALID_ARGS', 'mutation-gate requires one mode: pause, resume, or status');
  }

  const fileKey = args.str('file-key');
  if (fileKey === undefined || fileKey.trim() === '') {
    throw new CliError('E_INVALID_ARGS', 'mutation-gate requires a nonempty --file-key <raw-key>');
  }

  return runCommand('MUTATION_GATE', { mode, fileKey });
}
