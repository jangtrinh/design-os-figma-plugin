#!/usr/bin/env node
// Fails when a tracked source/test file states an invariant by pointing at a plan
// artifact instead of explaining it: an issue/PR number, a spec or plan-dir slug, a
// phase label, or a roadmap/backlog number. Those labels drift the moment the doc
// they point at is renumbered or deleted; the line should say WHAT is true and WHY,
// not WHERE that fact was once written down.
//
// Modes:
//   node scripts/check-comment-hygiene.mjs                 gate: fail on any new citation
//   node scripts/check-comment-hygiene.mjs --update-baseline   regenerate the baseline
//   node scripts/check-comment-hygiene.mjs --self-test      fixture-based check of the matcher itself
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = resolve(root, 'scripts/comment-hygiene-baseline.json');
const SCOPE_DIRS = ['plugin/src', 'cli/src', 'shared', 'tests'];

// Each pattern is scanned per-line. `normalize` turns the raw match into a stable
// baseline key so line-number drift (an edit two lines above) never invalidates an
// entry — only the cited label itself does.
const PATTERNS = [
  {
    name: 'issue/PR number',
    re: /\b(?:issues?|prs?|fix(?:e[sd])?|close[sd]?|resolve[sd]?|tickets?)\s*#\d+\b/gi,
    normalize: (m) => m.toLowerCase().replace(/\s+/g, ' '),
  },
  {
    name: 'spec number',
    re: /\bspec[-\s]\d{3,6}\b/gi,
    normalize: (m) => m.toLowerCase().replace(/\s+/g, '-'),
  },
  {
    name: 'plan-dir slug',
    re: /\b\d{6}-\d{4}-/g,
    normalize: (m) => m,
  },
  {
    name: 'phase label',
    re: /\bphase[-\s]?\d+\b/gi,
    normalize: (m) => m.toLowerCase().replace(/\s+/g, '-'),
  },
  {
    // The parenthesized "(P6)" / "(P9,P14)" / "(P7/P8)" citation style — always in
    // parens in this codebase's history, which is what keeps it from matching a
    // priority label like "P1" used as a bare identifier elsewhere.
    name: 'phase-P label',
    re: /\(P\d{1,2}(?:\s?[/,]\s?P?\d{1,2})*\)/g,
    normalize: (m) => m.toLowerCase().replace(/[()\s]/g, ''),
  },
  {
    name: 'roadmap/backlog label',
    re: /\b(?:backlog|wave)[-\s]?\d+(?:\.\d+)?\b|\bri-p\d+\b|\bcodex\s+p\d+\b/gi,
    normalize: (m) => m.toLowerCase().replace(/\s+/g, '-'),
  },
];

/** Pure — scans one file's text; no filesystem or git access. */
function scanContent(text) {
  const hits = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const pattern of PATTERNS) {
      pattern.re.lastIndex = 0;
      let match;
      while ((match = pattern.re.exec(line)) !== null) {
        hits.push({
          line: i + 1,
          lineText: line.trim(),
          category: pattern.name,
          token: pattern.normalize(match[0]),
          raw: match[0],
        });
        if (match[0].length === 0) pattern.re.lastIndex += 1; // guard zero-width loops
      }
    }
  }
  return hits;
}

function getTrackedFiles() {
  const out = execFileSync('git', ['ls-files', '--', ...SCOPE_DIRS], {
    cwd: root,
    encoding: 'utf8',
  });
  return out.split('\n').filter(Boolean);
}

function scanTree() {
  /** @type {Map<string, Map<string, {count: number, hits: Array}>>} */
  const byFile = new Map();
  for (const relPath of getTrackedFiles()) {
    const abs = resolve(root, relPath);
    let text;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue; // e.g. a tracked symlink to a missing target — not this check's concern
    }
    const hits = scanContent(text);
    if (hits.length === 0) continue;
    const byToken = new Map();
    for (const hit of hits) {
      const key = `${hit.category}::${hit.token}`;
      if (!byToken.has(key)) byToken.set(key, { count: 0, hits: [] });
      const entry = byToken.get(key);
      entry.count += 1;
      entry.hits.push(hit);
    }
    byFile.set(relPath, byToken);
  }
  return byFile;
}

function loadBaseline() {
  if (!existsSync(baselinePath)) return {};
  return JSON.parse(readFileSync(baselinePath, 'utf8'));
}

function baselineToPlain(byFile) {
  const out = {};
  for (const [file, byToken] of [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const tokens = {};
    for (const [key, entry] of [...byToken.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      tokens[key] = entry.count;
    }
    out[file] = tokens;
  }
  return out;
}

function updateBaseline() {
  const byFile = scanTree();
  const before = loadBaseline();
  const after = baselineToPlain(byFile);

  let grew = 0;
  let shrank = 0;
  for (const [file, tokens] of Object.entries(after)) {
    for (const [key, count] of Object.entries(tokens)) {
      const prev = before[file]?.[key] ?? 0;
      if (count > prev) grew += count - prev;
    }
  }
  for (const [file, tokens] of Object.entries(before)) {
    for (const [key, count] of Object.entries(tokens)) {
      const now = after[file]?.[key] ?? 0;
      if (now < count) shrank += count - now;
    }
  }

  writeFileSync(baselinePath, `${JSON.stringify(after, null, 2)}\n`);
  const totalTokens = Object.values(after).reduce((n, t) => n + Object.keys(t).length, 0);
  console.log(`Baseline written: ${Object.keys(after).length} files, ${totalTokens} citation tokens.`);
  if (grew > 0) console.log(`BASELINE GREW: +${grew} citation(s) — review this diff carefully.`);
  if (shrank > 0) console.log(`Baseline shrank: -${shrank} citation(s) retired.`);
}

function runGate() {
  const byFile = scanTree();
  const baseline = loadBaseline();
  const violations = [];
  const staleEntries = [];

  for (const [file, byToken] of byFile) {
    const baselineTokens = baseline[file] ?? {};
    for (const [key, entry] of byToken) {
      const allowed = baselineTokens[key] ?? 0;
      if (entry.count > allowed) {
        // Report every hit beyond what's baselined (most likely what this PR just added).
        const newHits = entry.hits.slice(allowed).map((h) => ({ ...h, file }));
        violations.push(...newHits);
      }
    }
  }

  for (const [file, tokens] of Object.entries(baseline)) {
    const byToken = byFile.get(file);
    for (const [key, baselineCount] of Object.entries(tokens)) {
      const actualCount = byToken?.get(key)?.count ?? 0;
      if (actualCount < baselineCount) {
        staleEntries.push(`${file} :: ${key} (baseline ${baselineCount}, now ${actualCount})`);
      }
    }
  }

  if (staleEntries.length > 0) {
    console.log(`Note: ${staleEntries.length} baseline entr${staleEntries.length === 1 ? 'y is' : 'ies are'} stale (fewer citations than recorded). Run --update-baseline to shrink it.`);
  }

  if (violations.length > 0) {
    console.error(`comment-hygiene: ${violations.length} citation(s) not covered by the baseline.\n`);
    console.error('State the invariant directly instead of citing a plan id, issue number, phase label, or finding code:\n');
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}: [${v.category}] ${v.lineText}`);
    }
    process.exit(1);
  }

  console.log(`comment-hygiene: clean (${byFile.size} file(s) with baselined citations, 0 new).`);
}

function selfTest() {
  const cases = [
    { label: 'issue citation in a comment', text: '// leftover context (issue #42)', expectMatch: true },
    { label: 'clean equivalent of the above', text: '// leftover: still throws under dynamic-page access', expectMatch: false },
    { label: 'issue citation in a describe() name', text: "describe('refuses cleanly (issue #42)', () => {});", expectMatch: true },
    { label: 'clean describe() name', text: "describe('refuses cleanly when the guard trips', () => {});", expectMatch: false },
    { label: 'fixes # shorthand', text: '// fixes #7 by rejecting empty names', expectMatch: true },
    { label: 'spec number citation', text: '// see spec 260801-1050 for the original ruling', expectMatch: true },
    { label: 'plan-dir slug citation', text: '// lives at 260801-1050-taste-transfer/phase-02.md', expectMatch: true },
    { label: 'phase label citation', text: '// deferred to phase 2 of the rollout', expectMatch: true },
    { label: 'parenthesized P-label citation', text: '// the walker will not bind it (P9)', expectMatch: true },
    { label: 'roadmap label citation', text: '// folded into wave 4.4 P2 of the backlog', expectMatch: true },
    { label: 'hex color is not an issue number', text: "el.style.background = '#ff3e00';", expectMatch: false },
    { label: 'numeric hex color stays clean without an issue word', text: "const swatch = '#123456';", expectMatch: false },
    { label: 'the word issue near an unrelated hex code stays clean', text: "// not an issue: background is #123456 by design", expectMatch: false },
  ];

  let failures = 0;
  for (const c of cases) {
    const hits = scanContent(c.text);
    const matched = hits.length > 0;
    const ok = matched === c.expectMatch;
    console.log(`${ok ? 'ok' : 'FAIL'} — ${c.label}`);
    if (!ok) {
      failures += 1;
      console.log(`  expected match=${c.expectMatch}, got match=${matched} (hits: ${JSON.stringify(hits.map((h) => h.raw))})`);
    }
  }

  if (failures > 0) {
    console.error(`\nself-test: ${failures}/${cases.length} case(s) failed.`);
    process.exit(1);
  }
  console.log(`\nself-test: ${cases.length}/${cases.length} cases passed.`);
}

const arg = process.argv[2];
if (arg === '--self-test') {
  selfTest();
} else if (arg === '--update-baseline') {
  updateBaseline();
} else if (arg === '--help' || arg === '-h') {
  console.log(`Usage:
  node scripts/check-comment-hygiene.mjs                gate: fail on any citation not in the baseline
  node scripts/check-comment-hygiene.mjs --update-baseline   regenerate scripts/comment-hygiene-baseline.json
  node scripts/check-comment-hygiene.mjs --self-test     run the matcher's own fixture cases
`);
} else {
  runGate();
}
