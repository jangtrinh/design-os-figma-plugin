// The poll-until-registered loop behind `status --wait` — unlike `broker-peek.ts`,
// this MAY spawn a broker (a plugin has nowhere to register with otherwise); the
// caller (status.ts) is responsible for `ensureBroker()` before calling this.
// Injectable clock/sleep/fetch so the timeout path is unit-testable without a real
// 500ms-stepped clock.
import { fetchBrokerHello } from './broker-client.ts';
import { fileIdentity } from './project-bind.ts';
import type { PluginStatusEntry } from '../../../shared/protocol.ts';

export interface WaitOptions {
  port: number;
  timeoutMs: number;
  /**
   * `--file` — matched via the SAME name-identity normalization
   * (`fileIdentity(null, name)`, i.e. `project-bind.ts`'s `safeSlug`) that
   * `figma-deep-link.ts`'s bind-marker lookup already uses (fix round: these two
   * halves of one `--wait` command must never disagree about which file was meant).
   */
  fileFilter?: string | null;
  /** `--instance` — matched exactly; beats `fileFilter` when both are somehow set. */
  instanceFilter?: string | null;
  /**
   * How `fileFilter` is compared against a registered plugin's fileName. Default: the
   * slug equality above (what `status --wait` pairs with its deep-link lookup). The
   * pre-dispatch admission wait passes the broker's OWN dispatch comparison instead
   * (`fileMatches(…, exact)`), because a wait satisfied by a plugin the broker will not
   * route to would hand back the very refusal the wait exists to prevent.
   */
  matchFile?: (actual: string | null | undefined, filter: string) => boolean;
  pollIntervalMs?: number;
  /** Called once, the first time a poll finds no matching plugin — the moment a caller
   *  should tell the human it is actually waiting (never fired when the first poll hits). */
  onWaiting?: () => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  fetchHello?: (port: number) => Promise<Record<string, unknown>>;
}

export interface WaitResult {
  registered: boolean;
  waitedMs: number;
  /** The BROKER_HELLO data from the poll that matched — present only when registered. */
  hello?: Record<string, unknown>;
}

const DEFAULT_POLL_MS = 500;

function slugEquals(actual: string | null | undefined, filter: string): boolean {
  return fileIdentity(null, actual ?? null) === fileIdentity(null, filter);
}

function matchesFilter(
  plugins: readonly PluginStatusEntry[],
  fileFilter?: string | null,
  instanceFilter?: string | null,
  matchFile: (actual: string | null | undefined, filter: string) => boolean = slugEquals,
): boolean {
  if (instanceFilter) return plugins.some((p) => p.instanceId === instanceFilter);
  if (fileFilter) return plugins.some((p) => matchFile(p.fileName, fileFilter));
  return plugins.length > 0;
}

/** Poll `fetchBrokerHello(port)` every `pollIntervalMs` until a matching plugin
 *  registers or `timeoutMs` elapses. A broker hiccup mid-wait (a failed fetch) is
 *  NOT a failure of the wait itself — it just tries again next tick, same as a
 *  poll that simply found nothing yet. */
export async function waitForPlugin(opts: WaitOptions): Promise<WaitResult> {
  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));
  const fetchHello = opts.fetchHello ?? fetchBrokerHello;
  const startedAt = now();
  const deadline = startedAt + opts.timeoutMs;
  let announced = false;

  for (;;) {
    let hello: Record<string, unknown> | null = null;
    try {
      hello = await fetchHello(opts.port);
    } catch {
      hello = null;
    }
    const plugins = Array.isArray(hello?.plugins) ? (hello.plugins as PluginStatusEntry[]) : [];
    if (matchesFilter(plugins, opts.fileFilter, opts.instanceFilter, opts.matchFile)) {
      return { registered: true, waitedMs: now() - startedAt, hello: hello ?? undefined };
    }
    if (now() >= deadline) {
      return { registered: false, waitedMs: now() - startedAt };
    }
    if (!announced) {
      announced = true;
      opts.onWaiting?.();
    }
    await sleep(pollMs);
  }
}
