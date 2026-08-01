// Pure builders for the broker's status surface: the BROKER_HELLO data object
// (`figma-agent status` reads it) and the E_NO_PLUGIN message. Kept out of
// broker-daemon.ts so both are unit-testable without a live socket.
import type { PluginRegistry, RegistrySocket } from './plugin-registry.ts';
import type { JobInfo, PluginStatusEntry } from '../../../shared/protocol.ts';
import type { RouteFilter } from './route-filter.ts';
import { fileIdentity } from './file-identity.ts';

/** Concurrency & jobs (backlog 1.1+2.6+4.3) — one file's job status for `status` (4.3).
 *  `runningJob` is `null` for an idle file, never an omitted key (absent vs zero is a
 *  distinction agents should not have to guess). */
export interface FileJobStatus {
  runningJob: JobInfo | null;
  queueDepth: number;
}

/** A `plugins[]` row once `jobStatusFor` augments it (see `buildBrokerHelloData`) —
 *  status.ts's own type for reading the field back, instead of an untyped cast. */
export type PluginStatusEntryWithJob = PluginStatusEntry & FileJobStatus;

/** Daemon-owned fields the registry can't know (identity + uptime). */
export interface BrokerMeta {
  port: number;
  pid: number;
  protocolV: number;
  buildMtime: number;
  uptimeMs: number;
  /** Sender-verification counter (backlog 2.10 / issue #15) — how many reply frames
   *  `routeFromPlugin` has discarded this daemon run because the sending socket's
   *  plugin instance did not match the job's `targetInstanceId` (a spoofed/misrouted
   *  cross-instance reply). Daemon-scoped, not per-job. */
  senderMismatchCount: number;
  /** Issue #7 (backlog 5.6) fix round, reviewer finding 1 — true when the one-time
   *  startup migration of the OLD unbound-staging root failed (a full/unwritable
   *  /tmp, say) and was deferred to the next restart rather than aborting broker
   *  startup. The staged data itself is untouched (migration is copy-before-delete),
   *  but an operator needs to know it's still stuck at the old location. */
  legacyMigrationDeferred: boolean;
}

/**
 * The BROKER_HELLO `data`. Carries the full `plugins` list + `activePlugin` (the
 * current routing target's fileName) AND a legacy single-plugin mirror
 * (`pluginConnected` / `pluginState` / `lastHeartbeatAge` / `pluginInfo`) of the
 * ACTIVE plugin. The mirror is a COMPAT SHIM: design-os `_status_text` and older
 * consumers read `plugin.connected` (built from these fields in status.ts), so
 * they keep working unchanged through the single→multi plugin move.
 */
export function buildBrokerHelloData(
  registry: PluginRegistry<RegistrySocket>,
  meta: BrokerMeta,
  filter: string | null | undefined,
  now: () => number = Date.now,
  // Concurrency & jobs (backlog 1.1+2.6+4.3, phase 02 §3) — OPTIONAL: an older caller (or
  // an existing test) that omits it gets today's `plugins[]` shape byte-identical. When
  // given, each row gains `runningJob`/`queueDepth` — `null`/`0` for an idle file, never an
  // omitted key, per each row's OWN fileSlug (`fileIdentity(fileKey, fileName)` — the
  // SAME identity chain routing + registry + jobs already share).
  jobStatusFor?: (fileSlug: string) => FileJobStatus,
): Record<string, unknown> {
  const plugins: PluginStatusEntry[] = registry.statusList();
  const target = registry.selectTarget(filter);
  const connected = target !== null;
  const withJobs = jobStatusFor === undefined
    ? plugins
    : plugins.map((p) => {
        const slug = fileIdentity(p.fileKey ?? null, p.fileName ?? null);
        const { runningJob, queueDepth } = jobStatusFor(slug);
        return { ...p, runningJob, queueDepth };
      });
  return {
    port: meta.port,
    pid: meta.pid,
    protocolV: meta.protocolV,
    buildMtime: meta.buildMtime,
    uptimeMs: meta.uptimeMs,
    plugins: withJobs,
    activePlugin: target ? (target.scene.fileName as string | undefined) ?? null : null,
    // Sender-verification counter (backlog 2.10 / issue #15) — same "discarded thing
    // gets a machine-readable counter, but not one that clutters the common zero case"
    // contract as job-table.ts's `resultDropped`/`lateReplyCount`: present only once a
    // mismatch has actually happened, so a broker with zero spoofed replies (the
    // overwhelming common case) keeps this payload byte-identical to before this field
    // existed.
    ...(meta.senderMismatchCount > 0 && { senderMismatchCount: meta.senderMismatchCount }),
    // Issue #7 fix round — same "present only once it's actually true" contract as
    // senderMismatchCount just above: a broker whose legacy migration succeeded (or had
    // nothing to migrate — the overwhelming common case) keeps this payload
    // byte-identical to before this field existed.
    ...(meta.legacyMigrationDeferred && { legacyMigrationDeferred: true }),
    // ── legacy compat shim (mirrors the ACTIVE plugin) ──
    pluginConnected: connected,
    pluginState: connected ? 'connected' : 'disconnected',
    lastHeartbeatAge: target && target.lastSeenAt ? now() - target.lastSeenAt : null,
    pluginInfo: target ? target.scene : null,
  };
}

/**
 * The E_NO_PLUGIN message. With a routing filter set (`--instance`, `--file`, or
 * FIGMA_AGENT_FILE) AND other files connected, name the KNOB THE CALLER ACTUALLY USED and
 * list the connected files (so the user sees why routing refused); otherwise the plain "no
 * plugin connected" nudge. Naming FIGMA_AGENT_FILE for a `--file` miss would be wrong advice
 * — the caller never set that env var.
 *
 * `kind:'instance'` gets its OWN message shape rather than the connected-files list: an
 * instanceId that matches nothing means that specific instance disconnected — "connected
 * files: [...]" would invite the wrong fix (a name is not the missing key here, the
 * instanceId is), so the message points at `status` for the current live instanceIds instead.
 */
export function noPluginMessage(registry: PluginRegistry<RegistrySocket>, filter?: RouteFilter | null): string {
  const f = filter?.value?.trim();
  if (filter?.kind === 'instance' && f) {
    return `--instance "${f}" matches no connected plugin — it may have disconnected; run \`status\` for live instanceIds.`;
  }
  const live = registry.statusList();
  if (f && live.length > 0) {
    const names = live.map((p) => p.fileName ?? '(unnamed)').join(', ');
    const knob = filter?.source === 'flag' ? `--file "${f}"` : `FIGMA_AGENT_FILE="${f}"`;
    const fix = filter?.source === 'flag'
      ? 'Open that file\'s panel, or drop --file.'
      : 'Open that file\'s panel, or unset FIGMA_AGENT_FILE.';
    return `no Figma plugin matching ${knob} — connected files: [${names}]. ${fix}`;
  }
  return 'no Figma plugin connected — open the figma-agent plugin in Figma';
}
