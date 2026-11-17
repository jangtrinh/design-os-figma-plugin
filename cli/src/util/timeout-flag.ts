// Shared `--timeout <ms>` handling: validate the flag, clamp it to a command's ceiling, and
// hand back the one stderr line that tells the caller the budget they asked for was lowered.
import type { CommandArgs } from '../arg-parse.ts';
import { CliError } from '../transport/protocol-helpers.ts';

export interface ResolvedTimeout {
  effective: number;
  /** Set only when `requested` exceeded `max`; the caller writes it to stderr. */
  notice?: string;
}

export function resolveTimeoutFlag(requested: number, max: number, label: string): ResolvedTimeout {
  if (requested <= max) return { effective: requested };
  return {
    effective: max,
    notice: `notice: ${label} ${requested}ms exceeds the ${max}ms ceiling; using ${max}ms\n`,
  };
}

/** The positive millisecond value of `--<name>`, or undefined when the flag is absent.
 *  A bare flag (no value), zero, a negative or a non-number is E_INVALID_ARGS. */
export function readTimeoutFlag(args: CommandArgs, name: string): number | undefined {
  if (args.bool(name) && args.str(name) === undefined) {
    throw new CliError('E_INVALID_ARGS', `--${name} needs a value in milliseconds, e.g. --${name} 90000`);
  }
  const value = args.num(name);
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0) {
    throw new CliError('E_INVALID_ARGS', `--${name} must be a positive number of milliseconds, got "${args.str(name)}"`);
  }
  return value;
}
