#!/usr/bin/env node
// systems-registry — end-to-end pipeline orchestrator.
//
// Runs the full v2 pipeline in sequence:
//   Pass 0 (detect, free) → Pass 1 (hypothesis LLM) → Pass 2 (body LLM × N)
//   → Pass 2.5 (vet, cheap + optional LLM) → Pass 2.6 (revise if flagged, ≤2 retries)
//
// Final state: docs/systems/_hypothesis.md + N system manifests with
// status: active | needs-review.

import { existsSync, readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { runPass1 } from './pass1.mjs';
import { generateBody } from './pass2.mjs';
import { vetSystem } from './pass25-vet.mjs';
import { reviseSystem } from './pass26-revise.mjs';
import { validateSystem, writeQualityScore, computeQualityInputHash, readCachedQuality } from './validate.mjs';
import { refineSystem } from './refine.mjs';
import { runOrganize } from './organize.mjs';
import { buildSite } from './build-static.mjs';

/**
 * Full-rewrite semantics: the hypothesis is the single source of truth each
 * run. Delete any docs/systems/*.md NOT produced this run — so renamed or
 * removed systems never leave orphan manifests behind. Preserves README.md
 * and _hypothesis.md.
 */
function pruneOrphans(repoRoot, keepNames, log) {
  const dir = join(repoRoot, 'docs/systems');
  if (!existsSync(dir)) return [];
  const keep = new Set(['README.md', '_hypothesis.md', ...keepNames.map(n => `${n}.md`)]);
  const pruned = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md') || keep.has(f)) continue;
    rmSync(join(dir, f));
    pruned.push(f);
    log(`pruned orphan: ${f}`);
  }
  return pruned;
}

export function parseHypothesisSystems(hypPath) {
  if (!existsSync(hypPath)) return [];
  const text = readFileSync(hypPath, 'utf8');
  const m = text.match(/systems:\n([\s\S]*?)(?:\n##\s|\n---\s|$)/);
  if (!m) return [];
  // Split body on each `- name:` start-of-entry marker. First chunk is preamble.
  const chunks = m[1].split(/^\s*-\s*name:\s*/m);
  const sysList = [];
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i];
    const firstLineEnd = chunk.indexOf('\n');
    const name = chunk.slice(0, firstLineEnd === -1 ? chunk.length : firstLineEnd).trim().replace(/^["']|["']$/g, '');
    const rest = firstLineEnd === -1 ? '' : chunk.slice(firstLineEnd + 1);
    const obj = { name, globs: [], consumes: [], kind: null };
    let inGlobs = false, inConsumes = false;
    for (const line of rest.split('\n')) {
      if (/^\s*summary:/.test(line)) { obj.summary = line.replace(/^\s*summary:\s*/, '').trim(); inGlobs = false; inConsumes = false; }
      else if (/^\s{0,4}kind:\s*(.+)/.test(line)) { obj.kind = line.match(/^\s{0,4}kind:\s*(.+)/)[1].trim().replace(/^["']|["']$/g, ''); inGlobs = false; inConsumes = false; }
      else if (/^\s*globs:/.test(line)) { inGlobs = true; inConsumes = false; }
      else if (/^\s*consumes:/.test(line)) {
        inConsumes = true; inGlobs = false;
        // inline-array form: `consumes: [a, b]`
        const inline = line.match(/^\s*consumes:\s*\[([^\]]*)\]/);
        if (inline) {
          for (const v of inline[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)) obj.consumes.push(v);
          inConsumes = false;
        }
      }
      else if (inGlobs && /^\s*-\s/.test(line)) { obj.globs.push(line.replace(/^\s*-\s*/, '').trim().replace(/^["']|["']$/g, '')); }
      else if (inConsumes && /^\s*-\s/.test(line)) { obj.consumes.push(line.replace(/^\s*-\s*/, '').trim().replace(/^["']|["']$/g, '')); }
      else if (/^\s*closes_loop_via:/.test(line)) { obj.closes_loop_via = line.replace(/^\s*closes_loop_via:\s*/, '').trim(); inGlobs = false; inConsumes = false; }
      else if (/^\s*\w+:/.test(line)) { inGlobs = false; inConsumes = false; }
    }
    sysList.push(obj);
  }
  return sysList;
}

// Issue kinds the revise loop can actually FIX. Runtime-artifact globs
// and runtime-path references aren't fixable by re-prompting (they're not
// hallucinations — they document real runtime state), so firing revise on
// them just burns LLM calls and still ends in needs-review. Only revise
// when at least one fixable issue is present.
const FIXABLE_KINDS = new Set([
  'hallucinated-symbol',
  'invariant-contradiction',
  'wrong-closing-arrow',
  'missing-section',
  'mermaid-issue',
  'mentioned-path-not-on-disk',  // a SOURCE-file path that doesn't exist IS fixable
  'no-front-matter',
  'front-matter-missing-name',
  'front-matter-missing-globs',
]);

function hasFixableIssue(problems) {
  return problems.some(p => FIXABLE_KINDS.has(p.kind));
}

/**
 * Run async fn over items with a concurrency cap. Preserves input order
 * in the returned results array.
 */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Match a path against a simple glob. `dir/**` = prefix match on `dir/`;
 * `dir/*Routes.ts` = single-segment wildcard; literal path = exact.
 * Lightweight — enough for the hypothesis emit patterns we see.
 */
export function matchGlob(glob, file) {
  if (glob.endsWith('/**')) {
    const base = glob.slice(0, -3);
    return file === base || file.startsWith(base + '/');
  }
  if (glob.includes('*')) {
    // Hand-build the regex: process char-by-char to avoid the double-escape
    // hazard of regex-on-regex transformations. `**` → `.*`, `*` → `[^/]*`,
    // everything else regex-escaped. This is simpler AND correct vs the
    // chained-replace form (which got the single-star case wrong).
    let re = '';
    for (let i = 0; i < glob.length; i++) {
      const c = glob[i];
      if (c === '*' && glob[i + 1] === '*') { re += '.*'; i++; }
      else if (c === '*') { re += '[^/]*'; }
      else if (/[.+?^${}()|[\]\\]/.test(c)) { re += '\\' + c; }
      else { re += c; }
    }
    return new RegExp('^' + re + '$').test(file);
  }
  return file === glob;
}

/**
 * Build the set of system names that should be validated by the LLM judge
 * given an optional list of changed files (e.g. from a push hook diff).
 * - changedFiles=null/empty → ALL systems (full sweep behavior).
 * - else: any system with a glob matching a changed file is included,
 *   then transitively any system that `consumes:` one already in-set
 *   (downstream impact — a doc relying on a moved system may now be wrong,
 *   so we don't silently skip it just because its own files didn't change).
 */
export function computeValidateScope(systems, changedFiles) {
  if (!changedFiles || !changedFiles.length) return new Set(systems.map(s => s.name));
  const scope = new Set();
  for (const sys of systems) {
    for (const g of sys.globs || []) {
      if (changedFiles.some(f => matchGlob(g, f))) { scope.add(sys.name); break; }
    }
  }
  // Downstream fixed-point: include systems that consume something in scope.
  let grew = true;
  while (grew) {
    grew = false;
    for (const sys of systems) {
      if (scope.has(sys.name)) continue;
      if ((sys.consumes || []).some(c => scope.has(c))) { scope.add(sys.name); grew = true; }
    }
  }
  return scope;
}

export async function runPipeline(repoRoot, {
  write = process.stdout.write.bind(process.stdout),
  llmVet = false,
  runner,
  judgeRunner,            // judge LLM; defaults to `runner` (tests) / claude -p
  concurrency = 4,
  // Pass 2.7 — quality phase. validate scores each system 0-10 and gates;
  // refine adds the regenerate-to-target loop on top. Both default ON
  // (user choice). --no-validate / --no-refine flip these off.
  validate = true,
  refine = true,
  minScore = 7,
  maxRounds = 2,
  // ── Cost controls ───────────────────────────────────────────────────
  // changedFiles: when provided (e.g. push-hook list), only systems whose
  // anchor globs match a changed file are validated. Their downstream
  // consumers (any system whose `consumes:` names a changed system) are
  // also validated, so important-but-unchanged ones don't silently skip.
  // Other systems still generate/vet/revise as before but skip the LLM
  // judge call. Big win for push-hook cadence; full sweeps pass null.
  changedFiles = null,
  // skipUnchanged: when true, a system whose hash(manifestBody +
  // concatenated anchor file contents) matches the stored
  // `quality_input_hash` from the prior run, AND already has a
  // quality_score >= minScore, skips the judge entirely. Re-running on
  // identical inputs is free.
  skipUnchanged = true,
  // maxTokensEst: rough token-budget abort. Each LLM call estimates its
  // input + output token usage (bytes/4 ≈ tokens) and we sum across the
  // sweep. If we cross the budget mid-sweep, ABORT remaining work, run
  // organize + build with what's done, and report. Default is generous
  // (10M tokens ≈ $40-50 list-price equivalent) — safety net, not gate.
  maxTokensEst = 10_000_000,
} = {}) {
  const jRunner = judgeRunner || runner;
  // Simple shared token meter. Estimates from byte length of prompt +
  // response. Coarse but bounds catastrophic blowouts (today's $1,319/5h
  // burn would have been capped). We track + check, not block individual
  // calls — abort takes effect at the next per-system decision point.
  const meter = { tokens: 0, budget: maxTokensEst, abort: false };
  function meterCall(promptBytes, responseBytes) {
    meter.tokens += Math.ceil((promptBytes + responseBytes) / 4);
    if (meter.tokens >= meter.budget) meter.abort = true;
  }
  // Wrap a runner so every LLM call feeds the meter automatically.
  function meteredRunner(inner) {
    if (!inner) return inner;
    return async (prompt) => {
      const r = await inner(prompt);
      meterCall(prompt.length, (r || '').length);
      return r;
    };
  }
  // Re-bind so every downstream LLM call gets metered transparently.
  // The metered wrapper captures the original runner via closure, so this
  // is safe and means we don't have to thread a second arg through every
  // pass's signature.
  runner = meteredRunner(runner);
  const meteredJudge = meteredRunner(jRunner);
  const startedAt = new Date().toISOString();
  const log = (msg) => write(`[pipeline ${new Date().toISOString().slice(11, 19)}] ${msg}\n`);
  const telemetry = { startedAt, steps: [] };

  // Pass 1
  log('Pass 1: hypothesis…');
  const p1Start = Date.now();
  const p1Result = await runPass1(repoRoot, { runner });
  telemetry.steps.push({ pass: 1, elapsed_ms: Date.now() - p1Start, candidates: p1Result.inputs.candidates.length });
  log(`Pass 1 wrote ${p1Result.outPath} (${p1Result.inputs.candidates.length} candidates)`);

  // Parse hypothesis
  const systems = parseHypothesisSystems(p1Result.outPath);
  log(`hypothesis parsed: ${systems.length} system(s)`);
  if (systems.length === 0) {
    log('no systems in hypothesis — exiting');
    return { telemetry, results: [], hypothesisPath: p1Result.outPath };
  }

  // ── Compute "systems to validate" given changedFiles (incremental mode) ─
  // A system is in-scope for the LLM judge if (a) one of its globs matches a
  // changed file, OR (b) it consumes a system that is itself in-scope —
  // downstream impact: a doc may still be wrong if the system it depends on
  // moved. Other systems still generate/vet/revise; they just skip validate.
  // changedFiles=null → all systems are in-scope (full sweep behavior).
  const validateScope = computeValidateScope(systems, changedFiles);
  if (changedFiles) {
    log(`incremental: ${validateScope.size}/${systems.length} systems will be validated (changed + downstream)`);
  }

  // Pass 2 + 2.5 + (2.6) per system — fanned out with a concurrency cap so a
  // 12-system repo doesn't run for 30 minutes single-file.
  const qualityLabel = validate ? (refine ? '/2.7-refine' : '/2.7-score') : '';
  log(`Pass 2/2.5/2.6${qualityLabel}: ${systems.length} systems, concurrency ${concurrency}…`);
  const results = await mapWithConcurrency(systems, concurrency, async (sys) => {
   const stepStart = Date.now();
   try {
    // Budget abort check — if a prior system blew the budget, mark this one
    // skipped and continue. organize + build still run on what's done.
    if (meter.abort) {
      log(`  ⊘ ${sys.name}: skipped (budget abort, ${meter.tokens}/${meter.budget} tokens)`);
      return { name: sys.name, status: 'skipped-budget', problems: [], qualityScore: null, elapsed_ms: 0 };
    }
    let attempts = 0;

    // Pass 2
    const p2 = await generateBody(repoRoot, sys, { runner });

    // Pass 2.5 vet
    let vet = await vetSystem(repoRoot, p2.outPath, { llm: llmVet, runner });
    const initialVet = { status: vet.status, problems: vet.problems, llmFindings: vet.llmFindings || null };

    // Pass 2.6 revise — ONLY if there's a fixable issue (don't burn calls
    // re-prompting over runtime-artifact references that aren't broken).
    if (vet.status === 'issues' && hasFixableIssue(vet.problems)) {
      const revised = await reviseSystem(repoRoot, sys, vet, { runner });
      attempts = revised.attempts.length;
      vet = { status: revised.finalStatus, problems: revised.finalProblems };
    }

    // A system flagged ONLY by unfixable (runtime-artifact) issues still
    // ships active — those refs are documentation, not hallucinations.
    const onlyUnfixable = vet.status === 'issues' && !hasFixableIssue(vet.problems);
    let status = (vet.status === 'ok' || onlyUnfixable) ? 'active' : 'needs-review';

    // ── Pass 2.7: quality phase (validate, optionally refine) ──────────
    // Cost gates BEFORE the LLM call:
    //  (a) incremental scope: if changedFiles was supplied and this system
    //      isn't in-scope, skip the judge (still regenerated by Pass 2).
    //  (b) skipUnchanged cache: if the doc's input hash (manifest body +
    //      anchor file contents) matches its stored quality_input_hash AND
    //      the prior quality_score still passes, reuse the prior score.
    //      A re-run on identical inputs costs zero LLM calls.
    let qualityScore = null, qualityVerdict = null, qualityScores = null, refineRounds = 0, skipReason = null;

    if (validate && !validateScope.has(sys.name)) {
      skipReason = 'incremental-out-of-scope';
    } else if (validate && skipUnchanged) {
      try {
        const inputHash = computeQualityInputHash(repoRoot, p2.outPath, sys.globs || []);
        const cached = readCachedQuality(p2.outPath);
        if (cached && cached.input_hash === inputHash && cached.score != null && cached.score >= minScore) {
          qualityScore = cached.score;
          qualityVerdict = cached.verdict || 'ship';
          skipReason = 'cache-hit';
        }
      } catch { /* cache failures are non-fatal — fall through to a real validate */ }
    }

    if (validate && !skipReason) {
      try {
        if (refine) {
          const r = await refineSystem(repoRoot, sys, {
            minScore, maxRounds, generateFirst: false,
            genRunner: runner, judgeRunner: meteredJudge,
          });
          qualityScore = r.finalScore; qualityVerdict = r.finalVerdict; qualityScores = r.finalScores; refineRounds = r.rounds.length;
        } else {
          const v = await validateSystem(repoRoot, p2.outPath, { runner: meteredJudge });
          qualityScore = v.scores.overall; qualityVerdict = v.verdict; qualityScores = v.scores;
        }
        // Stamp score + verdict + input hash. The hash lets the NEXT run
        // detect "inputs unchanged" and skip the LLM call entirely (huge
        // savings on incremental + repeat-on-same-state).
        const inputHash = (() => { try { return computeQualityInputHash(repoRoot, p2.outPath, sys.globs || []); } catch { return null; } })();
        writeQualityScore(p2.outPath, qualityScore, qualityVerdict, inputHash);
        // Gate: below the bar (or judge says split) → needs-review.
        if (qualityScore < minScore || qualityVerdict === 'split') status = 'needs-review';
      } catch (e) {
        log(`  ! ${sys.name}: quality phase failed (non-fatal): ${e.message}`);
      }
    } else if (skipReason === 'cache-hit') {
      // Cached pass: don't re-stamp (already correct) but still gate.
      if (qualityScore < minScore) status = 'needs-review';
    }

    const elapsed = Date.now() - stepStart;
    const scoreStr = qualityScore != null ? ` ${qualityScore}/10` : '';
    const skipStr = skipReason ? ` [${skipReason}]` : '';
    log(`  ${status === 'active' ? '✓' : '✗'} ${sys.name}${scoreStr}${skipStr} (${attempts} structural retries, ${refineRounds} refine rounds, ${Math.round(elapsed / 1000)}s)`);
    telemetry.steps.push({ pass: 2, system: sys.name, status, attempts, refineRounds, qualityScore, skipReason, elapsed_ms: elapsed });
    return {
      name: sys.name,
      status,
      attempts,
      problems: vet.problems,
      qualityScore,
      qualityVerdict,
      qualityScores,   // per-dimension breakdown (correctness/completeness/sizing/diagram/clarity)
      refineRounds,
      skipReason,
      elapsed_ms: elapsed,
      // Observability: initial vet (before revise) + LLM judge findings, so
      // the viewer can show "what did the pipeline catch?" not just the
      // final-passing state. `vet.problems` above is the POST-revise list.
      initialVetStatus: initialVet.status,
      initialVetProblems: initialVet.problems,
      llmFindings: initialVet.llmFindings,
    };
   } catch (e) {
    // A single system's terminal failure (e.g. claude -p still erroring
    // after retries under sustained rate-limit) must NOT abort the whole
    // sweep. Mark it errored and continue — the run completes with a
    // partial-but-usable table instead of crashing on system #N of 30.
    log(`  ✗ ${sys.name}: FAILED (${e.message?.slice(0, 120)})`);
    telemetry.steps.push({ pass: 2, system: sys.name, status: 'error', error: String(e.message || e), elapsed_ms: Date.now() - stepStart });
    return { name: sys.name, status: 'error', error: String(e.message || e), problems: [], qualityScore: null, elapsed_ms: Date.now() - stepStart };
   }
  });

  // Prune orphans — full-rewrite semantics. Any manifest not generated this
  // run is deleted (renamed/removed systems leave no stragglers).
  const pruned = pruneOrphans(repoRoot, results.map(r => r.name), log);

  // Organize — LLM categorizes the COMPLETE set into semantic folders.
  // Runs after everything exists (needs the full picture), re-anchored on
  // the prior _categories.json to reduce name drift.
  try {
    log('Organize: LLM folder categorization…');
    const org = await runOrganize(repoRoot, { runner });
    log(`organized into ${org.categories.length} categories`);
  } catch (e) {
    log(`organize failed (non-fatal, build falls back to glob-dir grouping): ${e.message}`);
  }

  // Pass 3 — rebuild the static HTML viewer + the registry composite so the
  // rendered diagrams reflect the freshly-generated manifests.
  let built = null;
  try {
    log('Pass 3: build static HTML…');
    built = buildSite({ root: repoRoot, out: 'docs/systems.html' });
    log(`built ${built.outFile} (${built.systems} systems)`);
  } catch (e) {
    log(`build failed (non-fatal): ${e.message}`);
  }

  const scored = results.filter(r => typeof r.qualityScore === 'number');
  const avgScore = scored.length
    ? Math.round((scored.reduce((a, r) => a + r.qualityScore, 0) / scored.length) * 10) / 10
    : null;
  telemetry.finishedAt = new Date().toISOString();
  const skippedCache = results.filter(r => r.skipReason === 'cache-hit').length;
  const skippedOutOfScope = results.filter(r => r.skipReason === 'incremental-out-of-scope').length;
  const skippedBudget = results.filter(r => r.status === 'skipped-budget').length;
  telemetry.summary = {
    total: results.length,
    active: results.filter(r => r.status === 'active').length,
    needsReview: results.filter(r => r.status === 'needs-review').length,
    errored: results.filter(r => r.status === 'error').length,
    skippedCache, skippedOutOfScope, skippedBudget,
    pruned: pruned.length,
    built: !!built,
    avgQualityScore: avgScore,
    belowBar: scored.filter(r => r.qualityScore < minScore).map(r => `${r.name} (${r.qualityScore})`),
    tokensEst: meter.tokens,
    tokenBudget: meter.budget,
    budgetAborted: meter.abort,
  };
  log(`done. ${telemetry.summary.active}/${telemetry.summary.total} active, ${telemetry.summary.needsReview} needs-review, ${telemetry.summary.errored} errored, ${pruned.length} pruned${avgScore != null ? `, avg quality ${avgScore}/10` : ''}.`);
  const savedFrom = skippedCache + skippedOutOfScope;
  if (savedFrom) log(`cost savers: ${skippedCache} cache-hit, ${skippedOutOfScope} out-of-scope (skipped LLM judge)`);
  log(`tokens (est): ${meter.tokens.toLocaleString()} / budget ${meter.budget.toLocaleString()}${meter.abort ? ' — BUDGET ABORT FIRED' : ''}`);
  if (telemetry.summary.belowBar.length) {
    log(`below bar (<${minScore}): ${telemetry.summary.belowBar.join(', ')}`);
  }

  // Persist a structured run report so the viewer can show what failed +
  // why. Frontmatter only carries the final score; this file carries the
  // path TO that score (vet problems, retries, judge findings, errors).
  try {
    writeRunReport(repoRoot, { telemetry, results, pruned, minScore, llmVetEnabled: !!llmVet });
  } catch (e) {
    log(`run-report write failed (non-fatal): ${e.message}`);
  }

  return { telemetry, results, hypothesisPath: p1Result.outPath, pruned, built };
}

/**
 * Write docs/systems/.run-report.json. One file per repo — overwritten each
 * run. Schema is intentionally flat + future-proof: viewers should treat
 * unknown fields as opaque so new pass-output fields don't break old views.
 *
 * The file is dotfile-named so it doesn't appear in the manifest glob the
 * loader picks up (`docs/systems/*.md`) and doesn't get auto-rendered as a
 * system page.
 */
export function writeRunReport(repoRoot, { telemetry, results, pruned, minScore, llmVetEnabled }) {
  const dir = join(repoRoot, 'docs', 'systems');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const outPath = join(dir, '.run-report.json');
  const report = {
    schemaVersion: 1,
    startedAt: telemetry.startedAt,
    finishedAt: telemetry.finishedAt,
    minScore,
    llmVetEnabled,
    summary: telemetry.summary,
    pruned,
    systems: results.map(r => ({
      name: r.name,
      status: r.status,
      qualityScore: r.qualityScore ?? null,
      qualityVerdict: r.qualityVerdict ?? null,
      qualityScores: r.qualityScores ?? null,   // per-dimension breakdown (made ci-test-gate's 3.7 diagnosable)
      refineRounds: r.refineRounds ?? 0,
      reviseAttempts: r.attempts ?? 0,
      skipReason: r.skipReason ?? null,
      elapsedMs: r.elapsed_ms ?? null,
      error: r.error ?? null,
      // post-revise problems (what's still wrong after retries)
      finalProblems: r.problems ?? [],
      // pre-revise problems (what the pipeline caught originally)
      initialProblems: r.initialVetProblems ?? [],
      initialVetStatus: r.initialVetStatus ?? null,
      llmFindings: r.llmFindings ?? null,
    })),
  };
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  return outPath;
}

/** Read the most recent run report, or null if no run has completed yet. */
export function readRunReport(repoRoot) {
  const p = join(repoRoot, 'docs', 'systems', '.run-report.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}
