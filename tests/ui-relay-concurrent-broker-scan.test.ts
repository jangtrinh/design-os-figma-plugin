// Broker discovery used to walk 9410→9419 one port at a time, awaiting a 1200ms
// timeout on each miss: up to 12s before the panel could even say "no broker", and a
// broker parked on 9419 cost ~10.8s on EVERY reconnect. These tests pin the
// concurrent contract instead — every port is opened in the same tick, the first
// BROKER_HELLO wins, every loser socket is closed, and a pass with no broker anywhere
// settles after ONE timeout window rather than ten. `probeBrokerPort`/
// `scanPortsForBroker` did not exist before this change (the loop lived inline in
// ui-relay.ts), so this file fails to import against pre-fix code.
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  probeBrokerPort, scanPortsForBroker,
  type BrokerProbeResult, type ProbeListeners, type ProbeTransport,
} from '../plugin/src/ui/broker-scan.ts';
import { PORT_RANGE_END, PORT_RANGE_START } from '../shared/protocol.ts';

const PROBE_TIMEOUT_MS = 1200;
const PORTS: number[] = [];
for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) PORTS.push(port);

/** Fake WebSocket: nothing happens to it unless the test says so — no auto-open, no
 *  auto-greeting. A permissive double that greets by itself would make a sequential
 *  scan look concurrent. */
class FakeSocket {
  private listeners: ProbeListeners | null = null;
  closeCount = 0;
  constructor(readonly port: number) {}
  attach(on: ProbeListeners): void { this.listeners = on; }
  detach(): void { this.listeners = null; }
  close(): void { this.closeCount += 1; }
  get closed(): boolean { return this.closeCount > 0; }
  get listening(): boolean { return this.listeners !== null; }
  greet(data: Record<string, unknown> = {}): void {
    this.listeners?.message(JSON.stringify({ type: 'BROKER_HELLO', data }));
  }
  /** A foreign process on the port that answers something else — never the greeting. */
  babble(): void { this.listeners?.message('not json at all'); }
  fail(): void { this.listeners?.fail(); }
}

function fakeTransport(opened: Map<number, FakeSocket>): ProbeTransport<FakeSocket> {
  return {
    open: (port) => { const socket = new FakeSocket(port); opened.set(port, socket); return socket; },
    listen: (socket, on) => socket.attach(on),
    detach: (socket) => socket.detach(),
    close: (socket) => socket.close(),
  };
}

function openScan(opened: Map<number, FakeSocket>, started: number[] = []): Promise<BrokerProbeResult<FakeSocket> | null> {
  const transport = fakeTransport(opened);
  return scanPortsForBroker(
    PORTS,
    (port) => probeBrokerPort(port, transport, PROBE_TIMEOUT_MS),
    (port) => started.push(port),
  );
}

afterEach(() => { vi.useRealTimers(); });

describe('scanPortsForBroker — every port is probed in the same tick', () => {
  it('opens all ten sockets before any of them answers, and announces each port', async () => {
    const opened = new Map<number, FakeSocket>();
    const started: number[] = [];
    const scan = openScan(opened, started);

    expect([...opened.keys()]).toEqual(PORTS);
    expect(started).toEqual(PORTS);

    opened.get(PORT_RANGE_END)!.greet({ appReadinessV: 1 });
    const found = await scan;
    expect(found).toMatchObject({ port: PORT_RANGE_END, hello: { appReadinessV: 1 } });
  });

  it('resolves at the FASTEST probe and cancels the ones still hanging', async () => {
    const opened = new Map<number, FakeSocket>();
    const scan = openScan(opened);

    opened.get(9410)!.greet();
    const found = await scan;
    if (!found) throw new Error('expected a broker');

    expect(found.port).toBe(9410);
    expect(found.socket.closed, 'the adopted socket is never closed').toBe(false);
    for (const port of PORTS.slice(1)) {
      expect(opened.get(port)!.closed, `loser ${port} closed`).toBe(true);
    }
  });

  it('closes a second BROKER_HELLO that lands in the same tick instead of leaking it', async () => {
    const opened = new Map<number, FakeSocket>();
    const scan = openScan(opened);

    opened.get(9410)!.greet();
    opened.get(9415)!.greet(); // both answered before either resolution was observed
    const found = await scan;

    expect(found?.socket).toBe(opened.get(9410));
    expect(opened.get(9415)!.closed, 'the runner-up socket is closed, never adopted').toBe(true);
  });

  it('a greeting that arrives after the race is over cannot revive a cancelled port', async () => {
    const opened = new Map<number, FakeSocket>();
    const scan = openScan(opened);

    opened.get(9410)!.greet();
    const found = await scan;
    const late = opened.get(9419)!;
    expect(late.listening, 'a cancelled probe stops listening').toBe(false);
    late.greet();

    expect(found?.socket).toBe(opened.get(9410));
    expect(late.closed).toBe(true);
  });

  it('reports no broker after ONE timeout window, not ten', async () => {
    vi.useFakeTimers();
    const opened = new Map<number, FakeSocket>();
    let settled: unknown = 'pending';
    void openScan(opened).then((value) => { settled = value; });

    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS - 1);
    expect(settled).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBeNull();
  });

  it('a port that errors or closes is a miss, and does not end the pass', async () => {
    const opened = new Map<number, FakeSocket>();
    const scan = openScan(opened);

    opened.get(9410)!.fail(); // the transport reports an error and a close the same way
    opened.get(9411)!.fail();
    opened.get(9412)!.babble(); // occupied by something that is not the broker
    opened.get(9413)!.greet();

    const found = await scan;
    expect(found).toMatchObject({ port: 9413 });
    expect(opened.get(9410)!.closed && opened.get(9411)!.closed, 'missed ports are closed').toBe(true);
  });

  it('a socket the environment refuses to open is a miss, not a thrown scan', async () => {
    const refusing: ProbeTransport<FakeSocket> = {
      open: () => { throw new Error('blocked by the plugin sandbox'); },
      listen: () => { throw new Error('never reached'); },
      detach: () => { throw new Error('never reached'); },
      close: () => { throw new Error('never reached'); },
    };
    const scan = scanPortsForBroker(PORTS, (port) => probeBrokerPort(port, refusing, PROBE_TIMEOUT_MS));
    expect(await scan).toBeNull();
  });
});

describe('probeBrokerPort — one port, cancellable', () => {
  it('cancel() closes the socket and settles null, and a later greeting cannot revive it', async () => {
    const opened = new Map<number, FakeSocket>();
    const probe = probeBrokerPort(9410, fakeTransport(opened), PROBE_TIMEOUT_MS);
    const socket = opened.get(9410)!;

    probe.cancel();
    expect(socket.closed).toBe(true);
    socket.greet();

    expect(await probe.result).toBeNull();
  });

  it('resolves the greeting payload with the port it came from', async () => {
    const opened = new Map<number, FakeSocket>();
    const probe = probeBrokerPort(9417, fakeTransport(opened), PROBE_TIMEOUT_MS);
    const socket = opened.get(9417)!;
    socket.greet({ appReadinessV: 1 });

    expect(await probe.result).toEqual({ socket, port: 9417, hello: { appReadinessV: 1 } });
    expect(socket.closed, 'a greeting socket is handed on open').toBe(false);
  });

  it('times out to null and closes the socket when nothing greets', async () => {
    vi.useFakeTimers();
    const opened = new Map<number, FakeSocket>();
    const probe = probeBrokerPort(9410, fakeTransport(opened), PROBE_TIMEOUT_MS);
    const socket = opened.get(9410)!;

    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
    expect(await probe.result).toBeNull();
    expect(socket.closed).toBe(true);
  });
});
