import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildPayloadFromIframe, waitForStylesReady } from '../plugin/src/ui/converter/extract';

afterEach(() => { vi.useRealTimers(); });

describe('legacy iframe style readiness compatibility', () => {
  it('still settles after the original bounded wait when iframe DOM is unavailable', async () => {
    vi.useFakeTimers();
    let settled = false;
    const iframe = { contentDocument: null, contentWindow: null } as unknown as HTMLIFrameElement;
    void waitForStylesReady(iframe).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(settled).toBe(true);
  });

  it('keeps the empty iframe fallback data-only instead of reading the host document', () => {
    const iframe = { contentDocument: null, contentWindow: null } as unknown as HTMLIFrameElement;
    expect(buildPayloadFromIframe(iframe, 'Unavailable iframe', 640)).toMatchObject({
      version: 1,
      name: 'Unavailable iframe',
      width: 640,
      height: 900,
      rootNode: { type: 'FRAME', name: 'Page', width: 640, height: 900 },
    });
  });
});
