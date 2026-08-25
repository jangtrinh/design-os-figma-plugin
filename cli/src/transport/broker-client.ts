// Broker client used by every CLI command: ensure broker → connect → send
// RequestMsg → await id-correlated ReplyMsg (reassembling chunked replies).
// Throws CliError {code,message}; timeouts come from shared COMMAND_TIMEOUTS.
import { unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import {
  BROKER_FILE,
  COMMAND_TIMEOUTS,
  DEFAULT_TIMEOUT_MS,
  PROTOCOL_VERSION,
  makeRequestFrame,
  makeRequestId,
  type BrokerAdvertisement,
  type CommandName,
  type FileContext,
  type JobInfo,
  type WireError,
} from '../../../shared/protocol.ts';
import { ensureBroker, isPidAlive, loopbackWsUrl } from './broker-discovery.ts';
import { isBrokerSafeRead } from '../../../shared/mutating-commands.ts';
import {
  ChunkAssembler,
  CliError,
  isChunkMsg,
  isEventMsg,
  isReplyMsg,
  parseWireMsg,
  rawToString,
  sendWireMsg,
} from './protocol-helpers.ts';

const CONNECT_TIMEOUT_MS = 4_000;
// A failed connect that isn't confirmed-dead (see isConfirmedDeadAfterFailedConnect)
// is treated as "broker was mid-accept or busy on another handshake" — retrying
// IMMEDIATELY re-attempts inside the exact window that caused the first failure.
// This delay is what actually gives that busy state room to clear.
const AMBIGUOUS_CONNECT_RETRY_DELAY_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
let requestCounter = 0;
const requestNamespace = randomBytes(8).toString('hex');

let expectedFile: string | undefined;
let expectedInstance: string | undefined;
let targetFileKey: string | undefined;
let lastFileContext: FileContext | undefined;
let projectDir: string | undefined;
let readOnlyGlobal = false;
let agentId: string | undefined;

/** Set once per CLI invocation from the global --file flag; stamped on every request envelope. */
export function setExpectedFile(name: string | undefined): void { expectedFile = name; }

/**
 * Set once per CLI invocation from the global `--instance` flag; stamped on
 * every request envelope the SAME choke point `setExpectedFile` uses. Mutual exclusion with
 * `--file` is enforced at the CLI boundary before either setter runs, so the two are never both
 * non-empty here.
 */
export function setExpectedInstance(id: string | undefined): void { expectedInstance = id; }

/** Set once per invocation from global `--target-file-key`; never inferred from any filename or reply context. */
export function setTargetFileKey(fileKey: string | undefined): void { targetFileKey = fileKey; }
export function getLastFileContext(): FileContext | undefined { return lastFileContext; }

/**
 * Set once per CLI invocation from `--dir` (or cwd); stamped on every request envelope —
 * the SAME choke point `setExpectedFile` uses (registry-integrity phase 01, §1). The broker
 * records fileIdentity → projectDir from this so panel/idle sync applies into the right
 * project instead of the daemon's spawn cwd.
 */
export function setProjectDir(dir: string | undefined): void { projectDir = dir; }

/**
 * Set once per CLI invocation from the global `--read-only` flag (concurrency & jobs,
 * backlog 1.1+2.6+4.3, phase 02 §4). A per-call runCommand readOnly value overrides this
 * global, but true is valid only for the broker's explicit safe-read allowlist.
 */
export function setReadOnly(v: boolean): void { readOnlyGlobal = v; }

/**
 * Set once per CLI invocation from the global `--agent`/`FIGMA_AGENT_ID` value; stamped
 * on every request envelope the SAME choke point `setExpectedFile` uses (auto-connect
 * slice 2). `undefined` (the default) leaves the frame byte-identical to a pre-flag CLI's.
 */
export function setAgent(id: string | undefined): void { agentId = id; }

/**
 * Stage-4 fix round (minor 8, ruling Q4) — `--read-only` is a PARTIAL hardening, not a
 * blanket promise: asserting read-only only works for the broker's exact safe-read
 * allowlist. Every other command, including EXEC_JS, is refused rather than trusting a
 * caller-provided declaration that could bypass mutation admission. Pure (no command
 * lookup outside the shared allowlist) so it is unit-testable without a live broker.
 */
export function refusesReadOnlyAssertion(wireCmd: CommandName, readOnly: boolean): boolean {
  return readOnly && !isBrokerSafeRead(wireCmd);
}

function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(loopbackWsUrl(port));
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new CliError('E_NO_BROKER', `broker connect timed out on port ${port}`));
    }, CONNECT_TIMEOUT_MS);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(new CliError('E_NO_BROKER', `broker connect failed: ${err.message}`));
    });
  });
}

// Exported (not just internal to `runCommand`) so the JOB_STATE → timeout-hint wiring
// is unit-testable with a fake socket (EventEmitter + a stubbed `send`), without needing
// a live broker connection — `runCommand`'s own `ensureBroker`/`connectWs` calls are real
// network I/O and are not the seam this behaviour needs.
export function exchange(
  ws: WebSocket,
  cmd: CommandName,
  params: unknown,
  timeoutMs: number,
  activity?: string,
  readOnly?: boolean,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = makeRequestId(++requestCounter, requestNamespace);
    const assembler = new ChunkAssembler();
    let settled = false;
    // Concurrency & jobs (backlog 1.1+2.6+4.3) — the LAST JOB_STATE seen before the reply
    // (or the timeout) lands. Remembered, not acted on immediately: the request keeps
    // waiting for its real reply exactly as before: JOB_STATE only tells the CLI its own
    // jobId in case the timeout fires first.
    let lastJob: JobInfo | undefined;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new CliError(
        'E_TIMEOUT',
        lastJob
          ? `${cmd} still running after ${timeoutMs}ms — job ${lastJob.jobId} was NOT cancelled. ` +
            `Get the result with: figma-agent job ${lastJob.jobId} --wait`
          : `${cmd} timed out after ${timeoutMs}ms`,
        { jobId: lastJob?.jobId },
      ))),
      timeoutMs,
    );

    ws.on('message', (raw) => {
      let msg = parseWireMsg(rawToString(raw));
      if (!msg) return;
      try {
        if (isChunkMsg(msg)) {
          if (msg.id !== id) return;
          const complete = assembler.accept(msg);
          if (!complete) return; // more frames coming
          msg = complete;
        }
      } catch (err) {
        finish(() => reject(err));
        return;
      }
      if (isEventMsg(msg)) {
        const { type, data } = msg;
        if (type === 'PLUGIN_GONE') {
          finish(() => reject(new CliError('E_NO_PLUGIN', 'Figma plugin disconnected while waiting for the reply')));
        } else if (type === 'BROKER_HELLO' && data.protocolV !== undefined && data.protocolV !== PROTOCOL_VERSION) {
          finish(() => reject(new CliError('E_VERSION_MISMATCH', `broker speaks protocol v${String(data.protocolV)}, CLI expects v${PROTOCOL_VERSION}`)));
        } else if (type === 'JOB_STATE') {
          // Keep waiting — this frame is not the reply, only the jobId the timeout
          // handler above needs so "the CLI never re-dispatches" is actually true.
          lastJob = data as unknown as JobInfo;
        }
        return;
      }
      if (isReplyMsg(msg) && msg.id === id) {
        const reply = msg;
        if (reply.fileContext) lastFileContext = reply.fileContext;
        finish(() => {
          if (reply.ok) resolve(reply.result);
          else reject(new CliError(reply.error.code, reply.error.message, { rolledBack: (reply.error as WireError).rolledBack }));
        });
      }
    });
    ws.on('close', () => finish(() => reject(new CliError('E_NO_BROKER', 'broker connection closed before the reply arrived'))));
    ws.on('error', (err) => finish(() => reject(new CliError('E_NO_BROKER', `broker socket error: ${err.message}`))));

    try {
      sendWireMsg(ws, makeRequestFrame(
        id, cmd, params, activity, expectedFile, projectDir, readOnly, expectedInstance, agentId, targetFileKey,
      ));
    } catch (err) {
      finish(() => reject(new CliError('E_NO_BROKER', `failed to send request: ${(err as Error).message}`)));
    }
  });
}

/**
 * Connect, read the broker's BROKER_HELLO greeting (port, pid, uptime, protocol,
 * plugin liveness), and close — no plugin round-trip. Used by `figma-agent
 * status` to report broker + connection health even when the plugin is absent.
 */
export function fetchBrokerHello(port: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(loopbackWsUrl(port));
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new CliError('E_NO_BROKER', `broker hello timed out on port ${port}`));
    }, CONNECT_TIMEOUT_MS);
    const done = (fn: () => void): void => {
      clearTimeout(timer);
      try { ws.close(); } catch { /* ignore */ }
      fn();
    };
    ws.on('message', (raw) => {
      const msg = parseWireMsg(rawToString(raw));
      if (msg && isEventMsg(msg) && msg.type === 'BROKER_HELLO') done(() => resolve(msg.data));
    });
    ws.once('error', (err) => done(() => reject(new CliError('E_NO_BROKER', `broker hello failed: ${err.message}`))));
    ws.once('close', () => { clearTimeout(timer); reject(new CliError('E_NO_BROKER', 'broker closed before hello')); });
  });
}

/**
 * Whether a WS connect failure against an advertised broker justifies deleting its
 * advertisement file and spawning a replacement. A single failed connect is not
 * proof of death — it can also mean the broker was mid-accept, busy on another
 * handshake, or hit a transient loopback hiccup. Deleting the file and spawning a
 * SECOND broker while the first is still alive is a split-brain: two live daemons,
 * only the newer one advertised, the older one silently orphaned while still
 * holding the Figma plugin's live WS connection. `isPidAliveFn` is the cheap,
 * network-independent signal used to gate that: a dead pid can never have caused
 * the failure by being "merely busy", so deletion is safe; a live pid means the
 * failure is ambiguous, so `runCommand` retries once before giving up rather than
 * tearing the broker down.
 */
export function isConfirmedDeadAfterFailedConnect(
  ad: BrokerAdvertisement,
  isPidAliveFn: typeof isPidAlive = isPidAlive,
): boolean {
  return !isPidAliveFn(ad.pid);
}

/**
 * After an ambiguous (not confirmed-dead) connect failure, wait a short backoff
 * then retry the connect once. Stage-4 review round (minor) — the retry used to
 * fire immediately, re-attempting inside the exact "broker mid-accept / busy on
 * another handshake" window that caused the first failure; the backoff is what
 * actually gives that window room to clear. Exported with injectable `connect`/
 * `sleep` (defaulting to the real ones) so the backoff-then-retry ordering is
 * unit-testable without a real broker or the real shared advertisement file.
 */
export async function retryAmbiguousConnect(
  port: number,
  deps: { connect: (port: number) => Promise<WebSocket>; sleep: (ms: number) => Promise<void>; delayMs?: number } = {
    connect: connectWs,
    sleep,
    delayMs: AMBIGUOUS_CONNECT_RETRY_DELAY_MS,
  },
): Promise<WebSocket> {
  await deps.sleep(deps.delayMs ?? AMBIGUOUS_CONNECT_RETRY_DELAY_MS);
  return deps.connect(port);
}

/**
 * Run one command through the broker. Connect failure after a valid
 * advertisement forces one rediscovery (broker may have just died).
 *
 * `opts.activity` is the intent label the panel's activity feed shows instead of
 * the wire `cmd` (see RequestMsg.activity) — pass it from any command whose `cmd`
 * does not say what the user is actually waiting for.
 *
 * `opts.readOnly` (concurrency & jobs, backlog 1.1+2.6+4.3) overrides the global
 * `--read-only` flag (`setReadOnly`). A true value must name a broker safe-read; an
 * undefined value falls back to the global flag's current value.
 */
export async function runCommand(
  cmd: string,
  params: unknown,
  opts?: { timeoutMs?: number; activity?: string; readOnly?: boolean },
): Promise<unknown> {
  const wireCmd = cmd as CommandName;
  const readOnlyRequested = opts?.readOnly ?? readOnlyGlobal;
  // Fail before ever touching the broker — a lying --read-only assertion is a caller bug,
  // not something worth spawning/connecting to discover (stage-4 fix round, minor 8).
  if (refusesReadOnlyAssertion(wireCmd, readOnlyRequested)) {
    throw new CliError(
      'E_INVALID_ARGS',
      `--read-only cannot be asserted on ${wireCmd} — only broker-known safe reads may bypass mutation admission`,
    );
  }
  let ad = await ensureBroker();
  let ws: WebSocket;
  try {
    ws = await connectWs(ad.port);
  } catch {
    if (!isConfirmedDeadAfterFailedConnect(ad)) {
      // Probe before kill: the pid is still alive, so the first failure is
      // ambiguous rather than confirmed-dead — give the handshake one more try
      // (after a short backoff) before concluding the advertisement lied.
      try {
        ws = await retryAmbiguousConnect(ad.port);
      } catch {
        throw new CliError(
          'E_NO_BROKER',
          `broker (pid ${ad.pid}) is alive but not answering on port ${ad.port} — see /tmp/figma-agent-broker.log`,
        );
      }
    } else {
      try {
        unlinkSync(BROKER_FILE); // pid confirmed dead — advertisement lied, drop it and respawn
      } catch {
        /* already gone */
      }
      ad = await ensureBroker();
      ws = await connectWs(ad.port);
    }
  }

  const timeoutMs = opts?.timeoutMs ?? COMMAND_TIMEOUTS[wireCmd] ?? DEFAULT_TIMEOUT_MS;
  try {
    return await exchange(ws, wireCmd, params, timeoutMs, opts?.activity, readOnlyRequested);
  } finally {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
}
