// Where connectors are remembered, so a redraw or a check can find them again.
//
// The in-memory copy is AUTHORITATIVE. main.ts's message handler is async, so two commands
// in flight to this plugin interleave at every await — a read-modify-write of the root's
// plugin data that spans an await is a lost update, and the loser vanishes with no error.
// So: parse once, mutate in memory, and write through synchronously in the same stretch.
// Nothing here re-reads the stored blob mid-command.

import type { ConnectionRecord } from '../../../shared/connector-types';

const NAMESPACE = 'ease_design';
const KEY = 'connections-v1';

let cache: ConnectionRecord[] | null = null;

function parse(raw: string): ConnectionRecord[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as ConnectionRecord[] : [];
  } catch {
    // A corrupt blob is not a reason to refuse every later connector. Starting empty loses
    // the index, but the connectors themselves carry their own id (see `readNodeConnectionId`)
    // so a rebuild is possible; refusing outright would leave no way back.
    return [];
  }
}

function load(): ConnectionRecord[] {
  if (cache === null) cache = parse(figma.root.getSharedPluginData(NAMESPACE, KEY));
  return cache;
}

function flush(next: ConnectionRecord[]): void {
  cache = next;
  figma.root.setSharedPluginData(NAMESPACE, KEY, JSON.stringify(next));
}

export function listConnections(): ConnectionRecord[] {
  return [...load()];
}

export function findConnection(id: string): ConnectionRecord | null {
  return load().find((record) => record.id === id) ?? null;
}

/** The existing connector between two endpoints, if one was already drawn. Direction matters. */
export function findConnectionByEndpoints(from: string, to: string): ConnectionRecord | null {
  return load().find((record) => record.from === from && record.to === to) ?? null;
}

/** Replace the record with this id, or append it. */
export function upsertConnection(record: ConnectionRecord): void {
  const next = load().filter((existing) => existing.id !== record.id);
  next.push(record);
  flush(next);
}

export function removeConnection(id: string): ConnectionRecord | null {
  const record = findConnection(id);
  if (!record) return null;
  flush(load().filter((existing) => existing.id !== id));
  return record;
}

/**
 * The connection id stamped on a connector node itself, so a node found on the canvas can
 * name its own record without a scan.
 *
 * This is also the imposter check. Copy/paste and page duplication carry plugin data along,
 * so two nodes can claim the same id — the record names exactly ONE `vectorNodeId`, and a
 * node whose own id does not match it is a copy, not the connector. Reporting that beats
 * trusting whichever node was found first.
 */
export function stampNodeConnectionId(node: SceneNode, connectionId: string): void {
  node.setSharedPluginData(NAMESPACE, 'connection_id', connectionId);
}

export function readNodeConnectionId(node: SceneNode): string {
  return node.getSharedPluginData(NAMESPACE, 'connection_id');
}

/** Drop the in-memory copy so the next read parses the document again (page/file switches). */
export function resetConnectionCache(): void {
  cache = null;
}
