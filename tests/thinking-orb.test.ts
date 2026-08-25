import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountThinkingOrb, orbPresentation } from '../plugin/src/ui/thinking-orb.ts';
import { orbHarness, workerHarness } from './helpers/thinking-orb-harness.ts';

const healthy = {
  connection: 'connected' as const,
  connectionFailure: false,
  syncFailure: false,
  activityFailure: false,
  pendingTools: [] as string[],
  syncPending: false,
};

describe('orbPresentation', () => {
  it('makes unresolved failure the highest-priority aggregate state', () => {
    const activeTransport = {
      ...healthy, connection: 'handshake' as const,
      pendingTools: ['SCAN_DESIGN_SYSTEM'], syncPending: true,
    };
    for (const failure of ['connectionFailure', 'syncFailure', 'activityFailure'] as const) {
      expect(orbPresentation({ ...activeTransport, [failure]: true })).toEqual({
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

  it('maps one command, sync, concurrency, fallback, and connected rest', () => {
    expect(orbPresentation({ ...healthy, pendingTools: ['SCAN_DESIGN_SYSTEM'] })).toEqual({
      state: 'searching', paused: false, dimmed: false, status: 'Searching',
    });
    expect(orbPresentation({ ...healthy, syncPending: true })).toEqual({
      state: 'weaving', paused: false, dimmed: false, status: 'Syncing',
    });
    expect(orbPresentation({ ...healthy, pendingTools: ['RECONCILE'], syncPending: true })).toEqual({
      state: 'weaving', paused: false, dimmed: false, status: 'Syncing',
    });
    expect(orbPresentation({ ...healthy, pendingTools: ['SCAN_DESIGN_SYSTEM', 'RECONCILE'], syncPending: true }).status).toBe('2 tasks running');
    expect(orbPresentation({ ...healthy, pendingTools: ['RECONCILE', 'RECONCILE'], syncPending: true }).status).toBe('2 tasks running');
    expect(orbPresentation({ ...healthy, pendingTools: ['AUDIT_DS'], syncPending: true })).toEqual({
      state: 'weaving', paused: false, dimmed: false, status: '2 tasks running',
    });
    expect(orbPresentation({ ...healthy, pendingTools: ['SET_TEXT', 'SET_TEXT'] })).toEqual({
      state: 'weaving', paused: false, dimmed: false, status: '2 tasks running',
    });
    expect(orbPresentation({ ...healthy, pendingTools: ['FUTURE_COMMAND'] })).toEqual({
      state: 'working', paused: false, dimmed: false, status: 'Processing',
    });
    expect(orbPresentation(healthy)).toEqual({
      state: 'breathing', paused: false, dimmed: false, status: 'Connected',
    });
  });

  it('keeps failure and transport above semantic work', () => {
    const working = { ...healthy, pendingTools: ['SCAN_DESIGN_SYSTEM'] };
    expect(orbPresentation({ ...working, connection: 'handshake' }).status).toBe('Connecting');
    expect(orbPresentation({ ...working, connection: 'disconnected' }).status).toBe('Disconnected');
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('Thinking Orb canvas lifecycle', () => {
  it('moves the exact animation loop off the UI thread when worker canvas is supported', () => {
    const harness = workerHarness();
    const controller = mountThinkingOrb(harness.target as unknown as HTMLElement, {
      workerSource: 'self.onmessage = () => {};',
    });
    controller.update(orbPresentation(healthy));
    expect(harness.raf.size).toBe(0);
    expect(harness.worker.messages.length).toBeGreaterThanOrEqual(2);
    expect(harness.worker.messages[0]).toMatchObject({ type: 'init', canvas: harness.transferred });
    controller.dispose();
    expect(harness.worker.terminated).toBe(true);
  });

  it('terminates the worker and restores the main-thread renderer when init is refused', () => {
    const harness = workerHarness(true);
    const controller = mountThinkingOrb(harness.target as unknown as HTMLElement, {
      workerSource: 'self.onmessage = () => {};',
    });
    expect(harness.worker.terminated).toBe(true);
    controller.update(orbPresentation(healthy));
    expect(harness.raf.size).toBe(1);
    controller.dispose();
  });

  it('replaces a transferred canvas after an asynchronous worker failure', () => {
    const harness = workerHarness();
    const controller = mountThinkingOrb(harness.target as unknown as HTMLElement, {
      workerSource: 'self.onmessage = () => {};',
    });
    harness.worker.emitError();
    expect(harness.worker.terminated).toBe(true);
    controller.update(orbPresentation(healthy));
    expect(harness.raf.size).toBe(1);
    controller.dispose();
  });

  it('falls back when the browser refuses to create a worker blob', () => {
    const harness = workerHarness();
    vi.stubGlobal('Blob', class { constructor() { throw new Error('blob refused'); } });
    let controller: ReturnType<typeof mountThinkingOrb> | undefined;
    expect(() => { controller = mountThinkingOrb(harness.target as unknown as HTMLElement, {
      workerSource: 'self.onmessage = () => {};',
    }); }).not.toThrow();
    controller?.update(orbPresentation(healthy));
    expect(harness.raf.size).toBe(1);
    controller?.dispose();
  });

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
