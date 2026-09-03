export type HeartbeatMode = 'correlated' | 'legacy';
export type HeartbeatLeasePhase = 'probing' | 'ready' | 'suspect';

export interface HeartbeatLeaseState {
  mode: HeartbeatMode;
  phase: HeartbeatLeasePhase;
  currentProbeId: string | null;
  sentAt: number | null;
  deadline: number | null;
  lastTickAt: number;
}

export interface HeartbeatLeaseConfig {
  intervalMs: number;
  timeoutMs: number;
}

export type HeartbeatLeaseEffect =
  | { type: 'send-challenge'; probeId: string }
  | { type: 'accepted-current' }
  | { type: 'teardown' };

export type HeartbeatLeaseEvent =
  | { type: 'tick'; now: number; nextProbeId: string }
  | { type: 'pong'; now: number; probeId?: string };

export interface HeartbeatLeaseDecision {
  state: HeartbeatLeaseState;
  effects: HeartbeatLeaseEffect[];
}

function challenge(
  state: HeartbeatLeaseState,
  now: number,
  probeId: string,
  timeoutMs: number,
  phase: HeartbeatLeasePhase,
): HeartbeatLeaseDecision {
  return {
    state: {
      ...state,
      phase,
      currentProbeId: probeId,
      sentAt: now,
      deadline: now + timeoutMs,
      lastTickAt: now,
    },
    effects: [{ type: 'send-challenge', probeId }],
  };
}

export function startHeartbeatLease(
  mode: HeartbeatMode,
  now: number,
  probeId: string,
  config: HeartbeatLeaseConfig,
): HeartbeatLeaseDecision {
  return challenge({
    mode,
    phase: 'probing',
    currentProbeId: null,
    sentAt: null,
    deadline: null,
    lastTickAt: now,
  }, now, probeId, config.timeoutMs, 'probing');
}

export function reduceHeartbeatLease(
  state: HeartbeatLeaseState,
  event: HeartbeatLeaseEvent,
  config: HeartbeatLeaseConfig,
): HeartbeatLeaseDecision {
  if (event.type === 'pong') {
    const accepted = state.currentProbeId !== null && (
      state.mode === 'correlated'
        ? event.probeId === state.currentProbeId
        : event.probeId === undefined
    );
    if (!accepted) return { state, effects: [] };
    return {
      state: {
        ...state,
        phase: 'ready',
        currentProbeId: null,
        sentAt: null,
        deadline: null,
      },
      effects: [{ type: 'accepted-current' }],
    };
  }

  const schedulerWasSuspended = event.now - state.lastTickAt > config.timeoutMs;
  if (schedulerWasSuspended) {
    return challenge(state, event.now, event.nextProbeId, config.timeoutMs, 'suspect');
  }
  if (state.phase === 'ready') {
    return challenge(state, event.now, event.nextProbeId, config.timeoutMs, 'probing');
  }

  const expired = state.deadline !== null && event.now > state.deadline;
  if (!expired) {
    return { state: { ...state, lastTickAt: event.now }, effects: [] };
  }
  if (state.phase === 'probing') {
    return challenge(state, event.now, event.nextProbeId, config.timeoutMs, 'suspect');
  }
  return {
    state: { ...state, lastTickAt: event.now },
    effects: [{ type: 'teardown' }],
  };
}
