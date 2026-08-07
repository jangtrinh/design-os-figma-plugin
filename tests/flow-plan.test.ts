// flow.json is the kernel's linted navigation graph; this reads the part a canvas can be
// drawn from. Pure, no `figma` global — the whole point of keeping the plan separate from
// the drawing is that the plan is checkable without a canvas.
import { describe, it, expect } from 'vitest';
import { planFlow, routesMatch } from '../shared/flow-plan.ts';

const CHECKOUT = {
  name: 'checkout',
  screens: [{ id: 'cart' }, { id: 'checkout' }, { id: 'confirm' }],
  transitions: [
    { id: 't1', from: 'cart', to: 'checkout', trigger: 'ON_CLICK' },
    { id: 't2', from: 'checkout.default', to: 'checkout.loading', trigger: 'ON_SUBMIT' },
    { id: 't3', from: 'checkout.loading', to: 'confirm', trigger: 'AFTER_DELAY', guard: 'payment.ok' },
  ],
};

describe('reading a flow into canvas edges', () => {
  it('keeps the screen-to-screen transitions', () => {
    const plan = planFlow(CHECKOUT, 'fallback');
    expect(plan.name).toBe('checkout');
    expect(plan.screens).toEqual(['cart', 'checkout', 'confirm']);
    expect(plan.edges.map((e) => e.transitionId)).toEqual(['t1', 't3']);
  });

  it('falls back to the screen frame when a state declares none', () => {
    const plan = planFlow(CHECKOUT, 'fallback');
    const t3 = plan.edges.find((e) => e.transitionId === 't3');
    expect(t3).toMatchObject({ fromScreen: 'checkout', toScreen: 'confirm', fromRef: 'checkout.loading', trigger: 'AFTER_DELAY' });
  });

  it('labels with the trigger and leaves the guard off the canvas', () => {
    const plan = planFlow(CHECKOUT, 'fallback');
    expect(plan.edges.every((e) => !JSON.stringify(e).includes('payment.ok'))).toBe(true);
  });
});

describe('nothing is dropped without a reason', () => {
  it('records a transition that lands on one frame as skipped rather than omitting it', () => {
    const plan = planFlow(CHECKOUT, 'fallback');
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0].transitionId).toBe('t2');
    expect(plan.skipped[0].reason).toContain('checkout');
  });

  it('records a transition missing an endpoint', () => {
    const plan = planFlow({ transitions: [{ id: 'tx', from: 'cart' }] }, 'fallback');
    expect(plan.edges).toHaveLength(0);
    expect(plan.skipped).toEqual([{ transitionId: 'tx', reason: 'transition is missing a from/to screen' }]);
  });

  it('names an unnamed transition by position so a report can still point at it', () => {
    const plan = planFlow({ transitions: [{ from: 'a', to: 'b' }] }, 'fallback');
    expect(plan.edges[0].transitionId).toBe('t1');
  });
});

describe('degenerate documents do not throw', () => {
  for (const [name, doc] of [['null', null], ['empty object', {}], ['a string', 'nope'], ['arrays missing', { name: 'x' }]] as const) {
    it(`${name} yields an empty plan`, () => {
      const plan = planFlow(doc, 'fallback');
      expect(plan.edges).toEqual([]);
      expect(plan.screens).toEqual([]);
    });
  }

  it('falls back to the supplied name when the document has none', () => {
    expect(planFlow({}, 'from-filename').name).toBe('from-filename');
  });
});

describe('route comparison tolerates float noise but not real movement', () => {
  const route = [{ x: 100, y: 50 }, { x: 400, y: 50 }];

  it('matches a route that differs only below the epsilon', () => {
    expect(routesMatch(route, [{ x: 100.3, y: 49.8 }, { x: 400.2, y: 50.1 }])).toBe(true);
  });

  it('reports a move larger than the epsilon', () => {
    expect(routesMatch(route, [{ x: 100, y: 50 }, { x: 401, y: 50 }])).toBe(false);
  });

  it('reports a different shape even when every shared point matches', () => {
    expect(routesMatch(route, [...route, { x: 400, y: 300 }])).toBe(false);
  });

  it('does not silently pass an empty route against a real one', () => {
    expect(routesMatch(route, [])).toBe(false);
  });
});

// Real files do not name their frames after screen ids. One page of the file this was built
// against uses kebab-case ids (`quota-profile-list`), another names frames for humans
// (`LLM Gateway · Consumer (Filter drawer)`), and a third encodes the data state in the frame
// name itself (`… — 1 · Mặc định`). Guessing a mapping from separators would attach edges to
// the wrong frame in silence, so the mapping is declared.
describe('frame mapping — the file being drawn into decides the names', () => {
  const MAPPED = {
    name: 'consumer',
    screens: [
      { id: 'list', frame: 'quota-profile-list' },
      {
        id: 'consumer',
        frame: 'LLM Gateway · Consumer',
        stateFrames: { filtering: 'LLM Gateway · Consumer (Filter drawer)' },
      },
    ],
    transitions: [
      { id: 't1', from: 'list', to: 'consumer', trigger: 'ON_CLICK' },
      { id: 't2', from: 'consumer.default', to: 'consumer.filtering', trigger: 'ON_CLICK' },
    ],
  };

  it('uses the declared frame name instead of the screen id', () => {
    const plan = planFlow(MAPPED, 'fallback');
    const t1 = plan.edges.find((e) => e.transitionId === 't1');
    expect(t1).toMatchObject({ fromScreen: 'quota-profile-list', toScreen: 'LLM Gateway · Consumer' });
  });

  it('draws a state-to-state transition when the states are separate frames', () => {
    const plan = planFlow(MAPPED, 'fallback');
    const t2 = plan.edges.find((e) => e.transitionId === 't2');
    expect(t2).toMatchObject({
      fromScreen: 'LLM Gateway · Consumer',
      toScreen: 'LLM Gateway · Consumer (Filter drawer)',
      fromRef: 'consumer.default',
      toRef: 'consumer.filtering',
    });
    expect(plan.skipped).toEqual([]);
  });

  it('still skips when both states fall back to the one frame', () => {
    const plan = planFlow({
      screens: [{ id: 'consumer', frame: 'LLM Gateway · Consumer' }],
      transitions: [{ id: 'tx', from: 'consumer.default', to: 'consumer.loading' }],
    }, 'fallback');
    expect(plan.edges).toEqual([]);
    expect(plan.skipped[0].reason).toContain('LLM Gateway · Consumer');
  });

  it('a screen id with no declared frame is still its own frame name', () => {
    const plan = planFlow({ transitions: [{ id: 't', from: 'cart', to: 'checkout' }] }, 'fallback');
    expect(plan.edges[0]).toMatchObject({ fromScreen: 'cart', toScreen: 'checkout' });
  });
});
