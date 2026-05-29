#!/usr/bin/env node
/**
 * validate-all.mjs — batch-validate every registered system, stamp the
 * resulting quality_score into each manifest's front-matter, and print a
 * summary. Reuses validateSystem + writeQualityScore + computeQualityInputHash
 * + readCachedQuality so the skip-cache behaviour matches the full sweep.
 *
 * Usage:
 *   node tools/systems-registry/validate-all.mjs [--no-cache] [--concurrency N]
 *
 * Default concurrency = 3 (claude -p is happy with that, the sweep uses 4).
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  validateSystem, writeQualityScore,
  computeQualityInputHash, readCachedQuality,
  parseGlobsFromFrontMatter,
} from './validate.mjs';

function repoRoot() {
  try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim(); }
  catch { return process.cwd(); }
}

const args = process.argv.slice(2);
const noCache = args.includes('--no-cache');
const cIdx = args.indexOf('--concurrency');
const concurrency = cIdx !== -1 ? Number(args[cIdx + 1]) : 3;

const root = repoRoot();
const sysDir = join(root, 'docs/systems');
// Skip dotfile-like ledger files (_hypothesis.md, _context.md) and the
// docs/systems/README.md itself — it's narrative, not a system manifest.
const files = readdirSync(sysDir)
  .filter(f => f.endsWith('.md') && !f.startsWith('_') && f !== 'README.md')
  .map(f => ({ name: f.replace(/\.md$/, ''), path: join(sysDir, f) }));

process.stdout.write(`validating ${files.length} systems (concurrency=${concurrency}, cache=${!noCache})\n\n`);

const results = [];
let inFlight = 0;
let next = 0;

function runOne(idx) {
  const f = files[idx];
  const t0 = Date.now();
  const text = readFileSync(f.path, 'utf8');
  const globs = parseGlobsFromFrontMatter(text);
  const inputHash = computeQualityInputHash(root, f.path, globs);
  const cached = readCachedQuality(f.path);
  if (!noCache && cached && cached.inputHash === inputHash) {
    const r = { name: f.name, score: cached.score, verdict: cached.verdict, cached: true, ms: 0 };
    results.push(r);
    process.stdout.write(`  ${f.name}: ${cached.score}/10 (${cached.verdict}) [cache]\n`);
    return Promise.resolve();
  }
  return validateSystem(root, f.path).then(r => {
    const score = r.scores.overall;
    writeQualityScore(f.path, score, r.verdict, inputHash);
    const ms = Date.now() - t0;
    results.push({ name: f.name, score, verdict: r.verdict, cached: false, ms,
      issues: r.issues?.length || 0, missing: r.missing?.length || 0 });
    process.stdout.write(`  ${f.name}: ${score}/10 (${r.verdict})  issues=${r.issues?.length || 0}  ${(ms/1000).toFixed(1)}s\n`);
  }).catch(err => {
    results.push({ name: f.name, score: null, verdict: 'error', error: String(err.message || err) });
    process.stdout.write(`  ${f.name}: ERROR — ${err.message || err}\n`);
  });
}

async function pump() {
  const tasks = [];
  for (let i = 0; i < concurrency && next < files.length; i++) {
    tasks.push(loop());
  }
  await Promise.all(tasks);
}

async function loop() {
  while (next < files.length) {
    const idx = next++;
    await runOne(idx);
  }
}

const start = Date.now();
await pump();
const elapsed = (Date.now() - start) / 1000;

results.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
process.stdout.write(`\n=== summary (${elapsed.toFixed(1)}s wall) ===\n`);
const passed = results.filter(r => r.score >= 7).length;
const failed = results.filter(r => r.score !== null && r.score < 7).length;
const errored = results.filter(r => r.score === null).length;
const fromCache = results.filter(r => r.cached).length;
process.stdout.write(`pass(>=7): ${passed}   below: ${failed}   errored: ${errored}   from-cache: ${fromCache}\n\n`);
for (const r of results) {
  if (r.score === null) {
    process.stdout.write(`  ✗ ${r.name}: ERROR ${r.error}\n`);
  } else {
    const tag = r.score >= 7 ? '✓' : '✗';
    process.stdout.write(`  ${tag} ${r.name}: ${r.score}/10 (${r.verdict})${r.cached ? ' [cache]' : ''}\n`);
  }
}

// Exit non-zero only on errors, not on low scores — low scores are real signal,
// not failure (gate happens at the build step).
process.exit(errored > 0 ? 1 : 0);
