// flow.json -> the deterministic edge list a canvas can be drawn from and checked against.
// Pure — no `figma`, no filesystem. The kernel owns `flow.json` and lints it; this only
// reads the part a renderer needs, so the graph stays authored in exactly one place.

import type { Point } from './connector-types';

export interface FlowEdge {
  transitionId: string;
  /** Screen ids, with any `screen.state` suffix stripped — a state is not a frame. */
  fromScreen: string;
  toScreen: string;
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

/** `checkout.loading` is a state OF the `checkout` screen; only the screen has a frame. */
function screenOf(ref: unknown): string | null {
  if (typeof ref !== 'string' || ref.trim() === '') return null;
  const [screen] = ref.trim().split('.');
  return screen || null;
}

/**
 * Read a parsed flow.json into an edge list.
 *
 * A self-transition (a screen moving between its own states) is dropped with a reason: it is
 * real in the graph and meaningless as a canvas edge, since both ends are the same frame.
 */
export function planFlow(document: unknown, fallbackName: string): FlowPlan {
  const doc = (document ?? {}) as Record<string, unknown>;
  const name = typeof doc.name === 'string' && doc.name ? doc.name : fallbackName;

  const screens: string[] = Array.isArray(doc.screens)
    ? doc.screens.map((s) => (s as Record<string, unknown>)?.id).filter((id): id is string => typeof id === 'string')
    : [];

  const edges: FlowEdge[] = [];
  const skipped: FlowPlan['skipped'] = [];
  const rawTransitions = Array.isArray(doc.transitions) ? doc.transitions : [];

  for (const [index, raw] of rawTransitions.entries()) {
    const t = (raw ?? {}) as Record<string, unknown>;
    const transitionId = typeof t.id === 'string' && t.id ? t.id : `t${index + 1}`;
    const fromScreen = screenOf(t.from);
    const toScreen = screenOf(t.to);
    if (!fromScreen || !toScreen) {
      skipped.push({ transitionId, reason: 'transition is missing a from/to screen' });
      continue;
    }
    if (fromScreen === toScreen) {
      skipped.push({ transitionId, reason: `both ends are the same screen (${fromScreen}) — a state change, not a canvas edge` });
      continue;
    }
    edges.push({
      transitionId,
      fromScreen,
      toScreen,
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
