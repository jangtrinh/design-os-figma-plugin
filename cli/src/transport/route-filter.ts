// Which file (or instance) a request routes to, and how strictly. PURE — the daemon reads env +
// envelope and asks here, so precedence is a unit test rather than a code path only reachable
// with two Figma files open.
export type FilterSource = 'flag' | 'env' | 'none';

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
 * request, exact) > FIGMA_AGENT_FILE (per daemon) > active plugin.
 *
 * `--instance` targets a specific plugin instance by its minted, opaque instanceId — it always
 * matches 0 or 1 entries, so it is exact by construction (no substring mode makes sense for a
 * unique key). `--file` is EXACT (case-insensitive, trimmed) on purpose: it is the routing half
 * of a guard the plugin re-checks against `figma.root.name`. A substring filter could route
 * "Design" to "Design System" and then have the plugin refuse it with E_WRONG_FILE — routing and
 * guard must agree, so they use the same comparison.
 */
export function resolveRouteFilter(
  expectedFile?: string | null,
  envPin?: string | null,
  instanceFlag?: string | null,
): RouteFilter {
  const instance = instanceFlag?.trim();
  if (instance) return { value: instance, exact: true, source: 'flag', kind: 'instance' };
  const flag = expectedFile?.trim();
  if (flag) return { value: flag, exact: true, source: 'flag', kind: 'name' };
  const env = envPin?.trim();
  if (env) return { value: env, exact: false, source: 'env', kind: 'name' };
  return { value: null, exact: false, source: 'none', kind: 'name' };
}

export { fileMatches } from '../../../shared/file-match.ts';
