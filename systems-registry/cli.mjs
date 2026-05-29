#!/usr/bin/env node
/**
 * systems-registry CLI.
 *
 *   systems-registry detect           list detected systems (table)
 *   systems-registry detect --json    machine-readable
 *   systems-registry scaffold <name>  write skeleton manifest (or --all)
 *   systems-registry status           list registered systems
 */

import { execFileSync } from 'node:child_process';
import { relative } from 'node:path';

import { detect } from './detect.mjs';
import { loadAll } from './registry.mjs';
import { writeManifest } from './scaffold.mjs';
import { startServer } from './view.mjs';
import { buildSite } from './build-static.mjs';
import { runPass1 } from './pass1.mjs';
import { vetSystem } from './pass25-vet.mjs';
import { runPipeline, parseHypothesisSystems } from './run-pipeline.mjs';
import { refreshIncremental } from './refresh.mjs';
import { generateBody } from './pass2.mjs';
import { validateSystem, describeCommand } from './validate.mjs';
import { refineSystem } from './refine.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function repoRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    return process.cwd();
  }
}

function cmdDetect(args) {
  const root = repoRoot();
  const found = detect(root);
  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify(found, null, 2) + '\n');
    return 0;
  }
  if (found.length === 0) {
    process.stdout.write('No systems detected.\n');
    return 0;
  }
  process.stdout.write(`Detected ${found.length} system(s):\n\n`);
  for (const s of found) {
    process.stdout.write(`  ${s.name}  (score ${s.score})\n`);
    process.stdout.write(`    dir:     ${s.dir}\n`);
    process.stdout.write(`    signals: ${s.signals.join(', ')}\n`);
    process.stdout.write(`    anchors: ${s.anchors.slice(0, 4).join(', ')}${s.anchors.length > 4 ? ` (+${s.anchors.length - 4} more)` : ''}\n`);
    process.stdout.write('\n');
  }
  return 0;
}

function cmdScaffold(args) {
  const root = repoRoot();
  const found = detect(root);
  const force = args.includes('--force');
  const all = args.includes('--all');
  const target = args.find(a => !a.startsWith('--'));

  const targets = all ? found : (target ? found.filter(s => s.name === target) : []);
  if (targets.length === 0) {
    process.stderr.write(target
      ? `No detected system named "${target}". Run \`systems-registry detect\` to list candidates.\n`
      : `Usage: systems-registry scaffold <name>  |  --all  [--force]\n`);
    return 1;
  }

  let written = 0;
  for (const t of targets) {
    const r = writeManifest(root, t, { force });
    if (r.written) {
      process.stdout.write(`wrote ${relative(root, r.path)}\n`);
      written++;
    } else {
      process.stdout.write(`skipped ${relative(root, r.path)} (${r.reason}; pass --force to overwrite)\n`);
    }
  }
  process.stdout.write(`\n${written} of ${targets.length} manifest(s) written.\n`);
  return 0;
}

function cmdStatus() {
  const root = repoRoot();
  const systems = loadAll(root);
  if (systems.length === 0) {
    process.stdout.write('No registered systems.\n');
    return 0;
  }
  process.stdout.write(`${systems.length} registered system(s):\n\n`);
  for (const s of systems) {
    process.stdout.write(`  ${s.name}\n`);
    process.stdout.write(`    summary: ${(s.summary || '').slice(0, 80)}\n`);
    process.stdout.write(`    globs:   ${Array.isArray(s.globs) ? s.globs.length : 0}\n`);
    process.stdout.write(`    page:    ${s._relPath}\n`);
    process.stdout.write('\n');
  }
  return 0;
}

async function cmdView(args) {
  const portArg = args.indexOf('--port');
  const port = portArg !== -1 ? Number(args[portArg + 1] || 0) : 0;
  const open = !args.includes('--no-open');
  const { server } = await startServer({ port, open });
  // Stay alive until SIGINT
  process.on('SIGINT', () => { server.close(); process.exit(0); });
  return new Promise(() => {});  // never resolves; server holds the event loop
}

async function cmdHypothesis(args) {
  const dryRun = args.includes('--dry-run');
  const root = repoRoot();
  process.stdout.write(`Pass 1 hypothesis — gathering inputs${dryRun ? ' (dry-run)' : ''}…\n`);
  const result = await runPass1(root, { dryRun });
  if (dryRun) {
    process.stdout.write(`prompt length: ${result.prompt.length} chars (~${Math.round(result.prompt.length / 4 / 1024)}k tokens)\n`);
    process.stdout.write(`candidates: ${result.inputs.candidates.length}\n`);
    process.stdout.write(`docgen summaries: ${result.inputs.docgenSummaries.length}\n`);
    process.stdout.write(`coordinator snippets: ${result.inputs.coordinatorSnippets.length}\n`);
    process.stdout.write(`import-graph edges: ${result.inputs.importGraph.length}\n`);
    process.stdout.write(`prior hypothesis: ${result.inputs.priorHypothesis ? 'yes' : 'no'}\n`);
    process.stdout.write(`prior systems: ${result.inputs.priorSystems.length}\n`);
    return 0;
  }
  process.stdout.write(`wrote ${result.outPath}\n`);
  return 0;
}

function cmdBuild(args) {
  const outArg = args.indexOf('--out');
  // Default: docs/systems.html (single self-contained file, committed to the
  // repo, opens via file:// — no server, no hosting needed). Pages CI passes
  // --out dist/systems for the directory layout with .nojekyll.
  const out = outArg !== -1 ? args[outArg + 1] : 'docs/systems.html';
  const r = buildSite({ out });
  process.stdout.write(`built ${r.outFile}  (${r.systems} systems, mode: ${r.mode}, composite: ${r.composite ? 'yes' : 'no'})\n`);
  return 0;
}

async function cmdVet(args) {
  const { readdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const root = repoRoot();
  const cheapOnly = args.includes('--cheap-only');
  const targetArg = args.indexOf('--target');
  const target = targetArg !== -1 ? args[targetArg + 1] : null;

  const dir = join(root, 'docs/systems');
  const files = readdirSync(dir).filter(f =>
    f.endsWith('.md') && f !== 'README.md' && !f.startsWith('_')
  );
  const toCheck = target ? files.filter(f => f.replace(/\.md$/, '') === target) : files;
  if (toCheck.length === 0) {
    process.stderr.write(`no manifests to vet${target ? ` (target "${target}" not found)` : ''}\n`);
    return 1;
  }

  process.stdout.write(`Pass 2.5 vet: checking ${toCheck.length} manifest(s)${cheapOnly ? ' (cheap checks only)' : ''}…\n`);
  let failed = 0;
  for (const f of toCheck) {
    const p = join(dir, f);
    const r = await vetSystem(root, p, { llm: !cheapOnly });
    if (r.status === 'ok') {
      process.stdout.write(`  ✓ ${f}\n`);
    } else {
      failed++;
      process.stdout.write(`  ✗ ${f} — ${r.problems.length} issue(s):\n`);
      for (const issue of r.problems) {
        process.stdout.write(`      [${issue.kind}] ${issue.detail || ''}\n`);
      }
    }
  }
  process.stdout.write(`\n${failed} of ${toCheck.length} manifest(s) flagged.\n`);
  return failed > 0 ? 1 : 0;
}

// Pass 2 only — regenerate one system's body (or all) from the existing
// _hypothesis.md, without re-running Pass 1 or Pass 2.5 / 2.6. Surgical
// tool for filling in stragglers after a crashed `run` without rewriting
// systems that succeeded. The CLI help advertised this; it was never
// implemented upstream — adding it here.
async function cmdBodies(args) {
  const root = repoRoot();
  const tgtIdx = args.indexOf('--target');
  const target = tgtIdx !== -1 ? args[tgtIdx + 1] : null;
  const hypPath = join(root, 'docs/systems/_hypothesis.md');
  if (!existsSync(hypPath)) {
    process.stderr.write(`no _hypothesis.md at ${hypPath}; run \`hypothesis\` or \`run\` first.\n`);
    return 1;
  }
  const systems = parseHypothesisSystems(hypPath);
  const todo = target ? systems.filter(s => s.name === target) : systems;
  if (todo.length === 0) {
    process.stderr.write(target ? `no system named "${target}" in hypothesis.\n` : 'hypothesis has no systems.\n');
    return 1;
  }
  let failed = 0;
  for (const sys of todo) {
    process.stdout.write(`generating ${sys.name}…\n`);
    try {
      const r = await generateBody(root, sys, {});
      process.stdout.write(`  → ${r.outPath}\n`);
    } catch (e) {
      process.stderr.write(`  ✗ ${sys.name}: ${e.message}\n`);
      failed++;
    }
  }
  return failed > 0 ? 1 : 0;
}

// Pass 2.7 — LLM-as-judge validation of a single system manifest.
//   validate --target <name> [--dry-run] [--json]
// --dry-run prints the exact judge command + prompt without running it
// (this is the "documentation lives in the command" surface).
async function cmdValidate(args) {
  const root = repoRoot();
  const t = args.indexOf('--target');
  const target = t !== -1 ? args[t + 1] : null;
  if (!target) { process.stderr.write('usage: validate --target <name> [--dry-run] [--json]\n'); return 1; }
  const manifestPath = join(root, 'docs/systems', `${target}.md`);
  const dryRun = args.includes('--dry-run');

  const r = await validateSystem(root, manifestPath, { dryRun });
  if (dryRun) {
    process.stdout.write(`# judge command: ${r.command.display}  (${r.command.source})\n`);
    process.stdout.write(`# set SYSREG_JUDGE_CMD to use codex / gemini / etc.\n\n`);
    process.stdout.write(r.prompt + '\n');
    return 0;
  }
  if (args.includes('--json')) { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); return 0; }
  const sc = r.scores;
  process.stdout.write(`${target}: ${sc.overall}/10 (${r.verdict})\n`);
  process.stdout.write(`  correctness ${sc.correctness}  completeness ${sc.completeness}  sizing ${sc.sizing}  diagram ${sc.diagram}  clarity ${sc.clarity}\n`);
  if (r.sizing_note) process.stdout.write(`  sizing: ${r.sizing_note}\n`);
  for (const i of r.issues) process.stdout.write(`  ✗ ${i}\n`);
  for (const s of r.suggestions) process.stdout.write(`  → ${s}\n`);
  return sc.overall >= 7 ? 0 : 1;
}

// Refine loop — generate ⇄ validate until score >= --min-score.
//   refine --target <name> [--min-score 7] [--max-rounds 2]
async function cmdRefine(args) {
  const root = repoRoot();
  const t = args.indexOf('--target');
  const target = t !== -1 ? args[t + 1] : null;
  if (!target) { process.stderr.write('usage: refine --target <name> [--min-score N] [--max-rounds N]\n'); return 1; }
  const msIdx = args.indexOf('--min-score');
  const mrIdx = args.indexOf('--max-rounds');
  const minScore = msIdx !== -1 ? Number(args[msIdx + 1]) : 7;
  const maxRounds = mrIdx !== -1 ? Number(args[mrIdx + 1]) : 2;

  // Pull the system's hypothesis entry (name/globs/summary) so regen has
  // the same inputs the pipeline uses.
  const hypPath = join(root, 'docs/systems/_hypothesis.md');
  const systems = existsSync(hypPath) ? parseHypothesisSystems(hypPath) : [];
  let entry = systems.find(s => s.name === target);
  if (!entry) {
    // Fall back to the manifest's own front-matter globs.
    const mp = join(root, 'docs/systems', `${target}.md`);
    if (!existsSync(mp)) { process.stderr.write(`no manifest or hypothesis entry for "${target}"\n`); return 1; }
    const fm = readFileSync(mp, 'utf8');
    const { parseGlobsFromFrontMatter } = await import('./validate.mjs');
    entry = { name: target, globs: parseGlobsFromFrontMatter(fm), summary: '' };
  }

  const { display, source } = describeCommand();
  process.stdout.write(`refining ${target} → target ${minScore}/10, ≤${maxRounds} rounds (judge: ${display}, ${source})\n`);
  const res = await refineSystem(root, entry, {
    minScore, maxRounds,
    log: m => process.stdout.write(m + '\n'),
  });
  process.stdout.write(`\n=== ${target}: ${res.status} — final ${res.finalScore}/10 ===\n`);
  for (const r of res.rounds) process.stdout.write(`  round ${r.round}: ${r.score}/10 (${r.verdict})\n`);
  if (res.status === 'needs-split') {
    process.stdout.write(`  ⚠ verdict=split — this system is too big; consider breaking it up (human decision).\n`);
  }
  return res.status === 'passed' ? 0 : 1;
}

async function cmdRun(args) {
  const root = repoRoot();
  const llmVet = args.includes('--llm-vet');
  // Quality phase defaults ON; opt out per flag. --min-score / --max-rounds tune it.
  const validate = !args.includes('--no-validate');
  const refine = validate && !args.includes('--no-refine');
  const msIdx = args.indexOf('--min-score');
  const mrIdx = args.indexOf('--max-rounds');
  const minScore = msIdx !== -1 ? Number(args[msIdx + 1]) : 7;
  const maxRounds = mrIdx !== -1 ? Number(args[mrIdx + 1]) : 2;

  // Cost controls. --changed accepts a comma-list of paths (push-hook style);
  // --since <sha> reads `git diff --name-only <sha>..HEAD` instead. Either
  // restricts the LLM judge to in-scope systems + downstream. --no-cache
  // forces re-validation of unchanged docs. --max-tokens sets the budget abort.
  let changedFiles = null;
  const cIdx = args.indexOf('--changed');
  const sIdx = args.indexOf('--since');
  if (cIdx !== -1) {
    changedFiles = (args[cIdx + 1] || '').split(',').map(s => s.trim()).filter(Boolean);
  } else if (sIdx !== -1) {
    try {
      const out = execFileSync('git', ['-C', root, 'diff', '--name-only', `${args[sIdx + 1]}..HEAD`], { encoding: 'utf8' });
      changedFiles = out.split('\n').map(s => s.trim()).filter(Boolean);
    } catch { /* fall through to full sweep */ }
  }
  const skipUnchanged = !args.includes('--no-cache');
  const mtIdx = args.indexOf('--max-tokens');
  const maxTokensEst = mtIdx !== -1 ? Number(args[mtIdx + 1]) : 10_000_000;

  const result = await runPipeline(root, {
    llmVet, validate, refine, minScore, maxRounds,
    changedFiles, skipUnchanged, maxTokensEst,
  });
  process.stdout.write(`\n=== summary ===\n`);
  process.stdout.write(`hypothesis: ${result.hypothesisPath}\n`);
  process.stdout.write(`systems: ${result.results.length}\n`);
  for (const s of result.results) {
    const sc = typeof s.qualityScore === 'number' ? ` ${s.qualityScore}/10` : '';
    process.stdout.write(`  ${s.status === 'active' ? '✓' : '✗'} ${s.name}${sc} (${s.attempts} retries, ${s.problems.length} issues)\n`);
  }
  const sum = result.telemetry.summary;
  process.stdout.write(`${sum.active}/${sum.total} active, ${sum.needsReview} needs-review${sum.avgQualityScore != null ? `, avg quality ${sum.avgQualityScore}/10` : ''}\n`);
  return sum.needsReview > 0 ? 1 : 0;
}

async function cmdRefresh(args) {
  const root = repoRoot();
  const changedArg = args.indexOf('--changed');
  const sinceArg = args.indexOf('--since');
  let changedFiles;
  if (changedArg !== -1) {
    changedFiles = (args[changedArg + 1] || '').split(',').map(s => s.trim()).filter(Boolean);
  } else {
    // Compute changed files via git diff against --since <sha> (default: last commit).
    const since = sinceArg !== -1 ? args[sinceArg + 1] : 'HEAD~1';
    try {
      const out = execFileSync('git', ['-C', root, 'diff', '--name-only', `${since}..HEAD`], { encoding: 'utf8' });
      changedFiles = out.split('\n').map(s => s.trim()).filter(Boolean);
    } catch {
      process.stderr.write(`could not compute git diff from ${since}; pass --changed instead\n`);
      return 1;
    }
  }
  process.stdout.write(`refresh: ${changedFiles.length} changed file(s)\n`);
  const r = await refreshIncremental(root, changedFiles, {});
  if (r.skipped) { process.stdout.write('nothing to regenerate.\n'); return 0; }
  process.stdout.write(`\nregenerated ${r.regenerated.length} system(s):\n`);
  for (const s of r.regenerated) {
    process.stdout.write(`  ${s.status === 'active' ? '✓' : '✗'} ${s.name}\n`);
  }
  return 0;
}

function help() {
  process.stdout.write(`systems-registry — detect + scaffold + index complex systems

USAGE
  systems-registry detect [--json]          list detected systems
  systems-registry scaffold <name>          write skeleton manifest
  systems-registry scaffold --all           scaffold every detected system
  systems-registry status                   list registered systems
  systems-registry view [--port N] [--no-open]
                                            open browser viewer with rendered Mermaid
  systems-registry hypothesis [--dry-run]   Pass 1: synthesize systems via LLM
                                            writes docs/systems/_hypothesis.md
                                            --dry-run prints prompt stats, no LLM call
  systems-registry vet [--cheap-only] [--target <name>]
                                            Pass 2.5: validate manifests against code
                                            cheap checks always run; --cheap-only skips LLM
  systems-registry run [--llm-vet] [--no-validate] [--no-refine]
                       [--min-score 7] [--max-rounds 2]
                       [--changed a,b,c | --since <sha>]
                       [--no-cache] [--max-tokens N]
                                            E2E full rewrite: Pass 1 → 2 → 2.5 → 2.6 →
                                            2.7 (validate+refine, ON by default) →
                                            organize → build. --no-validate skips the
                                            judge; --no-refine scores once without the
                                            regenerate loop. Stamps quality_score into
                                            each manifest; gates below --min-score to
                                            needs-review.
                                            Cost controls: --changed/--since restrict
                                            the LLM judge to systems whose globs match
                                            changed files + downstream consumers (~95%
                                            cheaper for push-hook usage). --no-cache
                                            forces re-validation of unchanged docs.
                                            --max-tokens N (default 10M) is a safety
                                            abort if a run runs away on cost.
  systems-registry refresh [--changed a,b | --since <sha>]
                                            Incremental: regenerate ONLY systems whose
                                            anchors changed (+ new candidates), then organize + build
  systems-registry bodies [--target <name>] Pass 2: read _hypothesis.md, generate
                                            per-system body manifests for each entry
                                            --target filters to one system
  systems-registry validate --target <name> [--dry-run] [--json]
                                            Pass 2.7: LLM-as-judge scores the manifest
                                            0-10 on correctness/completeness/sizing/
                                            diagram/clarity vs the real source. --dry-run prints
                                            the judge command + prompt without running.
                                            Judge model: SYSREG_JUDGE_CMD env (codex /
                                            gemini / …), default claude -p.
  systems-registry refine --target <name> [--min-score 7] [--max-rounds 2]
                                            Loop generate⇄validate until score >= min.
                                            Stops early on verdict=split (human call).
  systems-registry build [--out PATH]       build a static HTML file or dir
                                            default: docs/systems.html (single file, commit-friendly)
                                            --out path/to/file.html → single file
                                            --out some/dir          → dir/index.html + .nojekyll (Pages)
`);
}

const [, , cmd, ...rest] = process.argv;
async function main() {
  switch (cmd) {
    case 'detect':     return cmdDetect(rest);
    case 'scaffold':   return cmdScaffold(rest);
    case 'status':     return cmdStatus(rest);
    case 'hypothesis': return cmdHypothesis(rest);
    case 'vet':        return cmdVet(rest);
    case 'bodies':     return cmdBodies(rest);
    case 'validate':   return cmdValidate(rest);
    case 'refine':     return cmdRefine(rest);
    case 'run':        return cmdRun(rest);
    case 'refresh':    return cmdRefresh(rest);
    case 'view':     return cmdView(rest);
    case 'build':    return cmdBuild(rest);
    case 'help':
    case '--help':
    case '-h':
    case undefined:  help(); return 0;
    default:
      process.stderr.write(`unknown command: ${cmd}\n`);
      help();
      return 1;
  }
}
main().then(code => process.exit(code ?? 0));
