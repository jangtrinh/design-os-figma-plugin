import { existsSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { writePrivateFileExclusive } from './private-file-write.ts';

export interface BindCache {
  v: 1;
  projectDirs: string[];
}

export type BindCacheWriteResult = { ok: true } | { ok: false; error: { code: string } };

/** Restart hint only; each project's binding marker remains authoritative. */
export function bindCacheFile(): string {
  return process.env['FIGMA_AGENT_BINDS_FILE'] || '/tmp/figma-agent-binds.json';
}

export function readBindCache(): BindCache {
  const path = bindCacheFile();
  if (!existsSync(path)) return { v: 1, projectDirs: [] };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const dirs = parsed && typeof parsed === 'object' ? (parsed as BindCache).projectDirs : undefined;
    if (Array.isArray(dirs)) return { v: 1, projectDirs: dirs.filter((d): d is string => typeof d === 'string') };
  } catch { /* An unreadable hint must not prevent a fresh binding. */ }
  return { v: 1, projectDirs: [] };
}

/** Failure preserves the prior cache and reports a cause without invalidating durable bindings. */
export function writeBindCache(projectDirs: readonly string[]): BindCacheWriteResult {
  const destination = bindCacheFile();
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    writePrivateFileExclusive(temporary, JSON.stringify({ v: 1, projectDirs: [...new Set(projectDirs)] }));
    try {
      renameSync(temporary, destination);
    } catch (error) {
      try { unlinkSync(temporary); } catch { /* Preserve the replacement error. */ }
      throw error;
    }
    return { ok: true };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return { ok: false, error: { code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'EIO' } };
  }
}
