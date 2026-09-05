import { parseCssColor } from './color-utils';

/** Wait for runtime scripts such as Tailwind CDN to apply their styles. */
export function waitForStylesReadyInDocument(doc: Document, win: Window): Promise<void> {
  return new Promise((resolve) => {
    const maxWait = 3000;
    const pollInterval = 100;
    let elapsed = 0;
    const check = () => {
      elapsed += pollInterval;
      const body = doc.body;
      if (body) {
        const parsed = parseCssColor(win.getComputedStyle(body).backgroundColor);
        if (parsed && parsed.a > 0 && !(parsed.r === 1 && parsed.g === 1 && parsed.b === 1)) {
          resolve();
          return;
        }
      }
      let hasRuntimeStyles = false;
      try {
        for (let i = 0; i < doc.styleSheets.length; i++) {
          if (doc.styleSheets[i].cssRules && doc.styleSheets[i].cssRules.length > 50) {
            hasRuntimeStyles = true;
            break;
          }
        }
      } catch { /* cross-origin stylesheet; keep polling */ }
      if (hasRuntimeStyles) {
        setTimeout(resolve, 200);
        return;
      }
      if (elapsed < maxWait) setTimeout(check, pollInterval);
      else resolve();
    };
    setTimeout(check, 200);
  });
}

/** Compatibility wrapper for legacy same-origin iframe consumers. */
export function waitForStylesReady(iframe: HTMLIFrameElement): Promise<void> {
  return new Promise((resolve) => {
    const maxWait = 3000;
    const pollInterval = 100;
    let elapsed = 0;
    const check = () => {
      elapsed += pollInterval;
      const doc = iframe.contentDocument;
      const win = iframe.contentWindow;
      if (doc && win) {
        void waitForStylesReadyInDocument(doc, win).then(resolve);
        return;
      }
      if (elapsed < maxWait) setTimeout(check, pollInterval);
      else resolve();
    };
    check();
  });
}
