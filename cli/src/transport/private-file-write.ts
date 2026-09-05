import { closeSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { safeCleanup } from '../../../shared/safe-cleanup.ts';

/** Acquire a new private file without following or removing an existing path. */
export function writePrivateFileExclusive(path: string, contents: string): void {
  // Open outside cleanup: a failed acquisition gives us no ownership of this path.
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, contents, 'utf8');
  } catch (err) {
    safeCleanup(err, () => {
      try { closeSync(fd); } finally { unlinkSync(path); }
    });
  }
  try {
    closeSync(fd);
  } catch (err) {
    safeCleanup(err, () => unlinkSync(path));
  }
}
