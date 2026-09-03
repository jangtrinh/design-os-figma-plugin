// `figma-agent status` — broker {port,pid,uptime,protocolVersion} from a
// BROKER_HELLO read, plus `plugins` (one row per connected file), `activePlugin`
// (the current routing target's fileName), and a legacy `plugin` object mirroring
// the ACTIVE plugin. Never throws E_NO_PLUGIN: an absent plugin is reported as
// connected:false so `status` stays a diagnosis tool, not another command that
// fails when nobody's listening.
import { APP_READINESS_VERSION, PROTOCOL_VERSION } from '../../../shared/protocol.ts';
import { fileMatches } from '../../../shared/file-match.ts';
import type { CommandArgs } from '../figma-agent.ts';
import { fetchBrokerHello, runCommand } from '../transport/broker-client.ts';
import { ensureBroker } from '../transport/broker-discovery.ts';
import { peek, projectReadiness } from '../transport/broker-peek.ts';
import { waitForPlugin } from '../transport/plugin-wait.ts';
import { buildDeepLink, type DeepLinkEntry } from '../transport/figma-deep-link.ts';
import { fileIdentity, readBindCache, readBindMarker } from '../transport/project-bind.ts';
import { CliError } from '../transport/protocol-helpers.ts';
import { isAmbiguousFileErrorMessage } from '../transport/ambiguous-file-error.ts';
import { mergeCoverage, readSessionCoverage } from '../../../shared/session-coverage.ts';
import { brokerCoverageRows } from '../transport/broker-coverage-rows.ts';

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
    ...(hello.targetFileKeyAdmissionV === 1 && { targetFileKeyAdmissionV: 1 }),
    ...(typeof hello.appReadinessV === 'number' && { appReadinessVersion: hello.appReadinessV }),
    appReadinessVersionMatch: typeof hello.appReadinessV !== 'number'
      ? null
      : hello.appReadinessV === APP_READINESS_VERSION,
    // Sender-verification counter (backlog 2.10 / issue #15) — mirrors BROKER_HELLO's
    // own byte-identical-when-zero contract: present only once a cross-instance reply
    // has actually been discarded, so the common (zero) case stays unchanged here too.
    ...(typeof hello.senderMismatchCount === 'number' && { senderMismatchCount: hello.senderMismatchCount }),
    // Issue #7 fix round — same mirror-only-when-true contract: an operator running
    // `status` sees this the moment the one-time legacy-staging migration deferred,
    // without needing to grep the broker log.
    ...(hello.legacyMigrationDeferred === true && { legacyMigrationDeferred: true }),
  };
  const readinessVersion = typeof hello.appReadinessV === 'number' ? hello.appReadinessV : undefined;
  const all = Array.isArray(hello.plugins)
    ? (hello.plugins as PluginStatusEntryWithJob[]).map((row) => ({
        ...row,
        ...projectReadiness(row, readinessVersion),
      }))
    : [];

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
  // Present only when the STATUS round-trip below refuses with the broker's "--file
  // matched more than one connected file" shape: the number of matching rows
  // (== `plugins.length`, computed the same way the broker's own routing matched them).
  let ambiguous: number | undefined;
  // The broker's own active-target scene (the registry's scene for the instance the STATUS
  // round-trip reaches). Kept in its own const because `scene` below is merged with the
  // reply and nulled on a race, while the coverage roll-up needs the ACTIVE instance's
  // `fileKey` — the one thing that tells two same-named files apart.
  const activePluginInfo = hello.pluginInfo && typeof hello.pluginInfo === 'object'
    ? (hello.pluginInfo as Record<string, unknown>)
    : null;
  let scene: Record<string, unknown> | null = activePluginInfo;

  // Enrich the ACTIVE plugin with a live STATUS round-trip (user, pluginVersion…).
  if (connected) {
    try {
      const s = await runCommand('STATUS', {});
      if (s && typeof s === 'object') scene = { ...(scene ?? {}), ...(s as Record<string, unknown>) };
    } catch (err) {
      // Raced: the active plugin left between the hello and the STATUS round-trip
      // (E_NO_PLUGIN), the file the caller named no longer matches what answered
      // (E_WRONG_FILE), or --file named more than one connected file (the broker's
      // E_INVALID_ARGS ambiguity refusal, matched by `isAmbiguousFileErrorMessage`) — none of these
      // are a reason for `status` to fail; it stays a diagnosis tool that reports what it
      // found instead of throwing.
      const ambiguousRefusal = err instanceof CliError && err.code === 'E_INVALID_ARGS'
        && isAmbiguousFileErrorMessage(err.message);
      if (!(err instanceof CliError && (err.code === 'E_NO_PLUGIN' || err.code === 'E_WRONG_FILE' || err.code === 'E_APP_UNREADY' || ambiguousRefusal))) throw err;
      if (ambiguousRefusal) {
        // New, documented `plugin.state` value: distinct from 'disconnected' — nobody left,
        // the caller's --file just could not pick ONE of `plugins.length` live matches.
        ambiguous = plugins.length;
        connected = false;
        state = 'ambiguous';
        lastHeartbeatAge = null;
        scene = null;
      } else if (err.code !== 'E_APP_UNREADY') {
        connected = false;
        state = 'disconnected';
        lastHeartbeatAge = null;
        scene = null;
      }
    }
  }

  // The session coverage statement: the plugin's own reading of its session (carried on
  // the STATUS reply it just answered) merged with the rows only the broker can see. It
  // OVERRIDES the raw block spread in from `scene` below — the merged one is the same
  // statement plus what the plugin had no way of knowing — and it is ALWAYS present, so
  // an agent told to read `coverage` first never has to tell "nothing to report" apart
  // from "this build could not say" (that one is `complete: null`).
  //
  // The rows are attributed by FILE, not by instance: the STATUS round-trip's reply
  // carries no instance id, and two windows open on one file write to the same per-file
  // feed anyway. Everything else connected is another file whose edits are not in view.
  //
  // Attribution is by IDENTITY, never by name: `Untitled` is Figma's default file name, so
  // two connected files routinely share one, and a name-keyed roll-up would tell a clean
  // session it lost the other file's frames. `fileIdentity` is this package's one canonical
  // chain — raw fileKey when present, else a slug of the name (file-identity.ts). Honest
  // limit: two KEYLESS files sharing a name still collapse into a single identity, because
  // a name is genuinely all either of them has.
  // An ambiguous --file reached no plugin at all — nothing is IN VIEW, so no identity may
  // be excluded from `otherFiles` as "the active one". Without this, the FIRST of the
  // ambiguous matches (`plugins[0]`) would silently claim the active slot and vanish from
  // its own count, undercounting distinct connected files by one.
  const activeKeySource = ambiguous !== undefined
    ? null
    : wantedFile
      ? plugins[0] ?? null                    // the file the caller asked about
      // NOT the first row whose NAME matches: with two `Untitled`s that picks whichever
      // connected first, which is not necessarily the one that answered.
      : activePluginInfo;
  const activeId = activePlugin === null || activeKeySource === null
    ? null
    : fileIdentity(
        typeof activeKeySource.fileKey === 'string' ? activeKeySource.fileKey : null,
        typeof activeKeySource.fileName === 'string' ? activeKeySource.fileName : activePlugin,
      );
  const fileRows = activeId === null
    ? []
    : plugins.filter((p) => fileIdentity(p.fileKey, p.fileName) === activeId);
  // Other FILES, not other sessions: two windows open on one other file are one file whose
  // edits are missing from this view.
  const otherFiles = new Set(
    all.map((p) => fileIdentity(p.fileKey, p.fileName)).filter((id) => id !== activeId),
  ).size;
  const coverage = mergeCoverage(
    readSessionCoverage((scene ?? {}).coverage),
    // `--file` filters `plugins[]` and moves the full list to `pluginsAll[]` — a row must
    // point at the list that actually holds the rows its number came from.
    brokerCoverageRows({ fileRows, otherFiles, pluginsField: wantedFile ? 'pluginsAll' : 'plugins' }),
  );

  // Legacy compat shim: `plugin` mirrors the ACTIVE plugin so design-os `_status_text`
  // and older consumers (which read `plugin.connected`) keep working unchanged.
  const plugin = {
    connected, state, lastHeartbeatAge,
    ...(ambiguous !== undefined && { ambiguous }),
    ...(scene ?? {}), coverage,
  };

  // Keep the full list available when `--file` filtered `plugins[]`, so the user can
  // still see what IS connected even though it doesn't match what they asked about.
  return {
    broker, plugins, activePlugin, plugin, protocolVersion: broker.protocolVersion,
    ...(Array.isArray(hello.mutationGates) && { mutationGates: hello.mutationGates }),
    ...(hello.mutationGateStoreHealth !== null && typeof hello.mutationGateStoreHealth === 'object'
      && { mutationGateStoreHealth: hello.mutationGateStoreHealth }),
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
