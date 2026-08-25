import type { OrbPresentation, ThinkingOrbController } from './thinking-orb';

interface WorkerHostOptions {
  canvas: HTMLCanvasElement;
  source: string;
  reducedMotion: MediaQueryList;
  getPresentation(): OrbPresentation;
  setPresentation(next: OrbPresentation): void;
  isDark(): boolean;
  mountFallback(): ThinkingOrbController;
}

const READY_TIMEOUT_MS = 5000;

export function mountThinkingOrbWorker(options: WorkerHostOptions): ThinkingOrbController | null {
  const transferable = options.canvas as HTMLCanvasElement & {
    transferControlToOffscreen?: () => OffscreenCanvas;
  };
  if (!options.source || typeof Worker === 'undefined' || !transferable.transferControlToOffscreen) return null;
  let blobUrl: string | null = null;
  let worker: Worker | null = null;
  let transferred = false;
  try {
    blobUrl = URL.createObjectURL(new Blob([options.source], { type: 'text/javascript' }));
    worker = new Worker(blobUrl);
    const offscreen = transferable.transferControlToOffscreen();
    transferred = true;
    let fallback: ThinkingOrbController | null = null;
    let disposed = false;
    let ready = false;
    let readyTimer: ReturnType<typeof setTimeout> | null = null;
    const state = () => ({
      presentation: options.getPresentation(), dark: options.isDark(),
      dpr: window.devicePixelRatio || 1, hidden: document.hidden,
      reducedMotion: options.reducedMotion.matches,
    });
    const observer = new MutationObserver(() => refresh());
    const cleanup = (): void => {
      if (readyTimer !== null) clearTimeout(readyTimer);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('resize', refresh);
      options.reducedMotion.removeEventListener('change', refresh);
      observer.disconnect();
      worker?.terminate();
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
    const failover = (): void => {
      if (disposed || fallback) return;
      cleanup();
      options.canvas.remove();
      fallback = options.mountFallback();
      fallback.update(options.getPresentation());
    };
    const refresh = (): void => {
      if (fallback) { fallback.update(options.getPresentation()); return; }
      try { worker?.postMessage({ type: 'update', ...state() }); } catch { failover(); }
    };
    worker.onmessage = (event): void => {
      if ((event.data as { type?: string } | null)?.type !== 'ready') return;
      ready = true;
      if (readyTimer !== null) clearTimeout(readyTimer);
    };
    worker.onerror = failover;
    worker.onmessageerror = failover;
    worker.postMessage({ type: 'init', canvas: offscreen, ...state() }, [offscreen]);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('resize', refresh);
    options.reducedMotion.addEventListener('change', refresh);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    if (!ready) readyTimer = setTimeout(failover, READY_TIMEOUT_MS);
    return {
      update(next): void {
        const current = options.getPresentation();
        if (next.state === current.state && next.paused === current.paused
            && next.dimmed === current.dimmed && next.status === current.status) return;
        options.setPresentation(next);
        options.canvas.dataset.dimmed = String(next.dimmed);
        refresh();
      },
      dispose(): void {
        disposed = true;
        if (fallback) fallback.dispose(); else { cleanup(); options.canvas.remove(); }
      },
    };
  } catch {
    worker?.terminate();
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    if (transferred) {
      options.canvas.remove();
      const fallback = options.mountFallback();
      fallback.update(options.getPresentation());
      return fallback;
    }
    return null;
  }
}
