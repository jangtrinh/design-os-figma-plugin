// Broker discovery: open every candidate port at once and adopt the first greeting.
//
// The panel cannot do anything until a broker answers, so the scan's worst case IS the
// plugin's perceived boot time. Probing 9410→9419 one at a time meant a full pass cost
// ten probe timeouts (12s) before the panel could honestly say "no broker", and a
// broker parked on the last port cost nine of those timeouts on every reconnect. Ten
// loopback sockets opened together cost the broker one O(1) accept each and are torn
// down the instant the race is decided, so a pass now costs ONE timeout window.
//
// The socket itself arrives through an injected transport rather than being built
// here: that is what keeps this module free of the DOM (ui-relay.ts owns the real
// `new WebSocket(...)`) and what lets a test drive open/greet/close per port.
import type { BrokerHelloData } from '../../../shared/protocol';

export interface ProbeListeners {
  /** One inbound frame, exactly as the socket delivered it. */
  message(data: unknown): void;
  /** The socket errored or closed — either way this port is a miss. */
  fail(): void;
}

/** How the probe opens, listens to, and disposes of one socket. */
export interface ProbeTransport<S> {
  open(port: number): S;
  listen(socket: S, on: ProbeListeners): void;
  /** Drop the probe's listeners — the winner is handed on with its own handlers clear. */
  detach(socket: S): void;
  close(socket: S): void;
}

export interface BrokerProbeResult<S> {
  socket: S;
  port: number;
  hello: BrokerHelloData;
}

export interface CancellableProbe<S> {
  /** Resolves with the greeting socket, or null on timeout / error / cancel. Never rejects. */
  readonly result: Promise<BrokerProbeResult<S> | null>;
  /**
   * Release this probe's socket. Before it settles that means "give up on this port":
   * the socket is closed and the probe settles null. After it has already produced a
   * greeting it means "I am not adopting you after all" and closes that socket too —
   * the case where two ports greet inside the same tick and only one can be adopted.
   * Idempotent.
   */
  cancel(): void;
}

/**
 * Probe one port. A port only counts as the broker when it sends `BROKER_HELLO`;
 * anything else on the wire (a foreign server babbling, an error, a close) is a miss,
 * and so is silence past `timeoutMs`. A missed socket is always closed — the winner's
 * socket is handed over still open, because the caller adopts that exact socket.
 */
export function probeBrokerPort<S>(
  port: number,
  transport: ProbeTransport<S>,
  timeoutMs: number,
): CancellableProbe<S> {
  let settle: (value: BrokerProbeResult<S> | null) => void = () => { /* replaced below */ };
  const result = new Promise<BrokerProbeResult<S> | null>((resolve) => { settle = resolve; });

  let socket: S;
  try {
    socket = transport.open(port);
  } catch {
    // The plugin sandbox can refuse a socket outright. A refusal is a miss, never a
    // thrown scan — one blocked port must not abort discovery on the other nine.
    settle(null);
    return { result, cancel: () => { /* nothing was opened */ } };
  }

  let settled = false;
  let won: BrokerProbeResult<S> | null = null;
  const finish = (found: BrokerProbeResult<S> | null): void => {
    if (settled) {
      // A greeting that lands after this probe was decided still owns a live socket;
      // closing it here is what stops a loser leaking a connection into the broker.
      if (found) transport.close(found.socket);
      return;
    }
    settled = true;
    won = found;
    clearTimeout(timer);
    transport.detach(socket);
    if (!found) transport.close(socket);
    settle(found);
  };

  const timer = setTimeout(() => finish(null), timeoutMs);
  transport.listen(socket, {
    message: (data) => {
      try {
        const msg = JSON.parse(String(data)) as { type?: unknown; data?: unknown };
        if (msg?.type === 'BROKER_HELLO') {
          finish({ socket, port, hello: (msg.data as BrokerHelloData | undefined) ?? {} });
        }
      } catch { /* not the greeting — keep waiting until timeout */ }
    },
    fail: () => finish(null),
  });

  return {
    result,
    cancel: () => {
      if (won) transport.close(won.socket);
      else finish(null);
    },
  };
}

/**
 * Race every port. Resolves as soon as the FASTEST port greets — never after the
 * slowest settles — and cancels the rest so no unadopted socket is left open. Resolves
 * null only once every port has missed. `onProbeStart` fires per port so the panel's
 * connection sentence still names what is being probed.
 */
export function scanPortsForBroker<S>(
  ports: readonly number[],
  probe: (port: number) => CancellableProbe<S>,
  onProbeStart?: (port: number) => void,
): Promise<BrokerProbeResult<S> | null> {
  return new Promise((resolve) => {
    if (ports.length === 0) {
      resolve(null);
      return;
    }
    let decided = false;
    let outstanding = ports.length;
    const probes: CancellableProbe<S>[] = [];

    const miss = (): void => {
      outstanding -= 1;
      if (!decided && outstanding === 0) {
        decided = true;
        resolve(null);
      }
    };

    for (const port of ports) {
      onProbeStart?.(port);
      const started = probe(port);
      probes.push(started);
      void started.result.then((found) => {
        if (!found) {
          miss();
          return;
        }
        if (decided) {
          started.cancel(); // a second greeting in the same tick: close it, never adopt it
          return;
        }
        decided = true;
        for (const other of probes) if (other !== started) other.cancel();
        resolve(found);
      });
    }
  });
}
