// Backlog 4.6 — the broker's error-log fs layer: append-only JSONL, one line per
// ReplyErr relayed, at design/figma-errors.jsonl (sibling of figma.changes.jsonl, shares
// the base dir with the 4.4 edit feed via changeLogDir()). Mirrors change-log.test.ts's shape.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ERROR_LOG_FILENAME, ERROR_STAGING_DIRNAME, ERROR_UNBOUND_STAGING_DIRNAME,
  appendErrorFrame, buildErrorLogFrame, errorLogPath, errorLogPathFor, unboundErrorStagingPath,
} from '../cli/src/transport/error-log.ts';
import { unboundStagingRoot } from '../cli/src/transport/change-log.ts';
import type { ReplyErr } from '../shared/protocol.ts';

const replyErr = (over: Partial<ReplyErr> = {}): ReplyErr => ({
  id: 'req-1',
  ok: false,
  error: { code: 'E_PLUGIN_ERROR', message: 'boom' },
  ...over,
});

let dir: string;
let unboundDir: string;
const prevEnv = process.env['FIGMA_AGENT_CHANGES_DIR'];
const prevUnboundEnv = process.env['FIGMA_AGENT_UNBOUND_DIR'];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fa-error-log-'));
  unboundDir = mkdtempSync(join(tmpdir(), 'fa-error-log-unbound-'));
  process.env['FIGMA_AGENT_CHANGES_DIR'] = dir;
  process.env['FIGMA_AGENT_UNBOUND_DIR'] = unboundDir;
});
afterEach(() => {
  if (prevEnv === undefined) delete process.env['FIGMA_AGENT_CHANGES_DIR'];
  else process.env['FIGMA_AGENT_CHANGES_DIR'] = prevEnv;
  if (prevUnboundEnv === undefined) delete process.env['FIGMA_AGENT_UNBOUND_DIR'];
  else process.env['FIGMA_AGENT_UNBOUND_DIR'] = prevUnboundEnv;
  rmSync(dir, { recursive: true, force: true });
  rmSync(unboundDir, { recursive: true, force: true });
});

const readLines = (path: string): string[] =>
  readFileSync(path, 'utf8').split('\n').filter((l) => l.trim().length > 0);

describe('errorLogPath — shares the change-log base dir + env override', () => {
  it('lives directly at <changeLogDir()>/figma-errors.jsonl (a SIBLING of the change log)', () => {
    expect(errorLogPath()).toBe(join(dir, ERROR_LOG_FILENAME));
  });
});

describe('errorLogPathFor — issue #7 (backlog 5.9): rooted at an explicit project, not the broker cwd', () => {
  it('names the same file under <projectDir>/design', () => {
    expect(errorLogPathFor('/tmp/some-project')).toBe(join('/tmp/some-project', 'design', ERROR_LOG_FILENAME));
  });
});

describe('unboundErrorStagingPath — issue #7 (backlog 5.9): mirrors change-log.ts / edit-feed-log.ts\'s unbound staging exactly', () => {
  it('lives under <unboundStagingRoot()>/errors/unbound/, its OWN subdir, never under changeLogDir()', () => {
    expect(unboundErrorStagingPath('vsf-pcp')).toBe(
      join(unboundStagingRoot(), ERROR_STAGING_DIRNAME, ERROR_UNBOUND_STAGING_DIRNAME, 'vsf-pcp.jsonl'),
    );
    expect(unboundErrorStagingPath('vsf-pcp').startsWith(dir)).toBe(false);
  });

  it('is a DIFFERENT path from change-log.ts\'s / edit-feed-log.ts\'s own unbound staging for the same slug', () => {
    const errStaging = unboundErrorStagingPath('vsf-pcp');
    expect(errStaging).toContain(`${ERROR_STAGING_DIRNAME}/${ERROR_UNBOUND_STAGING_DIRNAME}`);
  });
});

describe('buildErrorLogFrame', () => {
  it('carries every field of a well-formed ReplyErr that echoed cmd/activity', () => {
    const reply = replyErr({
      cmd: 'EXEC_JS', activity: 'Scan · 1:23',
      error: { code: 'E_EVAL', message: 'ReferenceError: x is not defined', rolledBack: true },
      fileContext: { fileName: 'VSF - PCP' },
    });
    const frame = buildErrorLogFrame(reply, null, 42);
    expect(frame).toEqual({
      ts: 42, cmd: 'EXEC_JS', activity: 'Scan · 1:23', code: 'E_EVAL',
      message: 'ReferenceError: x is not defined', rolledBack: true,
      fileName: 'VSF - PCP', requestId: 'req-1',
    });
  });

  it('the message is FULL and untruncated, however long', () => {
    const long = 'x'.repeat(5000);
    const frame = buildErrorLogFrame(replyErr({ error: { code: 'E_EVAL', message: long } }), null, 1);
    expect(frame.message).toHaveLength(5000);
    expect(frame.message).toBe(long);
  });

  it('omits rolledBack entirely when the error payload did not carry it', () => {
    const frame = buildErrorLogFrame(replyErr(), null, 1);
    expect(frame).not.toHaveProperty('rolledBack');
  });

  it('cmd/activity default to null when the replying build did not echo them (older client)', () => {
    const frame = buildErrorLogFrame(replyErr({ cmd: undefined, activity: undefined }), null, 1);
    expect(frame.cmd).toBeNull();
    expect(frame.activity).toBeNull();
  });

  it('an empty-string activity is treated as absent (null), not an empty label', () => {
    const frame = buildErrorLogFrame(replyErr({ activity: '' }), null, 1);
    expect(frame.activity).toBeNull();
  });

  it('fileName prefers the reply\'s own fileContext over the fallback', () => {
    const frame = buildErrorLogFrame(
      replyErr({ fileContext: { fileName: 'From Reply' } }), 'From Fallback', 1,
    );
    expect(frame.fileName).toBe('From Reply');
  });

  it('fileName falls back to the routed-plugin name when the reply carries no fileContext at all', () => {
    // e.g. a broker-generated E_NO_PLUGIN error that never reached a plugin.
    const frame = buildErrorLogFrame(replyErr({ fileContext: undefined }), 'Routed Plugin File', 1);
    expect(frame.fileName).toBe('Routed Plugin File');
  });

  it('fileName is null when neither the reply nor the fallback has one', () => {
    const frame = buildErrorLogFrame(replyErr({ fileContext: undefined }), null, 1);
    expect(frame.fileName).toBeNull();
  });
});

describe('appendErrorFrame — one JSONL line per error, append-only', () => {
  it('writes a well-formed frame line and creates the dir', () => {
    const path = errorLogPath();
    appendErrorFrame(path, buildErrorLogFrame(replyErr(), 'F', 42));
    const lines = readLines(path);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ ts: 42, code: 'E_PLUGIN_ERROR', message: 'boom', fileName: 'F' });
  });

  it('appends across calls, never truncates', () => {
    const path = errorLogPath();
    appendErrorFrame(path, buildErrorLogFrame(replyErr({ id: 'a' }), null, 1));
    appendErrorFrame(path, buildErrorLogFrame(replyErr({ id: 'b' }), null, 2));
    expect(readLines(path).map((l) => JSON.parse(l).requestId)).toEqual(['a', 'b']);
  });

  // Issue #7 minor fix: log-rotate.ts's own module header always named this feed as one
  // of the three its policy covers, but the call here was never actually wired — this
  // crosses that boundary directly with the SAME default 8 MiB policy the other two
  // feeds use (rotateIfNeeded's own exhaustive behavior — boundary, marker ordering,
  // generation retention — is tested in log-rotate.test.ts; this only proves
  // appendErrorFrame's call site is real, not a documentation claim).
  it('rotates once the file crosses the default 8 MiB policy, same as appendChangeFrame/appendEditFrame', () => {
    const path = errorLogPath();
    const oneMib = 'x'.repeat(1024 * 1024);
    for (let i = 0; i < 9; i++) {
      appendErrorFrame(path, buildErrorLogFrame(replyErr({ id: `req-${i}`, error: { code: 'E_EVAL', message: oneMib } }), null, i));
    }
    expect(existsSync(`${path}.rotated.json`)).toBe(true); // rotated at least once past 8 MiB
    expect(existsSync(`${path}.1`)).toBe(true); // the archived generation
    // The live file was reset — its own size is small again (last append(s) only).
    expect(readLines(path).length).toBeLessThan(9);
  });
});
