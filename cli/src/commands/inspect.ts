import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { CommandArgs } from '../figma-agent.ts';
import { runCommand } from '../transport/broker-client.ts';
import { scanNodeSpec, resolveScanTimeout } from './scan-node.ts';
import { resolveSafeTarget } from '../../../shared/safe-target.ts';
import type { CorrectionEvent } from '../../../shared/supervised-memory.ts';
import { staticRenderNote, visualCheckContract, type StaticRenderNote } from '../../../shared/code-layer-static-export.ts';

interface SelectionReply {
  selection?: { id?: string }[];
}

type Runner = typeof runCommand;

export async function inspectTarget(input: {
  explicit?: string;
  out?: string;
  scale?: number;
  timeout?: number;
}, runner: Runner = runCommand): Promise<unknown> {
  const selected = input.explicit ? [] : ((await runner('GET_SELECTION', { depth: 0 })) as SelectionReply)
    .selection?.flatMap((node) => node.id ? [node.id] : []) ?? [];
  const recent = input.explicit || selected.length > 0
    ? []
    : ((await runner('GET_CORRECTION_MEMORY', {}, { activity: 'Resolve recent target' })) as {
      events?: CorrectionEvent[];
    }).events?.slice().sort((a, b) => b.timestamp.localeCompare(a.timestamp)).map((event) => event.nodeId) ?? [];
  const target = resolveSafeTarget({ explicit: input.explicit, selection: selected, recent });
  const timeout = resolveScanTimeout(input.timeout);
  const structure = await scanNodeSpec(target.nodeId, timeout, runner, `Inspect · ${target.nodeId}`);
  const image = await runner('EXPORT_PNG', {
    nodeId: target.nodeId,
    scale: input.scale ?? 1,
  }, { activity: `Inspect screenshot · ${target.nodeId}` }) as { base64: string; w: number; h: number; staticRender?: StaticRenderNote };
  // The plugin flags a static render itself; the scanned source type covers a plugin
  // build that predates the flag, so an old panel cannot make an empty PNG look checked.
  const staticRender = image.staticRender
    ?? staticRenderNote((structure as { figmaScanSourceType?: unknown } | null)?.figmaScanSourceType);
  const defaultPath = join(tmpdir(), `figma-inspect-${target.nodeId.replace(/[^a-z0-9]+/gi, '-')}.png`);
  const screenshotPath = resolve(input.out ?? defaultPath);
  writeFileSync(screenshotPath, Buffer.from(image.base64, 'base64'));
  return {
    nodeId: target.nodeId,
    targetSource: target.source,
    structure,
    visualArtifact: {
      type: 'image/png',
      path: screenshotPath,
      width: image.w,
      height: image.h,
      required: true,
      contract: visualCheckContract(staticRender),
      ...(staticRender && { reliable: false, reason: staticRender.reason }),
    },
  };
}

export async function run(args: CommandArgs): Promise<unknown> {
  return inspectTarget({
    explicit: args.str('node') ?? args.positionals[0],
    out: args.str('out'),
    scale: args.num('scale'),
    timeout: args.num('timeout'),
  });
}
