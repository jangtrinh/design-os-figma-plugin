import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, resolve } from 'node:path';

/** Selected launch path, not an attestation of immutable executable contents. */
export interface ReconcileExecutable {
  uiCommand: string;
  uiExecutable: string | null;
}

/** Preserve override precedence and resolve once against the child's cwd and PATH. */
export function selectReconcileExecutable(cwd: string, env: NodeJS.ProcessEnv = process.env): ReconcileExecutable {
  const uiCommand = env['FIGMA_AGENT_UI_BIN'] || env['DESIGN_OS_UI_BIN'] || 'ui';
  if (isAbsolute(uiCommand) || uiCommand.includes('/') || (process.platform === 'win32' && uiCommand.includes('\\'))) {
    return { uiCommand, uiExecutable: resolve(cwd, uiCommand) };
  }
  // Leave Windows native command lookup intact; its resolved identity is unqualified.
  if (process.platform === 'win32') return { uiCommand, uiExecutable: null };
  for (const directory of (env['PATH'] ?? '/usr/bin:/bin').split(delimiter)) {
    const candidate = resolve(cwd, directory, uiCommand);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return { uiCommand, uiExecutable: candidate };
    } catch { /* native lookup also skips inaccessible or absent PATH candidates */ }
  }
  // Native spawn retains its original failure when there is no resolvable executable.
  return { uiCommand, uiExecutable: null };
}
