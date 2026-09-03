// The boot sequence's control flow, lifted out of main.ts so its failure semantics are
// testable without a sandbox.
//
// The distinction it exists to hold: gap-fill is ONE report about the window the plugin was
// closed, while `figma.on('documentchange')` is the whole session's live capture. Before
// this seam both hung off a single `.then`, so one page refusing to walk during the boot
// diff rejected the chain and the subscription never ran — the session lost every live edit
// too, for a failure that only ever concerned one page's history.
export interface BootCaptureDeps {
  /** `figma.loadAllPagesAsync` — the dynamic-page precondition for subscribing at all. */
  loadAllPages: () => Promise<void>;
  /** The closed-window report: diff, post, legacy clear. Free to reject. */
  gapfill: () => Promise<void>;
  subscribe: () => void;
  notify: (message: string) => void;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runBootCapture(deps: BootCaptureDeps): Promise<void> {
  try {
    await deps.loadAllPages();
  } catch (err) {
    // Subscribing before every page is loaded is exactly what the dynamic-page manifest
    // forbids, so this failure genuinely does disable capture — and says so.
    deps.notify(`live-sync capture disabled: ${messageOf(err)}`);
    return;
  }
  try {
    await deps.gapfill();
  } catch (err) {
    // Announced, never silent, and deliberately NOT worded as "capture disabled": what was
    // lost is one reconnect report, and the subscription below still happens.
    deps.notify(`live-sync gap-fill skipped: ${messageOf(err)}`);
  }
  try {
    deps.subscribe();
  } catch (err) {
    deps.notify(`live-sync capture disabled: ${messageOf(err)}`);
  }
}
