// flow.json -> the deterministic edge list a canvas can be drawn from and checked against.
// Pure — no `figma`, no filesystem. The kernel owns `flow.json` and lints it; this only
// reads the part a renderer needs, so the graph stays authored in exactly one place.

import type { Point } from './connector-types';

export interface FlowEdge {
  transitionId: string;
  /** The FRAME NAME each end resolves to. */
  fromScreen: string;
  toScreen: string;
  /** The reference as authored (`checkout` or `checkout.loading`), for reporting. */
  fromRef: string;
  toRef: string;
  /** What the label reads. The guard is deliberately left off: a canvas full of `!payment.ok` stops reading as a flow. */
  trigger: string | null;
}

export interface FlowPlan {
  name: string;
  screens: string[];
  edges: FlowEdge[];
  /** Transitions dropped, and why — never a silent skip. */
  skipped: Array<{ transitionId: string; reason: string }>;
}

/**
 * Resolve `checkout` or `checkout.loading` to the FRAME NAME it should attach to.
 *
 * By default a screen id IS the frame name, which is what a kebab-case file already does
 * (`quota-profile-list`). A file that names frames for humans — `LLM Gateway · Consumer
 * (Filter drawer)` — declares the mapping explicitly on the screen instead:
 *
 *   { "id": "checkout", "frame": "LLM Gateway · Consumer",
 *     "stateFrames": { "loading": "LLM Gateway · Consumer (Loading)" } }
 *
 * Explicit, because the alternative is pattern-matching separators and silently attaching to
 * the wrong frame — and a diagram that is confidently wrong is worse than one that refuses.
 * A state with no frame of its own falls back to its screen's frame, which is the common case.
 */
function frameFor(ref: unknown, screens: Map<string, ScreenSpec>): { frame: string; ref: string } | null {
  if (typeof ref !== 'string' || ref.trim() === '') return null;
  const trimmed = ref.trim();
  const dot = trimmed.indexOf('.');
  const screenId = dot === -1 ? trimmed : trimmed.slice(0, dot);
  const state = dot === -1 ? null : trimmed.slice(dot + 1);
  if (!screenId) return null;
  const spec = screens.get(screenId);
  const stateFrame = state && spec?.stateFrames ? spec.stateFrames[state] : undefined;
  return { frame: stateFrame ?? spec?.frame ?? screenId, ref: trimmed };
}

interface ScreenSpec { id: string; frame?: string; stateFrames?: Record<string, string> }

/**
 * Read a parsed flow.json into an edge list.
 *
 * A transition whose ends land on ONE frame is dropped with a reason: it is real in the graph
 * and has nothing to point at on the canvas. Whether two states share a frame is a property of
 * the file being drawn into, not of the graph — hence the resolution above.
 */
export function planFlow(document: unknown, fallbackName: string): FlowPlan {
  const doc = (document ?? {}) as Record<string, unknown>;
  const name = typeof doc.name === 'string' && doc.name ? doc.name : fallbackName;

  const rawScreens = Array.isArray(doc.screens) ? doc.screens : [];
  const screenSpecs = new Map<string, ScreenSpec>();
  for (const raw of rawScreens) {
    const spec = (raw ?? {}) as Record<string, unknown>;
    if (typeof spec.id !== 'string' || !spec.id) continue;
    screenSpecs.set(spec.id, {
      id: spec.id,
      frame: typeof spec.frame === 'string' && spec.frame ? spec.frame : undefined,
      stateFrames: (spec.stateFrames && typeof spec.stateFrames === 'object')
        ? spec.stateFrames as Record<string, string>
        : undefined,
    });
  }
  const screens: string[] = [...screenSpecs.keys()];

  const edges: FlowEdge[] = [];
  const skipped: FlowPlan['skipped'] = [];
  const rawTransitions = Array.isArray(doc.transitions) ? doc.transitions : [];

  for (const [index, raw] of rawTransitions.entries()) {
    const t = (raw ?? {}) as Record<string, unknown>;
    const transitionId = typeof t.id === 'string' && t.id ? t.id : `t${index + 1}`;
    const from = frameFor(t.from, screenSpecs);
    const to = frameFor(t.to, screenSpecs);
    if (!from || !to) {
      skipped.push({ transitionId, reason: 'transition is missing a from/to screen' });
      continue;
    }
    // Skip on the resolved FRAME, not on the screen id: a file that draws each data state as
    // its own frame has a real, drawable edge between two states of one screen. Deciding this
    // on the screen id alone would silently drop those.
    if (from.frame === to.frame) {
      skipped.push({ transitionId, reason: `both ends resolve to the same frame "${from.frame}" — a state change with no second frame to point at` });
      continue;
    }
    edges.push({
      transitionId,
      fromScreen: from.frame,
      toScreen: to.frame,
      fromRef: from.ref,
      toRef: to.ref,
      trigger: typeof t.trigger === 'string' && t.trigger ? t.trigger : null,
    });
  }

  return { name, screens, edges, skipped };
}

/**
 * Do two routes describe the same line?
 *
 * Never compare serialized paths: Figma re-serializes floats on read-back and live bounding
 * boxes accumulate transform error, so byte equality reports drift that is not there — and a
 * checker that cries wolf is worse than no checker, because the real drift hides in the noise.
 */
export function routesMatch(a: readonly Point[], b: readonly Point[], epsilon = 0.5): boolean {
  if (a.length !== b.length) return false;
  return a.every((point, i) => Math.abs(point.x - b[i].x) <= epsilon && Math.abs(point.y - b[i].y) <= epsilon);
}
