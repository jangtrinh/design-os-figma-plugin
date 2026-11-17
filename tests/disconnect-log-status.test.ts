// `figma-agent status` passes the broker's plugin-disconnect summary (BROKER_HELLO
// `disconnects`) through to its JSON output, and stays byte-identical against an older
// broker that sends none. Both broker seams are mocked: no socket, no spawn.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandArgs } from '../cli/src/arg-parse.ts';

vi.mock('../cli/src/transport/broker-discovery.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../cli/src/transport/broker-discovery.ts')>();
  return { ...actual, ensureBroker: vi.fn(async () => ({ port: 1, pid: 2 })) };
});
vi.mock('../cli/src/transport/broker-client.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../cli/src/transport/broker-client.ts')>();
  return {
    ...actual,
    fetchBrokerHello: vi.fn(),
    runCommand: vi.fn(async () => { throw new Error('status test must not round-trip a command'); }),
  };
});

const { fetchBrokerHello } = await import('../cli/src/transport/broker-client.ts');
const { run } = await import('../cli/src/commands/status.ts');

const args: CommandArgs = {
  positionals: [],
  str: () => undefined,
  req: (name) => { throw new Error(`missing --${name}`); },
  num: () => undefined,
  bool: () => false,
};

const baseHello = { port: 1, pid: 2, protocolV: 1, plugins: [], pluginConnected: false, activePlugin: null };

beforeEach(() => {
  vi.mocked(fetchBrokerHello).mockReset();
});

describe('status — plugin disconnect summary', () => {
  it('shows the broker-reported path, newest records, and failure count', async () => {
    const disconnects = {
      path: '/tmp/figma-disconnects.jsonl',
      last: [{ at: '2026-09-24T00:00:00.000Z', instanceId: 'i1', closedBy: 'peer', superseded: false, inFlightJobs: [] }],
      appendFailures: 2,
    };
    vi.mocked(fetchBrokerHello).mockResolvedValue({ ...baseHello, disconnects });
    const out = await run(args) as Record<string, unknown>;
    expect(out.disconnects).toEqual(disconnects);
  });

  it('omits the field for a broker that does not report disconnects', async () => {
    vi.mocked(fetchBrokerHello).mockResolvedValue({ ...baseHello });
    const out = await run(args) as Record<string, unknown>;
    expect('disconnects' in out).toBe(false);
  });

  it('preserves caps advertised by plugins in status output', async () => {
    const plugins = [
      {
        instanceId: 'inst_1',
        fileName: 'F1',
        state: 'connected' as const,
        connectedAt: 1000,
        lastHeartbeatAge: 10,
        appSilenceMs: 10,
        caps: ['fileGuard', 'appProbeV1'],
      },
      {
        instanceId: 'inst_2',
        fileName: 'F2',
        state: 'connected' as const,
        connectedAt: 1000,
        lastHeartbeatAge: 10,
        appSilenceMs: 10,
      },
    ];
    vi.mocked(fetchBrokerHello).mockResolvedValue({ ...baseHello, plugins });
    const out = await run(args) as { plugins: Array<{ instanceId: string; caps?: string[] }> };
    expect(out.plugins[0]?.caps).toEqual(['fileGuard', 'appProbeV1']);
    expect('caps' in (out.plugins[1] ?? {})).toBe(false);
  });
});
