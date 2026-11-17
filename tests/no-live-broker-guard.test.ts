// The vitest setup file must make `ensureBroker` unreachable from any test module that
// did not mock it itself — including a real, unmocked `run()` of a broker-backed command.
import { describe, expect, it } from 'vitest';
import { ensureBroker } from '../cli/src/transport/broker-discovery.ts';
import { runCommand } from '../cli/src/transport/broker-client.ts';

describe('no live broker from tests', () => {
  it('ensureBroker throws the guard error', async () => {
    await expect(ensureBroker()).rejects.toThrow('refusing to reach a real broker from a test');
  });

  it('runCommand (which calls ensureBroker internally) is refused too', async () => {
    await expect(runCommand('PING' as never, {})).rejects.toThrow('refusing to reach a real broker from a test');
  });
});
