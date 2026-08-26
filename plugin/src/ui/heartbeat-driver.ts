import {
  reduceHeartbeatLease,
  startHeartbeatLease,
  type HeartbeatLeaseConfig,
  type HeartbeatLeaseDecision,
  type HeartbeatLeaseState,
  type HeartbeatMode,
} from './heartbeat-lease';

export interface HeartbeatDriverPorts {
  now: () => number;
  nextProbeId: () => string;
  schedule: (callback: () => void, intervalMs: number) => unknown;
  cancel: (handle: unknown) => void;
  sendProbe: (probeId: string, mode: HeartbeatMode) => void;
  teardown: (reason: string) => void;
  emitConnected: () => void;
}

export interface HeartbeatDriver {
  start(mode: HeartbeatMode): void;
  stop(): void;
  receivePong(probeId?: string): boolean;
}

export function createHeartbeatDriver(
  ports: HeartbeatDriverPorts,
  config: HeartbeatLeaseConfig,
): HeartbeatDriver {
  let scheduleHandle: unknown;
  let generation = 0;
  let lease: HeartbeatLeaseState | null = null;
  let connectedEmitted = false;

  function stop(): void {
    generation += 1;
    lease = null;
    connectedEmitted = false;
    if (scheduleHandle !== undefined) {
      ports.cancel(scheduleHandle);
      scheduleHandle = undefined;
    }
  }

  function apply(decision: HeartbeatLeaseDecision): boolean {
    lease = decision.state;
    let accepted = false;
    for (const effect of decision.effects) {
      if (effect.type === 'send-challenge') {
        try {
          ports.sendProbe(effect.probeId, decision.state.mode);
        } catch {
          stop();
          ports.teardown('ping failed — reconnecting…');
          break;
        }
      } else if (effect.type === 'accepted-current') {
        accepted = true;
        if (!connectedEmitted) {
          connectedEmitted = true;
          ports.emitConnected();
        }
      } else {
        stop();
        ports.teardown('heartbeat lost — reconnecting…');
        break;
      }
    }
    return accepted;
  }

  return {
    start(mode) {
      stop();
      const started = startHeartbeatLease(mode, ports.now(), ports.nextProbeId(), config);
      apply(started);
      if (lease === null) return;
      const activeGeneration = generation;
      scheduleHandle = ports.schedule(() => {
        if (activeGeneration !== generation || lease === null) return;
        apply(reduceHeartbeatLease(lease, {
          type: 'tick',
          now: ports.now(),
          nextProbeId: ports.nextProbeId(),
        }, config));
      }, config.intervalMs);
    },
    stop,
    receivePong(probeId) {
      if (lease === null) return false;
      return apply(reduceHeartbeatLease(lease, {
        type: 'pong',
        now: ports.now(),
        probeId,
      }, config));
    },
  };
}
