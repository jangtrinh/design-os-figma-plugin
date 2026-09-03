// Which CommandName values seal their own undo step (backlog 2.4). Pure — no `figma` access —
// specifically so this classification is unit-testable in isolation: main.ts itself cannot be
// imported outside a live plugin sandbox (it calls `figma.showUI(__html__, …)` at module load).
//
// Closing round (R3, stage-4 wave) — moved from plugin/src/main/mutating-commands.ts to
// shared/: this IS a protocol-level CommandName classification, the natural home for it
// alongside protocol.ts, and the CLI (broker-client.ts's --read-only hardening) needs it
// too. Living under plugin/src/main previously meant the CLI reached across a cli→plugin
// edge to import it — harmless today (this file has zero `figma` dependency) but an edge
// that invites a non-pure import down the line. shared/ has no such boundary to cross.
import type { CommandName } from './protocol';

/**
 * The only commands that can bypass broker mutation admission. This is intentionally
 * separate from undo-step classification: it describes broker-visible effects, not
 * whether a plugin command calls `figma.commitUndo()`.
 */
export const BROKER_SAFE_READ_COMMANDS: readonly CommandName[] = [
  'STATUS',
  'GET_SELECTION',
  'GET_CONTEXT',
  'EXPORT_PNG',
  'SCAN_DESIGN_SYSTEM',
  'GET_CORRECTION_MEMORY',
  'LIST_CONNECTIONS',
  'VERIFY_CONNECTIONS',
  'SHADER_GRADIENT_PROBE',
];

export function isBrokerSafeRead(command: string): command is CommandName {
  return (BROKER_SAFE_READ_COMMANDS as readonly string[]).includes(command);
}

// Each successful mutating command becomes its own undo step. Without commitUndo, Figma's
// default makes an entire agent session ONE ⌘Z. BATCH is absent deliberately: its children
// commit individually (inside runBatch), which is the granularity a user wants. Read-only
// commands never commit.
export const MUTATING_COMMANDS: readonly CommandName[] = [
  'CREATE_FRAME', 'CREATE_INSTANCE', 'SET_VARIANT', 'CREATE_VARIABLE', 'BIND_VARIABLE',
  'SET_AUTOLAYOUT', 'SET_CONSTRAINTS', 'SET_TEXT', 'CLONE_TRAITS', 'SET_CORRECTION_MEMORY',
  'EXEC_JS', 'IMPORT_PAYLOAD', 'CONNECT', 'DISCONNECT', 'REROUTE',
  // IMPORT_GRADIENT writes an image fill and plugin data onto an existing node —
  // its own undo step, so one ⌘Z removes the bake and restores the previous fills.
  // SHADER_GRADIENT itself is absent for the same reason HTML_TO_FIGMA is: it never
  // reaches main (it arrives as IMPORT_GRADIENT after the UI renders).
  'IMPORT_GRADIENT',
];
// Not in the set (nothing to seal into an undo step): STATUS, GET_SELECTION, GET_CONTEXT,
// SCAN_DESIGN_SYSTEM, AUDIT_DS, GET_CORRECTION_MEMORY, EXPORT_PNG, HTML_TO_FIGMA, BATCH.
// AUDIT_DS does move the user's current page (executor-audit.ts walks pages via
// setCurrentPageAsync and does not restore the original) — page navigation is not
// undoable, so a commit would do nothing. Excluded on that basis, not on innocence.
// SET_CORRECTION_MEMORY IS in the set — it writes figma.root.setSharedPluginData
// (correction-edge-store.ts:28-31). HTML_TO_FIGMA never reaches main (it arrives as
// IMPORT_PAYLOAD). BATCH itself never commits — see the note above.
