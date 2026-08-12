// figma-agent CLI entry: plain argv dispatch (no arg-parsing dependency).
// Hidden subcommands `__broker` (persistent relay daemon) and `__emit-skill`
// (prints the generated SKILL.md to stdout) run in-process.
// Every visible command prints exactly ONE JSON object and exits 0/1.
//
// `main()` only auto-runs when this file is the actual process entrypoint (see
// the import.meta.url/argv[1] guard at the bottom) — that lets a test import
// this module (e.g. for COMMAND_MODULES) without accidentally dispatching a
// command from the TEST RUNNER's own argv.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runBrokerDaemon } from './transport/broker-daemon.ts';
import { parseArgs, type CommandArgs } from './arg-parse.ts';
import { CliError } from './transport/protocol-helpers.ts';
import { getLastFileContext, setAgent, setExpectedFile, setExpectedInstance, setProjectDir, setReadOnly } from './transport/broker-client.ts';
import { printErrorJson, printJson, withFileContext } from './util/json-out.ts';
import { HELP } from './help-text.ts';
import { renderSkill } from './skill-emitter.ts';
import * as batch from './commands/batch.ts';
import * as changes from './commands/changes.ts';
import * as contention from './commands/contention.ts';
import * as errors from './commands/errors.ts';
import * as bind from './commands/bind.ts';
import * as bindVariable from './commands/bind-variable.ts';
import * as capture from './commands/capture.ts';
import * as cloneTraits from './commands/clone-traits.ts';
import * as createFrame from './commands/create-frame.ts';
import * as connect from './commands/connect.ts';
import * as disconnect from './commands/disconnect.ts';
import * as listConnections from './commands/list-connections.ts';
import * as reroute from './commands/reroute.ts';
import * as drawFlow from './commands/draw-flow.ts';
import * as verifyConnections from './commands/verify-connections.ts';
import * as createInstance from './commands/create-instance.ts';
import * as createVariable from './commands/create-variable.ts';
import * as execJs from './commands/exec-js.ts';
import * as exportPng from './commands/export-png.ts';
import * as getSelection from './commands/get-selection.ts';
import * as htmlToFigma from './commands/html-to-figma.ts';
import * as inspect from './commands/inspect.ts';
import * as job from './commands/job.ts';
import * as mirrorVerify from './commands/mirror-verify.ts';
import * as scanDesignSystem from './commands/scan-design-system.ts';
import * as scanNode from './commands/scan-node.ts';
import * as scanConventions from './commands/scan-conventions.ts';
import * as auditDs from './commands/audit-ds.ts';
import * as setAutolayout from './commands/set-autolayout.ts';
import * as setConstraints from './commands/set-constraints.ts';
import * as seat from './commands/seat.ts';
import * as setText from './commands/set-text.ts';
import * as setVariant from './commands/set-variant.ts';
import * as status from './commands/status.ts';
import * as syncCorrections from './commands/sync-corrections.ts';
import * as installSkill from './commands/install-skill.ts';
import * as installHook from './commands/install-hook.ts';

// Re-exported so command files keep `import type { CommandArgs } from '../figma-agent.ts'`.
export type { CommandArgs } from './arg-parse.ts';

// Exported (not just module-local) so tests/skill-emitter-drift.test.ts can assert
// every key here has a command-catalog.ts entry and vice versa, without re-declaring
// this list a second time.
export const COMMAND_MODULES: Record<string, { run(args: CommandArgs): Promise<unknown> }> = {
  status,
  seat,
  bind,
  'get-selection': getSelection,
  inspect,
  job,
  'scan-design-system': scanDesignSystem,
  'scan-node': scanNode,
  'mirror-verify': mirrorVerify,
  'scan-conventions': scanConventions,
  'audit-ds': auditDs,
  'create-frame': createFrame,
  connect,
  disconnect,
  'list-connections': listConnections,
  reroute,
  'draw-flow': drawFlow,
  'verify-connections': verifyConnections,
  'create-instance': createInstance,
  'set-variant': setVariant,
  'create-variable': createVariable,
  'bind-variable': bindVariable,
  'set-autolayout': setAutolayout,
  'set-constraints': setConstraints,
  'set-text': setText,
  'clone-traits': cloneTraits,
  'sync-corrections': syncCorrections,
  'export-png': exportPng,
  'html-to-figma': htmlToFigma,
  'exec-js': execJs,
  capture,
  batch,
  changes,
  errors,
  contention,
  'install-skill': installSkill,
  'install-hook': installHook,
};

// Fix round (finding: a blocklist-based filter let C1 controls, bidi override/format
// characters, and a surrogate-splitting truncation all through). An ALLOWLIST closes
// all three at once: lowercase ASCII letters, digits, dot, underscore, hyphen, 1-32
// characters — nothing outside that set can carry a control/bidi/format character or
// need mid-codepoint truncation, so no separate strip/cap step is needed at all.
const AGENT_ALLOWLIST_RE = /^[a-z0-9._-]{1,32}$/;
const AGENT_ALLOWLIST_DESCRIPTION = 'lowercase letters, digits, ".", "_", "-" only, 1-32 characters';

/**
 * `--agent <id>` or `FIGMA_AGENT_ID` (flag wins) — which harness the panel's activity
 * feed should attribute this request to. Same empty-value guard shape as `--file`/
 * `--instance` below; trimmed, then validated against `AGENT_ALLOWLIST_RE` — anything
 * outside it refuses with `E_INVALID_ARGS` naming the allowed set, it is never
 * silently sanitized. Returns `undefined` for "unset" so the envelope stays
 * additive — the `cli` default is applied at RENDER time in the panel, never
 * stamped onto the wire here.
 */
// Exported so tests/agent-label-envelope.test.ts can unit-test the guards (empty/
// allowlist) directly, the same way COMMAND_MODULES is exported above — without
// needing a live broker or a subprocess just to exercise pure validation.
export function resolveAgent(args: CommandArgs): string | undefined {
  if (args.bool('agent') && (args.str('agent') ?? '').trim() === '') {
    printErrorJson(new CliError('E_INVALID_ARGS', '--agent needs a value, e.g. --agent claude'));
  }
  const raw = (args.str('agent') ?? process.env.FIGMA_AGENT_ID ?? '').trim();
  if (raw === '') return undefined;
  if (!AGENT_ALLOWLIST_RE.test(raw)) {
    printErrorJson(new CliError(
      'E_INVALID_ARGS',
      `--agent value is invalid — allowed: ${AGENT_ALLOWLIST_DESCRIPTION} (got ${JSON.stringify(raw)})`,
    ));
  }
  return raw;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const name = argv[0];

  if (name === '__broker') {
    await runBrokerDaemon(); // daemon never returns until shutdown
    return;
  }
  if (name === '__emit-skill') {
    process.stdout.write(renderSkill()); // pure render, no fs — see skill-emitter.ts
    return;
  }
  if (!name || name === '--help' || name === '-h' || name === 'help') {
    console.log(HELP);
    process.exit(name ? 0 : 1);
  }
  const command = COMMAND_MODULES[name];
  if (!command) {
    printErrorJson(new CliError('E_INVALID_ARGS', `unknown command "${name}" — run figma-agent --help`));
  }
  const args = parseArgs(argv.slice(1));
  // `--file` with no value parses as boolean true and str() then returns undefined
  // (arg-parse.ts:27-34) — a typo would run UNGUARDED, so refuse instead.
  if (args.bool('file') && (args.str('file') ?? '').trim() === '') {
    printErrorJson(new CliError('E_INVALID_ARGS', '--file needs a file name, e.g. --file "VSF - PCP"'));
  }
  // Same empty-value guard as --file, for the same reason: a typo'd --instance with no value
  // must never fall through to "unrestricted routing".
  if (args.bool('instance') && (args.str('instance') ?? '').trim() === '') {
    printErrorJson(new CliError('E_INVALID_ARGS', '--instance needs an instanceId, e.g. --instance p_3_1712345678'));
  }
  const fileFlag = (args.str('file') ?? '').trim();
  const instanceFlag = (args.str('instance') ?? '').trim();
  // Mutual exclusion at the CLI boundary: both set is refused outright,
  // never silently resolved to one — resolveRouteFilter's own instance-beats-file precedence
  // exists for env/recency fallback, not for a caller contradicting itself in one request.
  if (fileFlag !== '' && instanceFlag !== '') {
    printErrorJson(new CliError(
      'E_INVALID_ARGS',
      `--instance "${instanceFlag}" and --file "${fileFlag}" are mutually exclusive on one request — drop one`,
    ));
  }
  setExpectedFile(args.str('file'));   // global flag — verified: no command reads --file today
  setExpectedInstance(args.str('instance')); // global flag, same choke point as --file
  setProjectDir(resolve(args.str('dir') ?? process.cwd())); // registry-integrity phase 01 §1
  setReadOnly(args.bool('read-only')); // concurrency & jobs (backlog 1.1+2.6+4.3) — TRUSTED, not enforced
  setAgent(resolveAgent(args)); // auto-connect slice 2 — same choke point as --file/--instance
  try {
    const result = await command.run(args);
    printJson(withFileContext(result));
    process.exit(0);
  } catch (err) {
    printErrorJson(err, getLastFileContext());
  }
}

// Only auto-run when this file is the process entrypoint (`node cli/dist/figma-agent.js
// <args>`), never on a plain `import` — the guard is what lets
// tests/skill-emitter-drift.test.ts import COMMAND_MODULES from this module without
// dispatching a command from the TEST RUNNER's own argv.
const isEntrypoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  main().catch((err) => printErrorJson(err));
}
