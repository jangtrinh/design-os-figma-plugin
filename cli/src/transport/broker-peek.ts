// The non-spawning read behind `status --peek` — a SessionStart hook must be
// able to call this without ever starting a broker. NEVER calls `ensureBroker`
// (broker-discovery.ts, which spawns); only reads the /tmp advertisement and,
// if one looks live, asks that broker ONE short question with its own deadline.
import { BROKER_FILE, PROTOCOL_VERSION, type PluginStatusEntry } from '../../../shared/protocol.ts';
import { isAdvertisementLive, readAdvertisement } from './broker-discovery.ts';
import { fetchBrokerHello } from './broker-client.ts';
import { envMs } from './protocol-helpers.ts';
import { CLI_VERSION } from '../version.ts';

export interface PeekPluginEntry {
  fileName: string | null;
  page: string | null;
  instanceId: string;
  pluginVersion?: string;
  protocolV?: number;
  versionMatch: boolean | null;
  protocolMatch: boolean | null;
}

export interface PeekResult {
  // `null` means "unknown" — the broker exists (a live advertisement said so) but
  // didn't answer in time, or refused; that is NOT the same fact as `false` (no
  // broker at all / a plugin genuinely absent). See the `idle`/`degraded` branches.
  connected: boolean | null;
  idle?: true;
  reason?: string;
  degraded?: string;
  broker: { port: number; pid: number; protocolVersion?: number; uptimeMs?: number } | null;
  plugins?: PeekPluginEntry[];
  cliVersion: string;
  versionMatch?: boolean | null;
  protocolMatch?: boolean | null;
}

/** `undefined` (the field was never sent) is UNKNOWN, not a mismatch. */
function matchOrNull(actual: string | number | undefined, expected: string | number): boolean | null {
  return actual === undefined ? null : actual === expected;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type QueryOutcome<T> = { kind: 'ok'; value: T } | { kind: 'timeout' } | { kind: 'refused'; error: unknown };

/**
 * Race a promise against a plain deadline, WITHOUT collapsing a refusal and an
 * actual timeout into the same outcome — a closed-port ECONNREFUSED and a
 * silent-but-accepting listener are different facts and must produce different
 * messages (a caller that reads `degraded` and believes "did not answer within
 * Nms" for an instant refusal is told something false). The loser is never
 * awaited again after this resolves; a late settle from the losing side is
 * silently dropped (the `settled` guard), so it can never surface as an
 * unhandled rejection.
 */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<QueryOutcome<T>> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolvePromise({ kind: 'timeout' });
    }, ms);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise({ kind: 'ok', value });
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise({ kind: 'refused', error });
      },
    );
  });
}

/**
 * `status --peek`'s implementation. Exits (returns) normally in every case —
 * idle, a stale/dead advertisement, and a broker that doesn't answer in time
 * are all honest, non-error answers, never a thrown failure.
 */
export async function peek(opts?: { path?: string; queryMs?: number }): Promise<PeekResult> {
  const path = opts?.path ?? process.env.FIGMA_AGENT_BROKER_FILE ?? BROKER_FILE;
  const ad = readAdvertisement(path);
  if (!ad || !isAdvertisementLive(ad)) {
    return { connected: false, broker: null, idle: true, reason: 'no live broker advertisement', cliVersion: CLI_VERSION };
  }

  const queryMs = opts?.queryMs ?? envMs('FIGMA_AGENT_PEEK_MS', 150);
  const outcome = await withDeadline(fetchBrokerHello(ad.port), queryMs);
  if (outcome.kind !== 'ok') {
    const degraded = outcome.kind === 'timeout'
      ? `broker did not answer within ${queryMs}ms`
      : `broker refused the connection: ${describeError(outcome.error)}`;
    return {
      // Unknown, not "not connected" — a broker that is merely slow or that
      // refused this one query is a different fact from no broker existing at
      // all (the `idle` branch above, where `false` really is known).
      connected: null,
      broker: { port: ad.port, pid: ad.pid },
      degraded,
      cliVersion: CLI_VERSION,
    };
  }
  const hello = outcome.value;

  const rawPlugins = Array.isArray(hello.plugins) ? (hello.plugins as PluginStatusEntry[]) : [];
  const plugins: PeekPluginEntry[] = rawPlugins.map((p) => ({
    fileName: p.fileName ?? null,
    page: p.page ?? null,
    instanceId: p.instanceId,
    ...(p.pluginVersion !== undefined && { pluginVersion: p.pluginVersion }),
    ...(p.protocolV !== undefined && { protocolV: p.protocolV }),
    versionMatch: matchOrNull(p.pluginVersion, CLI_VERSION),
    protocolMatch: matchOrNull(p.protocolV, PROTOCOL_VERSION),
  }));

  const activeFileName = (hello.activePlugin as string | null | undefined) ?? null;
  const active = activeFileName ? plugins.find((p) => p.fileName === activeFileName) : undefined;

  return {
    connected: (hello.pluginConnected as boolean | undefined) === true,
    broker: {
      port: ad.port,
      pid: ad.pid,
      protocolVersion: (hello.protocolV as number | undefined) ?? PROTOCOL_VERSION,
      uptimeMs: (hello.uptimeMs as number | undefined) ?? undefined,
    },
    plugins,
    cliVersion: CLI_VERSION,
    versionMatch: active ? active.versionMatch : null,
    protocolMatch: active ? active.protocolMatch : null,
  };
}
