/**
 * Registry-integrity phase 04 (5.4), §0 — measures `retainCorrectionEvents` over a
 * 5000-event correction store, 1200 of them `unresolved: true` (the "immortality" bug
 * §3 fixes — an unresolved event is kept unconditionally, so the store is unbounded by
 * construction, unless the hard cap holds).
 *
 * Originated in ease-design (the monorepo this plugin was split from) as the companion
 * to that repo's own kernel-side `tests/scale-baseline.test.ts`, merging into one shared,
 * never-committed (`plans/` is gitignored) local scratch JSON under a `figmaAgent` key so
 * two independent perf records could sit side by side without clobbering each other. That
 * file was always local-only scratch, never a checked-in contract, so the split carries no
 * git history to preserve — RECORD once (bootstrap-only) into this repo's OWN
 * `plans/260730-0847-registry-integrity/scale-baseline.json`, VALIDATE every run (the
 * corpus round-trips through the real `retainCorrectionEvents`/`hasValidCorrectionHash`).
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import {
  hasValidCorrectionHash, retainCorrectionEvents, type CorrectionEvent,
} from '../shared/supervised-memory.ts';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
// One level up from tests/ to repo root — this repo IS the root (no figma-agent/
// subdirectory nesting the way the monorepo this was split from had).
const BASELINE_PATH = join(TEST_DIR, '..', 'plans', '260730-0847-registry-integrity', 'scale-baseline.json');
const GENERATOR = join(TEST_DIR, '..', 'scripts', 'dev', 'make-scale-corpus.mjs');

const EVENT_COUNT = 5000;
const UNRESOLVED_COUNT = 1200;
/** A deliberately small hard limit — today's `retainCorrectionEvents` (no hard-total
 *  guard) cannot honour this while unresolved entries exist; §3 makes it honour it. */
const SMALL_LIMIT = 500;

let dir: string;
let events: CorrectionEvent[];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'scale-corpus-fa-'));
  execFileSync(process.execPath, [GENERATOR, '--components', '300', '--changes', '600', '--out', dir, '--seed', '42']);
  const raw = readFileSync(join(dir, 'design', 'memory', 'figma-corrections.jsonl'), 'utf8');
  events = raw.split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as CorrectionEvent);
}, 30_000);

function measure<T>(fn: () => T): { result: T; ms: number; heapUsedDelta: number } {
  const before = process.memoryUsage().heapUsed;
  const t0 = performance.now();
  const result = fn();
  const ms = performance.now() - t0;
  const heapUsedDelta = process.memoryUsage().heapUsed - before;
  return { result, ms, heapUsedDelta };
}

describe('the correction-memory corpus is well-formed (a real regression gate, every run)', () => {
  it('has exactly 5000 events, 1200 unresolved, every one with a valid content hash', () => {
    expect(events).toHaveLength(EVENT_COUNT);
    expect(events.filter((e) => e.unresolved === true)).toHaveLength(UNRESOLVED_COUNT);
    expect(events.every(hasValidCorrectionHash)).toBe(true);
  });
});

describe('scale-baseline.json — figmaAgent section (recorded once, merged, never clobbers the kernel section)', () => {
  it('records retainCorrectionEvents over the 5000-event corpus', () => {
    const existing: Record<string, unknown> = existsSync(BASELINE_PATH)
      ? (JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Record<string, unknown>)
      : {};
    if (existing['figmaAgent'] === undefined) {
      const retainM = measure(() => retainCorrectionEvents(events, new Date('2026-07-30T00:00:00.000Z'), SMALL_LIMIT));
      // §3's fix, re-verified as part of this bootstrap: the hard cap now holds even
      // against 1200 unresolved events — the "immortality" bug is gone (recorded in
      // sonnet-260730-1204-registry-p3.md's twin report for §3 as the "before" was
      // captured once, historically, before this fix landed; a fresh bootstrap on THIS
      // machine measures the current, fixed implementation).
      expect(retainM.result.kept.length).toBeLessThanOrEqual(SMALL_LIMIT);
      expect(retainM.result.evictedUnresolved.length).toBe(UNRESOLVED_COUNT - retainM.result.kept.filter((e) => e.unresolved === true).length);

      const merged = {
        ...existing,
        figmaAgent: {
          generatedAt: new Date().toISOString(),
          corpus: { events: EVENT_COUNT, unresolved: UNRESOLVED_COUNT, limit: SMALL_LIMIT },
          operations: {
            retainCorrectionEvents: {
              ms: retainM.ms,
              heapUsedDelta: retainM.heapUsedDelta,
              keptCount: retainM.result.kept.length,
              evictedUnresolvedCount: retainM.result.evictedUnresolved.length,
              note: 'retainCorrectionEvents over 5000 events (1200 unresolved) against a 500 hard limit — the cap now holds (§3 fix)',
            },
          },
        },
      };
      mkdirSync(dirname(BASELINE_PATH), { recursive: true });
      writeFileSync(BASELINE_PATH, JSON.stringify(merged, null, 2) + '\n', 'utf8');
    }
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Record<string, unknown>;
    expect(baseline['figmaAgent']).toBeDefined();
  });
});
