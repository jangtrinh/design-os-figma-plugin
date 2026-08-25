import { vi } from 'vitest';

export interface OrbHarness {
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

export interface WorkerHarness extends OrbHarness {
  worker: { messages: unknown[]; terminated: boolean; emitError(): void };
  transferred: { value: true };
}

export function orbHarness(hasContext = true): OrbHarness {
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
  vi.stubGlobal('window', {
    devicePixelRatio: 3, matchMedia: () => media,
    addEventListener() {}, removeEventListener() {},
  });
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

export function workerHarness(failInit = false): WorkerHarness {
  const harness = orbHarness();
  const transferred = { value: true as const };
  Object.assign(harness.canvas, { transferControlToOffscreen: () => transferred });
  const worker = {
    messages: [] as unknown[], terminated: false,
    emitError: (): void => {},
  };
  class FakeWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    onmessageerror: (() => void) | null = null;
    constructor(_url: string) {}
    postMessage(message: unknown): void {
      worker.messages.push(message);
      if (failInit && worker.messages.length === 1) throw new Error('worker init refused');
    }
    terminate(): void { worker.terminated = true; }
  }
  let instance: FakeWorker | null = null;
  const WorkerWithCapture = class extends FakeWorker {
    constructor(url: string) { super(url); instance = this; }
  };
  worker.emitError = () => instance?.onerror?.();
  vi.stubGlobal('Worker', WorkerWithCapture);
  vi.stubGlobal('Blob', class { constructor(_parts: unknown[], _options: unknown) {} });
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:orb', revokeObjectURL: vi.fn() });
  return { ...harness, worker, transferred };
}
