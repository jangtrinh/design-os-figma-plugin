// `figma-agent status` — broker {port,pid,uptime,protocolVersion} from a
// BROKER_HELLO read, plus `plugins` (one row per connected file), `activePlugin`
// (the current routing target's fileName), and a legacy `plugin` object mirroring
// the ACTIVE plugin. Never throws E_NO_PLUGIN: an absent plugin is reported as
// connected:false so `status` stays a diagnosis tool, not another command that
// fails when nobody's listening.
import { PROTOCOL_VERSION } from '../../../shared/protocol.ts';
import { fileMatches } from '../../../shared/file-match.ts';
import type { CommandArgs } from '../figma-agent.ts';
import { fetchBrokerHello, runCommand } from '../transport/broker-client.ts';
import { ensureBroker } from '../transport/broker-discovery.ts';
import { peek } from '../transport/broker-peek.ts';
import { waitForPlugin } from '../transport/plugin-wait.ts';
import { buildDeepLink, type DeepLinkEntry } from '../transport/figma-deep-link.ts';
import { fileIdentity, readBindCache, readBindMarker } from '../transport/project-bind.ts';
import { CliError } from '../transport/protocol-helpers.ts';

// auto-connect slice 2 — `--wait`'s own default, in SECONDS (not ms — every other
// `--timeout` in this CLI is ms; this one follows the usecases.md gherkin's own
// "--timeout 5" ⇒ "5s budget" wording, so `--help`/the skill say so explicitly).
const DEFAULT_WAIT_SECONDS = 60;

/**
 * Find the bind-marker entry that `status --wait` should build a deep link from:
 * an exact fileNameSlug match for `--file` when given, else the single most-
 * recently-bound entry across every known project (an unambiguous best guess is
 * more useful than no link at all when the caller didn't say which file). Reads
 * the restart-survival cache + each project's own durable marker — the same
 * source `figma-agent bind --list` reads.
 */
function findBoundEntry(wantedFile: string | undefined): DeepLinkEntry | null {
  const cache = readBindCache();
  const wantedSlug = wantedFile ? fileIdentity(null, wantedFile) : null;
  let best: { fileKey: string | null; boundAt: number } | null = null;
  for (const projectDir of cache.projectDirs) {
    const marker = readBindMarker(projectDir);
    if (!marker) continue;
    for (const entry of marker.bindings) {
      if (wantedSlug !== null) {
        if (entry.fileNameSlug === wantedSlug) return { fileKey: entry.fileKey };
        continue;
      }
      if (!best || entry.boundAt > best.boundAt) best = { fileKey: entry.fileKey, boundAt: entry.boundAt };
    }
  }
  return wantedSlug !== null ? null : (best ? { fileKey: best.fileKey } : null);
}
// Concurrency & jobs (backlog 1.1+2.6+4.3), phase 02 §3 — each row now carries
// `runningJob`/`queueDepth` (broker-status.ts's `buildBrokerHelloData`, given a
// `jobStatusFor`). This CLI is JSON-only (no `--json` flag exists — figma-agent always
// prints one JSON object; unlike the unrelated `ui` kernel CLI), so these fields reach
// the caller simply by being present on `plugins[]` — no separate text renderer to update.
import type { PluginStatusEntryWithJob } from '../transport/broker-status.ts';

export async function run(args: CommandArgs): Promise<unknown> {
  // auto-connect slice 1 — `--peek` short-circuits BEFORE `ensureBroker()` below, which
  // spawns a broker on demand. A SessionStart hook calls this every session and must
  // never be the thing that starts a broker nobody asked for. `--json` is accepted for
  // compatibility but is a documented no-op: this CLI always prints one JSON object.
  if (args.bool('peek')) return peek();

  // auto-connect slice 2 — `--wait` MAY spawn: a plugin has nowhere to register
  // with otherwise. Unlike `--peek`, `ensureBroker()` below runs unconditionally.
  const waiting = args.bool('wait');
  const wantedFile = args.str('file');
  let waitedMs: number | undefined;

  const ad = await ensureBroker();

  if (waiting) {
    const timeoutMs = (args.num('timeout') ?? DEFAULT_WAIT_SECONDS) * 1_000;
    // Computed and printed BEFORE the wait (Hick's Law, usecases.md:128) — the
    // human's next action must be visible the instant the wait starts, not only
    // after it fails.
    const link = buildDeepLink(findBoundEntry(wantedFile));
    process.stderr.write(link.url ? `${link.url}\n` : `(no deep link: ${link.reason})\n`);
    process.stderr.write('Open the file above, then open the figma-agent plugin panel.\n');

    const result = await waitForPlugin({
      port: ad.port,
      timeoutMs,
      fileFilter: wantedFile,
      instanceFilter: args.str('instance'),
    });
    if (!result.registered) {
      throw new CliError(
        'E_NO_PLUGIN',
        `${wantedFile ?? 'no file specified'} — open Plugins > figma-agent (deep link already printed to stderr)`,
      );
    }
    waitedMs = result.waitedMs;
  }

  let hello: Record<string, unknown> = {};
  try {
    hello = await fetchBrokerHello(ad.port);
  } catch {
    /* fall back to the advertisement fields below */
  }

  const broker = {
    port: ad.port,
    pid: ad.pid,
    uptimeMs: (hello.uptimeMs as number | undefined) ?? null,
    protocolVersion: (hello.protocolV as number | undefined) ?? PROTOCOL_VERSION,
    // Sender-verification counter (backlog 2.10 / issue #15) — mirrors BROKER_HELLO's
    // own byte-identical-when-zero contract: present only once a cross-instance reply
    // has actually been discarded, so the common (zero) case stays unchanged here too.
    ...(typeof hello.senderMismatchCount === 'number' && { senderMismatchCount: hello.senderMismatchCount }),
    // Issue #7 fix round — same mirror-only-when-true contract: an operator running
    // `status` sees this the moment the one-time legacy-staging migration deferred,
    // without needing to grep the broker log.
    ...(hello.legacyMigrationDeferred === true && { legacyMigrationDeferred: true }),
  };
  const all = Array.isArray(hello.plugins) ? (hello.plugins as PluginStatusEntryWithJob[]) : [];

  // `--file` must not make the diagnosis self-contradictory: the BROKER_HELLO fields
  // below (activePlugin/pluginConnected/pluginInfo) are computed by the broker from
  // FIGMA_AGENT_FILE only, while the STATUS round-trip below now carries `expectedFile`
  // (the global --file flag, set once in figma-agent.ts main()) — so filter `plugins[]`
  // and derive activePlugin/connected LOCALLY instead of trusting the broker's env-only view.
  const plugins = wantedFile ? all.filter((p) => fileMatches(p.fileName, wantedFile, true)) : all;
  const activePlugin = wantedFile
    ? plugins[0]?.fileName ?? null                       // the file the caller asked about
    : (hello.activePlugin as string | null | undefined) ?? null;

  // The ACTIVE plugin's liveness (legacy mirror source). `pluginConnected` is true
  // only when a routable target exists (respects --file / FIGMA_AGENT_FILE).
  let connected = wantedFile ? plugins.length > 0 : hello.pluginConnected === true;
  let state = (hello.pluginState as string | undefined) ?? (connected ? 'connected' : 'disconnected');
  let lastHeartbeatAge = (hello.lastHeartbeatAge as number | null | undefined) ?? null;
  let scene: Record<string, unknown> | null =
    hello.pluginInfo && typeof hello.pluginInfo === 'object' ? (hello.pluginInfo as Record<string, unknown>) : null;

  // Enrich the ACTIVE plugin with a live STATUS round-trip (user, pluginVersion…).
  if (connected) {
    try {
      const s = await runCommand('STATUS', {});
      if (s && typeof s === 'object') scene = { ...(scene ?? {}), ...(s as Record<string, unknown>) };
    } catch (err) {
      // Raced: the active plugin left between the hello and the STATUS round-trip
      // (E_NO_PLUGIN), or the file the caller named no longer matches what answered
      // (E_WRONG_FILE) — either way `status` stays a diagnosis tool that never fails.
      if (!(err instanceof CliError && (err.code === 'E_NO_PLUGIN' || err.code === 'E_WRONG_FILE'))) throw err;
      connected = false;
      state = 'disconnected';
      lastHeartbeatAge = null;
      scene = null;
    }
  }

  // Legacy compat shim: `plugin` mirrors the ACTIVE plugin so design-os `_status_text`
  // and older consumers (which read `plugin.connected`) keep working unchanged.
  const plugin = { connected, state, lastHeartbeatAge, ...(scene ?? {}) };

  // Keep the full list available when `--file` filtered `plugins[]`, so the user can
  // still see what IS connected even though it doesn't match what they asked about.
  return {
    broker, plugins, activePlugin, plugin, protocolVersion: broker.protocolVersion,
    ...(wantedFile ? { pluginsAll: all } : {}),
    // Broker-restart reconnect visibility — a HINT from last-known state, never a live
    // plugin (it must never appear in `plugins`/`pluginsAll` above); present only when
    // the broker actually has one to report, same mirror-only-when-non-empty contract
    // as `senderMismatchCount`/`legacyMigrationDeferred` on `broker` above.
    ...(Array.isArray(hello.awaitingReconnect) && hello.awaitingReconnect.length > 0
      && { awaitingReconnect: hello.awaitingReconnect }),
    // auto-connect slice 2 — present only when `--wait` actually waited (mirror-only-
    // when-relevant contract, same as the fields above).
    ...(waitedMs !== undefined && { waitedMs }),
  };
}
