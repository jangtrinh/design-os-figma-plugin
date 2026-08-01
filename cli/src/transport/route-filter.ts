// Which file (or instance) a request routes to, and how strictly. PURE — the daemon reads env +
// envelope and asks here, so precedence is a unit test rather than a code path only reachable
// with two Figma files open.
//
// 'pin' (#35 P2): the panel's "Target this plugin" button sets a daemon RUNTIME pin
// (`targetInstancePin`) — a human's standing routing choice, ranked below a per-request
// flag (which always wins for that one command) but above the env pin and recency (a
// more recent, more deliberate act than either). The daemon resolves liveness BEFORE
// calling here (see `pinDisconnected`) — this module stays pure and never touches the
// registry.
export type FilterSource = 'flag' | 'env' | 'pin' | 'none';

// `value` is a file NAME under kind:'name', or an opaque instanceId under kind:'instance' — the
// registry needs this to know which comparison to run (name matching vs. instance lookup). The
// 'none' source always carries kind:'name' (unchanged: value is null, so kind is moot).
export type FilterKind = 'name' | 'instance';

export interface RouteFilter {
  value: string | null;   // trimmed; null = no restriction
  exact: boolean;         // --file/--instance must match the WHOLE value; the env pin stays a substring pin
  source: FilterSource;
  kind: FilterKind;
}

/**
 * Precedence: explicit `--instance` (per request, exact, unique) > explicit `--file` (per
 * request, exact) > the daemon's `targetInstancePin` (runtime, set by the panel's "Target
 * this plugin" button) > FIGMA_AGENT_FILE (per daemon) > active plugin.
 *
 * `--instance` targets a specific plugin instance by its minted, opaque instanceId — it always
 * matches 0 or 1 entries, so it is exact by construction (no substring mode makes sense for a
 * unique key). `--file` is EXACT (case-insensitive, trimmed) on purpose: it is the routing half
 * of a guard the plugin re-checks against `figma.root.name`. A substring filter could route
 * "Design" to "Design System" and then have the plugin refuse it with E_WRONG_FILE — routing and
 * guard must agree, so they use the same comparison.
 *
 * `pin` is the pinned instanceId, or `null`/omitted when no pin is set OR the caller has
 * already found it disconnected (see `pinDisconnected`) — this function never re-derives
 * liveness itself, matching `envPin`'s own trust-the-caller shape. Exact + kind:'instance',
 * same as `--instance`, since a pin is also a unique key.
 */
export function resolveRouteFilter(
  expectedFile?: string | null,
  envPin?: string | null,
  instanceFlag?: string | null,
  pin?: string | null,
): RouteFilter {
  const instance = instanceFlag?.trim();
  if (instance) return { value: instance, exact: true, source: 'flag', kind: 'instance' };
  const flag = expectedFile?.trim();
  if (flag) return { value: flag, exact: true, source: 'flag', kind: 'name' };
  const pinned = pin?.trim();
  if (pinned) return { value: pinned, exact: true, source: 'pin', kind: 'instance' };
  const env = envPin?.trim();
  if (env) return { value: env, exact: false, source: 'env', kind: 'name' };
  return { value: null, exact: false, source: 'none', kind: 'name' };
}

/**
 * True when a standing `targetInstancePin` applies to this request (no per-request
 * `--instance`/`--file` overrides it) AND its instance is no longer live. The caller must
 * refuse the command outright (`E_TARGET_DISCONNECTED`) rather than pass a `null` pin
 * through to `resolveRouteFilter` and let it fall through to the env pin or recency — Law
 * 1: a standing pin never silently re-points at another plugin. `pinLive` is the daemon's
 * OWN liveness check (`registry.getByInstanceId(pin)?.ws` OPEN) — this function only
 * composes that fact with the per-request-flag override rule, staying pure.
 */
export function pinDisconnected(
  expectedFile?: string | null,
  instanceFlag?: string | null,
  pin?: string | null,
  pinLive?: boolean,
): boolean {
  if (expectedFile?.trim() || instanceFlag?.trim()) return false; // a per-request flag always overrides the pin
  return Boolean(pin?.trim()) && pinLive !== true;
}

export { fileMatches } from '../../../shared/file-match.ts';
