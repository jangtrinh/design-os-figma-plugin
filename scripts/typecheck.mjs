#!/usr/bin/env node
// Parallel Go-binary typecheck runner for TypeScript 7.
// Spawns native Go tsc directly across all project configs concurrently with
// `--checkers 2` to prevent CPU contention, streaming output cleanly on failure.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

function resolveTscExecutable() {
  const base = `typescript-${process.platform}-${process.arch}`;
  const binName = process.platform === 'win32' ? 'tsc.exe' : 'tsc';
  try {
    const pkgJson = require.resolve(`@typescript/${base}/package.json`);
    const binPath = join(dirname(pkgJson), 'lib', binName);
    if (existsSync(binPath)) return binPath;
  } catch {
    // Fall back to TypeScript package lib/getExePath if available
  }

  try {
    const tsGetExe = join(root, 'node_modules/typescript/lib/getExePath.js');
    if (existsSync(tsGetExe)) {
      // Dynamic import or node require
      const getExe = require(tsGetExe);
      const fn = getExe.default ?? getExe;
      const exe = fn();
      if (existsSync(exe)) return exe;
    }
  } catch {
    // Fall back to node_modules/.bin/tsc
  }

  const tscJs = join(root, 'node_modules/typescript/lib/tsc.js');
  if (existsSync(tscJs)) return { cmd: process.execPath, prefixArgs: [tscJs] };
  return { cmd: 'tsc', prefixArgs: [] };
}

const resolved = resolveTscExecutable();
const { cmd: tscCmd, prefixArgs } = typeof resolved === 'string'
  ? { cmd: resolved, prefixArgs: [] }
  : resolved;

const configs = [
  { path: 'cli', checkers: '2' },
  { path: 'plugin', checkers: '2' },
  { path: 'plugin/tsconfig.main.json', checkers: '2' },
  { path: 'tests', checkers: '4' },
  { path: 'tests/tsconfig.main.json', checkers: '2' },
];

function runConfig({ path: config, checkers }) {
  return new Promise((resolveResult) => {
    const args = [...prefixArgs, '-p', config, '--noEmit', '--checkers', checkers];
    const proc = spawn(tscCmd, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('close', (code) => {
      resolveResult({
        config,
        code,
        output: (stdout + stderr).trim(),
      });
    });
  });
}

const results = await Promise.all(configs.map(runConfig));
const failures = results.filter((r) => r.code !== 0);

if (failures.length > 0) {
  for (const f of failures) {
    console.error(`\n[typecheck] FAILED: ${f.config} (exit code ${f.code})`);
    if (f.output) {
      console.error(f.output);
    }
  }
  process.exit(1);
}
