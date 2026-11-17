export interface FakeNode {
  id: string;
  name: string;
  type: string;
  fills?: unknown;
  pluginData: Record<string, string>;
  setPluginData(k: string, v: string): void;
}

export function makeNode(over: Partial<FakeNode> = {}): FakeNode {
  const node: FakeNode = {
    id: over.id ?? '1:2',
    name: over.name ?? 'Hero',
    type: over.type ?? 'RECTANGLE',
    fills: 'fills' in over ? over.fills : [],
    pluginData: {},
    setPluginData(k, v) { this.pluginData[k] = v; },
  };
  if (!('fills' in over)) node.fills = [];
  else if (over.fills === undefined) delete (node as Partial<FakeNode>).fills;
  return node;
}
