import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountThinkingOrb, orbPresentation } from '../plugin/src/ui/thinking-orb.ts';

const healthy = {
  connection: 'connected' as const,
  connectionFailure: false,
  syncFailure: false,
  activityFailure: false,
  activityPending: false,
  syncPending: false,
};

describe('orbPresentation', () => {
  it('makes unresolved failure the highest-priority aggregate state', () => {
    for (const failure of ['connectionFailure', 'syncFailure', 'activityFailure'] as const) {
      expect(orbPresentation({ ...healthy, [failure]: true })).toEqual({
        state: 'shaping', paused: true, dimmed: false, status: 'Needs attention',
      });
    }
  });

  it('maps connection transitions and loss without fabricating health', () => {
    expect(orbPresentation({ ...healthy, connection: 'probing' })).toEqual({
      state: 'connecting', paused: false, dimmed: false, status: 'Connecting',
    });
    expect(orbPresentation({ ...healthy, connection: 'handshake' })).toEqual({
      state: 'connecting', paused: false, dimmed: false, status: 'Connecting',
    });
    expect(orbPresentation({ ...healthy, connection: 'disconnected' })).toEqual({
      state: 'connecting', paused: true, dimmed: true, status: 'Disconnected',
    });
  });

  it('maps pending work and connected rest after connection health', () => {
    expect(orbPresentation({ ...healthy, activityPending: true })).toEqual({
      state: 'working', paused: false, dimmed: false, status: 'Processing',
    });
    expect(orbPresentation({ ...healthy, syncPending: true })).toEqual({
      state: 'working', paused: false, dimmed: false, status: 'Processing',
    });
    expect(orbPresentation(healthy)).toEqual({
      state: 'breathing', paused: false, dimmed: false, status: 'Connected',
    });
  });
});

interface OrbHarness {
  target: { append(node: unknown): void };
  canvas: { removed: boolean };
  context: { clears: number };
  media: { matches: boolean; emit(): void; listeners: Set<() => void> };
  documentState: { hidden: boolean; emit(): void; listeners: Set<() => void> };
  observer: { emit(): void; disconnected: boolean };
  raf: Map<number, FrameRequestCallback>;
  cancelled: number[];
  runFrame(now?: number): void;
}

function orbHarness(hasContext = true): OrbHarness {
  const context = {
    clears: 0, fillStyle: '', strokeStyle: '', lineWidth: 0,
    setTransform() {}, clearRect() { this.clears += 1; }, beginPath() {},
    arc() {}, fill() {}, moveTo() {}, lineTo() {}, stroke() {},
  };
  const canvas = {
    width: 0, height: 0, className: '', dataset: {} as Record<string, string>, removed: false,
    setAttribute() {}, getContext: () => hasContext ? context : null, remove() { this.removed = true; },
  };
  const mediaListeners = new Set<() => void>();
  const media = {
    matches: false, listeners: mediaListeners,
    addEventListener: (_: string, fn: () => void) => mediaListeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => mediaListeners.delete(fn),
    emit: () => [...mediaListeners].forEach((fn) => fn()),
  };
  const visibilityListeners = new Set<() => void>();
  const documentState = {
    hidden: false, listeners: visibilityListeners,
    documentElement: { classList: { contains: () => false } },
    createElement: () => canvas,
    addEventListener: (_: string, fn: () => void) => visibilityListeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => visibilityListeners.delete(fn),
    emit: () => [...visibilityListeners].forEach((fn) => fn()),
  };
  let observerCallback: () => void = () => {};
  const observer = { emit: () => observerCallback(), disconnected: false };
  class FakeMutationObserver {
    constructor(callback: () => void) { observerCallback = callback; }
    observe() {}
    disconnect() { observer.disconnected = true; }
  }
  const raf = new Map<number, FrameRequestCallback>();
  const cancelled: number[] = [];
  let nextFrame = 1;
  vi.stubGlobal('document', documentState);
  vi.stubGlobal('window', { devicePixelRatio: 3, matchMedia: () => media });
  vi.stubGlobal('MutationObserver', FakeMutationObserver);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrame++; raf.set(id, callback); return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { cancelled.push(id); raf.delete(id); });
  return {
    target: { append: () => {} }, canvas, context, media, documentState, observer, raf, cancelled,
    runFrame(now = 1000): void {
      const entry = raf.entries().next().value as [number, FrameRequestCallback] | undefined;
      if (!entry) throw new Error('No pending animation frame');
      raf.delete(entry[0]); entry[1](now);
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('Thinking Orb canvas lifecycle', () => {
  it('fails soft when a 2D canvas context is unavailable', () => {
    const harness = orbHarness(false);
    const controller = mountThinkingOrb(harness.target as unknown as HTMLElement);
    expect(harness.canvas.removed).toBe(true);
    expect(harness.raf.size).toBe(0);
    expect(() => controller.update(orbPresentation(healthy))).not.toThrow();
    expect(() => controller.dispose()).not.toThrow();
  });

  it('keeps at most one RAF and makes same-presentation updates a no-op', () => {
    const harness = orbHarness();
    const controller = mountThinkingOrb(harness.target as unknown as HTMLElement);
    expect(harness.raf.size).toBe(0);
    controller.update(orbPresentation(healthy));
    expect(harness.raf.size).toBe(1);
    const clears = harness.context.clears;
    controller.update(orbPresentation(healthy));
    expect(harness.context.clears).toBe(clears);
    expect(harness.raf.size).toBe(1);
    harness.runFrame();
    expect(harness.raf.size).toBe(1);
  });

  it('pauses for state, reduced motion, and document visibility', () => {
    const harness = orbHarness();
    const controller = mountThinkingOrb(harness.target as unknown as HTMLElement);
    controller.update(orbPresentation(healthy));
    controller.update(orbPresentation({ ...healthy, activityFailure: true }));
    expect(harness.raf.size).toBe(0);
    controller.update(orbPresentation(healthy));
    harness.media.matches = true; harness.media.emit();
    expect(harness.raf.size).toBe(0);
    harness.media.matches = false; harness.media.emit();
    harness.documentState.hidden = true; harness.documentState.emit();
    expect(harness.raf.size).toBe(0);
    expect(harness.context.clears).toBeGreaterThan(3);
  });

  it('refreshes on motion, visibility, and theme changes, then disposes everything', () => {
    const harness = orbHarness();
    const controller = mountThinkingOrb(harness.target as unknown as HTMLElement);
    controller.update(orbPresentation(healthy));
    const clears = harness.context.clears;
    harness.media.emit(); harness.documentState.emit(); harness.observer.emit();
    expect(harness.context.clears).toBe(clears + 3);
    expect(harness.raf.size).toBe(1);
    controller.dispose();
    expect(harness.raf.size).toBe(0);
    expect(harness.cancelled.length).toBeGreaterThan(0);
    expect(harness.observer.disconnected).toBe(true);
    expect(harness.media.listeners.size).toBe(0);
    expect(harness.documentState.listeners.size).toBe(0);
    expect(harness.canvas.removed).toBe(true);
  });
});
