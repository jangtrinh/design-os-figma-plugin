// Shared types for `ui.slot.*` (absorption phase-02) — pure, no logic, so every
// slot-related file can import from here without a circular dependency between them.
export interface SlotCreateOpts {
  name?: string;
  width?: number;
  height?: number;
  layoutMode?: 'NONE' | 'HORIZONTAL' | 'VERTICAL';
}

export interface SlotTarget { slotId?: string; instanceId?: string; slotName?: string }

export interface SlotAppendContent {
  sourceNodeId?: string;
  nodeType?: string;
  props?: Record<string, string | number>;
  clone?: boolean;
}

export interface SlotInfo {
  id: string; name: string; type: 'SLOT'; width: number; height: number;
  layoutMode: string; propertyKey: string | null;
  children: { id: string; name: string; type: string }[];
  variantId?: string; variantName?: string;
}
