// `figma-agent changes --png <dir>` — the PNG leg of the owner-edit feed (backlog group
// 6): an AFTER export per edited node in the window so an agent can look at what the
// owner changed without re-exporting by hand, plus a BEFORE only when one honestly
// exists. The feed records edits, never pixels, so the only truthful "before" is a prior
// export of the same node sitting in `dir` whose mtime predates the earliest edit in the
// window. Anything else is reported as `before: null` with the reason — never a guess.
//
// Read-only: EXPORT_PNG is a broker safe read (bypasses the mutation FIFO). Files are
// `<dir>/<node-id-stem>.after.png` / `.before.png`; a qualifying prior `.after.png` is
// renamed to `.before.png` AFTER the new export succeeds, so a failed export never moves
// anything. Deleted nodes and nodes the plugin cannot find are listed as skipped with a
// reason; a transport failure aborts (an empty success would be a wrong fact).
import { mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand } from '../transport/broker-client.ts';
import { CliError } from '../transport/protocol-helpers.ts';
import type { EditFrame } from '../../../shared/edit-feed.ts';

export interface ChangePngEntry {
  nodeId: string;
  nodeName: string | null;
  nodeType: string;
  after: string | null;
  before: string | null;
  beforeSource: 'prior-export' | null;
  note?: string;
}

export interface ChangePngSkipped {
  nodeId: string;
  nodeName: string | null;
  reason: string;
}

export interface ChangePngExport {
  dir: string;
  scale: number;
  exported: ChangePngEntry[];
  skipped: ChangePngSkipped[];
}

export interface ChangePngOptions {
  scale: number;
  runner?: typeof runCommand;
}

/** Failures of the transport, not of one node — retrying the next node cannot help. */
const ABORTING_CODES: ReadonlySet<string> = new Set(['E_NO_BROKER', 'E_NO_PLUGIN', 'E_TIMEOUT', 'E_VERSION_MISMATCH']);

/** `1:23` → `1-23`, `I25:3;12:4` → `I25-3-12-4` — a node id as a filename stem. */
export function pngFileStem(nodeId: string): string {
  return nodeId.replace(/[^A-Za-z0-9_.-]/g, '-');
}

function mtimeMs(path: string): number | null {
  try { return statSync(path).mtimeMs; } catch { return null; }
}

interface NodeWindow { frames: EditFrame[]; firstEditTs: number; lastOp: EditFrame['op']; }

/** Group frames per node in first-appearance order; the LAST op decides deletion. */
function groupByNode(frames: readonly EditFrame[]): Map<string, NodeWindow> {
  const groups = new Map<string, NodeWindow>();
  for (const f of frames) {
    const group = groups.get(f.nodeId);
    if (!group) groups.set(f.nodeId, { frames: [f], firstEditTs: f.ts, lastOp: f.op });
    else {
      group.frames.push(f);
      group.firstEditTs = Math.min(group.firstEditTs, f.ts);
      group.lastOp = f.op;
    }
  }
  return groups;
}

/** Which prior file (if any) is a truthful "before" for an edit first seen at `firstEditTs`. */
function resolveBefore(afterPath: string, beforePath: string, firstEditTs: number): { path: string | null; renameAfter: boolean } {
  const afterMtime = mtimeMs(afterPath);
  if (afterMtime !== null && afterMtime <= firstEditTs) return { path: beforePath, renameAfter: true };
  const beforeMtime = mtimeMs(beforePath);
  if (beforeMtime !== null && beforeMtime <= firstEditTs) return { path: beforePath, renameAfter: false };
  return { path: null, renameAfter: false };
}

export async function exportChangePngs(
  frames: readonly EditFrame[], dir: string, opts: ChangePngOptions,
): Promise<ChangePngExport> {
  const runner = opts.runner ?? runCommand;
  const exported: ChangePngEntry[] = [];
  const skipped: ChangePngSkipped[] = [];
  const groups = groupByNode(frames);
  if (groups.size > 0) mkdirSync(dir, { recursive: true });

  for (const [nodeId, group] of groups) {
    const last = group.frames[group.frames.length - 1]!;
    if (group.lastOp === 'deleted') {
      skipped.push({ nodeId, nodeName: last.nodeName, reason: 'deleted in this window — nothing to export' });
      continue;
    }
    const stem = pngFileStem(nodeId);
    const afterPath = join(dir, `${stem}.after.png`);
    const beforePath = join(dir, `${stem}.before.png`);

    let reply: { base64?: unknown } | null;
    try {
      reply = (await runner('EXPORT_PNG', { nodeId, scale: opts.scale }, {
        readOnly: true, activity: `Export · ${last.nodeName ?? nodeId}`,
      })) as { base64?: unknown } | null;
    } catch (err) {
      if (err instanceof CliError && !ABORTING_CODES.has(err.code)) {
        skipped.push({ nodeId, nodeName: last.nodeName, reason: `${err.code}: ${err.message}` });
        continue;
      }
      throw err;
    }
    if (!reply || typeof reply.base64 !== 'string') {
      skipped.push({ nodeId, nodeName: last.nodeName, reason: 'EXPORT_PNG reply missing base64 image data' });
      continue;
    }
    const before = resolveBefore(afterPath, beforePath, group.firstEditTs);
    if (before.renameAfter) renameSync(afterPath, beforePath);
    writeFileSync(afterPath, Buffer.from(reply.base64, 'base64'));
    exported.push({
      nodeId, nodeName: last.nodeName, nodeType: last.nodeType, after: afterPath,
      before: before.path, beforeSource: before.path !== null ? 'prior-export' : null,
      ...(before.path === null && { note: 'no prior export predates the edit — only the after PNG exists' }),
    });
  }
  return { dir, scale: opts.scale, exported, skipped };
}
