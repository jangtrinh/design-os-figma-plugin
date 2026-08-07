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

  it('strips a state suffix — a state has no frame of its own', () => {
    const plan = planFlow(CHECKOUT, 'fallback');
    const t3 = plan.edges.find((e) => e.transitionId === 't3');
    expect(t3).toMatchObject({ fromScreen: 'checkout', toScreen: 'confirm', trigger: 'AFTER_DELAY' });
  });

  it('labels with the trigger and leaves the guard off the canvas', () => {
    const plan = planFlow(CHECKOUT, 'fallback');
    expect(plan.edges.every((e) => !JSON.stringify(e).includes('payment.ok'))).toBe(true);
  });
});

describe('nothing is dropped without a reason', () => {
  it('records a self-transition as skipped rather than omitting it', () => {
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
