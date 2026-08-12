// `figma-agent cowork [--wait S] [--timeout S] [--file F]` — wait for ONE designer
// change-cycle. Broker-terminal (COWORK is never forwarded to a plugin — see
// broker-daemon.ts's handleCowork, same precedent as PROJECT_BIND/JOB): the broker
// already watches every EDIT_FEED batch, actor-labelled, so this needs zero plugin
// change. `--wait`/`--timeout` are in SECONDS (matching `status --wait`'s own
// precedent — every OTHER `--timeout` in this CLI is ms).
import type { CommandArgs } from '../figma-agent.ts';
import { runCommand } from '../transport/broker-client.ts';
import { editSentence } from '../../../shared/edit-vocabulary.ts';
import type { EditInput } from '../../../shared/edit-feed.ts';
import { DEFAULT_COWORK_TIMEOUT_SECONDS, DEFAULT_COWORK_WAIT_SECONDS } from '../../../shared/protocol.ts';
import type { CorrectionEvent } from '../../../shared/supervised-memory.ts';

interface CoworkWireResult {
  cycles: number;
  quietMs: number;
  waitedMs: number;
  file: string | null;
  edits: EditInput[];
  ambiguousCount?: number;
}

interface CoworkEditOutput {
  nodeId: string;
  nodeName: string | null;
  nodeType: string;
  parentName: string | null;
  changedProps: string[];
  page: string;
  sentence: string;
}

/**
 * `unresolved === true` AND the event's own `nodeId` (or, walking its `causalParent`
 * chain of EARLIER correction events, any ancestor's `nodeId`) lands in this cycle's
 * edited node set. `causalParent` links to another correction event's `eventId`, not
 * to a node — the chain exists for a node whose identity changed across a correction
 * (delete + recreate), so the walk checks each ancestor EVENT's own `nodeId` in turn.
 */
function isPendingForCycle(
  event: CorrectionEvent,
  editNodeIds: ReadonlySet<string>,
  byEventId: ReadonlyMap<string, CorrectionEvent>,
): boolean {
  if (event.unresolved !== true) return false;
  let cur: CorrectionEvent | undefined = event;
  const seen = new Set<string>();
  while (cur) {
    if (editNodeIds.has(cur.nodeId)) return true;
    if (!cur.causalParent || seen.has(cur.causalParent)) break;
    seen.add(cur.causalParent);
    cur = byEventId.get(cur.causalParent);
  }
  return false;
}

export async function run(args: CommandArgs): Promise<unknown> {
  const waitSeconds = args.num('wait') ?? DEFAULT_COWORK_WAIT_SECONDS;
  const timeoutSeconds = args.num('timeout') ?? DEFAULT_COWORK_TIMEOUT_SECONDS;
  const waitMs = Math.max(1, waitSeconds) * 1_000;
  const timeoutMs = Math.max(1, timeoutSeconds) * 1_000;
  // A hop buffer past the requested budget, same shape as batch.ts's own scaled
  // timeout — the WIRE round-trip must never time out before the broker's OWN
  // deadline has had a chance to fire and reply honestly.
  const wireTimeoutMs = timeoutMs + 5_000;

  const wire = await runCommand('COWORK', { waitMs, timeoutMs }, { timeoutMs: wireTimeoutMs, activity: 'Cowork' }) as CoworkWireResult;

  const edits: CoworkEditOutput[] = wire.edits.map((e) => ({
    nodeId: e.nodeId, nodeName: e.nodeName, nodeType: e.nodeType, parentName: e.parentName,
    changedProps: e.changedProps, page: e.page, sentence: editSentence(e),
  }));

  const base = {
    cycles: wire.cycles, quietMs: wire.quietMs, waitedMs: wire.waitedMs, file: wire.file, edits,
    ...(wire.ambiguousCount !== undefined && { ambiguousCount: wire.ambiguousCount }),
  };

  // Read-only ledger round trip — never SET_CORRECTION_MEMORY, never a jsonl write.
  // A plugin that dropped between quiescence and this call must report the honest
  // "unknown" (`corrections: null` + a named reason), never an empty array standing
  // in for it.
  try {
    const edgeReply = await runCommand('GET_CORRECTION_MEMORY', {}, { activity: 'Recall corrections' }) as { events?: CorrectionEvent[] };
    const events = edgeReply.events ?? [];
    const byEventId = new Map(events.map((e) => [e.eventId, e]));
    const editNodeIds = new Set(edits.map((e) => e.nodeId));
    const corrections = events.filter((e) => isPendingForCycle(e, editNodeIds, byEventId));
    return { ...base, corrections };
  } catch {
    return { ...base, corrections: null, correctionsReason: 'plugin disconnected before the ledger could be read' };
  }
}
