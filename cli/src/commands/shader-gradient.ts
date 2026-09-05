// `figma-agent shader-gradient` — bake an animated ShaderGradient field onto a node as
// an image fill.
//
// The config is resolved and fully validated HERE, before the broker is touched. A bad
// preset name or an out-of-enum value should cost a millisecond of local work, not a
// round-trip plus a renderer boot that ends in a failure the user then has to interpret.
// The UI re-validates what arrives, so the two can never disagree about what is legal.
import type { CommandArgs } from '../figma-agent.ts';
import { CliError } from '../transport/protocol-helpers.ts';
import { runCommand } from '../transport/broker-client.ts';
import { resolveConfig, toQueryString } from '../../../shared/shader-gradient-config.ts';
import { SHADER_GRADIENT_PRESETS } from '../../../shared/shader-gradient-presets.ts';

/**
 * Pinned renderer, recorded onto the node so a stale bake stays identifiable.
 * The PUBLISHED version — upstream's package.json at the read revision says 2.4.24,
 * which was never released and 404s everywhere. Keep this in step with
 * RENDERER_VERSION in plugin/src/ui/gradient-render-document.ts.
 */
const RENDERER = '@shadergradient/react@2.4.20';

export async function run(args: CommandArgs): Promise<unknown> {
  if (args.bool('list')) {
    return {
      presets: Object.entries(SHADER_GRADIENT_PRESETS).map(([slug, p]) => ({
        slug,
        name: p.name,
        mesh: p.props.type,
        light: p.props.lightType,
        grain: p.props.grain === 'on',
      })),
    };
  }

  if (args.bool('self-test')) {
    // Read-only: renders a tiny field in the plugin UI and reports whether this
    // environment can bake at all. It exists because the only other way to answer that
    // question is to bake onto the user's real canvas and look at the result.
    const probe = (await runCommand(
      'SHADER_GRADIENT_PROBE',
      { props: SHADER_GRADIENT_PRESETS['halo']!.props, width: 64, height: 64 },
      { timeoutMs: args.num('timeout'), readOnly: true },
    )) as { renderable?: boolean; code?: string; message?: string; ms?: number; bytes?: number };

    if (probe.renderable === true) {
      return { selfTest: 'pass', renderable: true, ms: probe.ms, bytes: probe.bytes, renderer: RENDERER };
    }
    // A reachable-but-unable environment is a real answer, so this reports rather than
    // throwing — and it names the remedy per stage, since the codes are easy to confuse.
    const hint = probe.code === 'E_NO_WEBGL'
      ? "this Figma client's plugin iframe grants no WebGL context — the bake cannot work here"
      : probe.code === 'E_RENDER_SCRIPT' || probe.code === 'E_IFRAME_LOAD'
        ? 'the renderer could not be fetched — check network access to the pinned CDN'
        : 'the renderer loaded but produced no usable frame';
    return { selfTest: 'fail', renderable: false, code: probe.code, message: probe.message, hint, renderer: RENDERER };
  }

  const preset = args.str('preset');
  const url = args.str('url');
  const rawSet = args.str('set');
  const overrides = rawSet === undefined ? undefined : rawSet.split(',').map((s) => s.trim()).filter((s) => s !== '');

  const resolved = resolveConfig({ preset, url, overrides });
  if (!resolved.ok) throw new CliError('E_INVALID_ARGS', resolved.message);

  const node = args.str('node');
  const width = args.num('w') ?? 1200;
  const height = args.num('h') ?? 800;
  const scale = args.num('scale') ?? 2;

  if (width <= 0 || height <= 0) throw new CliError('E_INVALID_ARGS', '--w and --h must be positive');
  // Figma rejects an image beyond 4096px on a side; catching it here names the real
  // cause instead of surfacing a generic plugin error after a full render.
  const maxSide = Math.max(width, height) * scale;
  if (maxSide > 4096) {
    throw new CliError(
      'E_INVALID_ARGS',
      `--w/--h at --scale ${scale} would render ${Math.round(maxSide)}px on the long side; Figma images cap at 4096px`,
    );
  }

  const result = await runCommand(
    'SHADER_GRADIENT',
    {
      props: resolved.props,
      config: toQueryString(resolved.props),
      slug: resolved.slug,
      nodeId: node === 'selection' ? undefined : node,
      width,
      height,
      scale,
      staticFrame: args.bool('static'),
      renderer: RENDERER,
    },
    { timeoutMs: args.num('timeout') },
  );

  // Surfaced, never swallowed: a user who pasted a customize URL should be told which of
  // its settings the bake could not honour, in the same reply as the success.
  return resolved.ignored.length === 0
    ? result
    : { ...(result as Record<string, unknown>), ignoredKeys: resolved.ignored };
}
