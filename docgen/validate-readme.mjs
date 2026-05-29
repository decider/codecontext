#!/usr/bin/env node
/**
 * docgen — LLM-as-judge validator for generated per-directory AUTO_DOCS.md.
 *
 * Sister to systems-registry's validate.mjs, ported to docgen's unit of
 * work: a single directory's `AUTO_DOCS.md` judged against the ACTUAL files
 * in that directory. Catches the failure mode docgen's own generation
 * can't self-detect — a Map bullet pointing at a `file · Symbol` that
 * doesn't exist, a Gotcha that isn't true of the code, a load-bearing
 * file left undocumented.
 *
 * Scores 0-10 on correctness / completeness / sizing, with the same hard
 * cap as systems-registry: ANY defect → overall ≤7. Gate defaults to 7.
 *
 * ── Pluggable judge ───────────────────────────────────────────────────
 * Default `claude -p` (the only LLM CLI docgen already depends on, so
 * this works for everyone who vendors docgen). `DOCGEN_JUDGE_CMD` points
 * the judge at any stdin→stdout CLI (codex / gemini / …) for stronger,
 * less self-blind cross-model evaluation:
 *
 *     DOCGEN_JUDGE_CMD="codex exec"  node validate-readme.mjs apps/api/src
 *     DOCGEN_JUDGE_CMD="gemini -p"   node validate-readme.mjs apps/api/src
 *
 * Self-contained (no import from systems-registry) so docgen stays a
 * standalone vendored tool. Runner is injectable for hermetic tests.
 *
 * CLI:
 *   node validate-readme.mjs <dir> [--dry-run] [--json]
 *     --dry-run  print the judge command + prompt, run nothing
 *     --json     machine-readable result
 *   exit 0 if overall >= 7, else 1 (CI gate).
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { spawn } from 'node:child_process';

/** The docgen-owned doc filename (must match docgen.mjs DOC_FILENAME). */
const DOC_FILENAME = 'AUTO_DOCS.md';

const WEIGHTS = { correctness: 0.45, completeness: 0.35, sizing: 0.20 };
// Per-file byte cap raised from 6000 → 10240 to match systems-registry. The
// old cap routinely truncated mid-function (~120 lines of TS), cutting
// off second-half symbols and error paths that the README claimed to
// describe — judge then flagged "unverified" on real claims simply
// because their evidence was past the cap. 10KB lets typical handlers
// fit whole. Cost is linear in MAX_FILES (24*4KB = 96KB extra prompt).
const FILE_BYTE_CAP = 10240;
const MAX_FILES = 24;           // cap files embedded (deterministic order)
const PASS_BAR = 7;             // gate; any-defect hard-caps to 7 anyway
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.pdf', '.lock', '.map', '.min.js', '.woff', '.woff2', '.ttf']);

// ─── retry (transient claude -p blips shouldn't fail a validation) ──────
export async function withRetry(fn, { retries = 2, baseDelayMs = 8000 } = {}) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); }
    catch (e) { last = e; if (i === retries) break; await new Promise(r => setTimeout(r, baseDelayMs * (i + 1))); }
  }
  throw last;
}

/** The files in `dir` that ground the doc (docgen's own selection rules:
 *  skip AUTO_DOCS.md + README.md, dotfiles, binary/lock extensions). */
export function selectDirFiles(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || e.name === DOC_FILENAME || e.name === 'README.md' || e.name.startsWith('.')) continue;
    if (SKIP_EXT.has(extname(e.name).toLowerCase())) continue;
    const full = join(dir, e.name);
    let st; try { st = statSync(full); } catch { continue; }
    out.push({ name: e.name, full, size: st.size });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out.slice(0, MAX_FILES);
}

/** Build the judge prompt. Pure — tests assert structure; --dry-run prints it. */
export function buildReadmeValidatePrompt({ readme, files, dirLabel }) {
  const p = [];
  p.push('You are a STRICT reviewer checking an auto-generated per-directory');
  p.push(`AUTO_DOCS.md against the ACTUAL files in \`${dirLabel}\`.`);
  p.push('');
  p.push('docgen AUTO_DOCS.md have: a Purpose line, a "Map" (bullets of the form');
  p.push('`concept → file · Symbol`), optional Subdirectories, Dependencies,');
  p.push('and Gotchas. The Map symbols MUST exist in the files; the Gotchas');
  p.push('MUST be true of the code.');
  p.push('');
  p.push('## How to review — DO NOT TRUST THE README');
  p.push('Work claim-by-claim. For every Map bullet, find the named symbol in');
  p.push('the file it points to. For every Gotcha/dependency, find the code');
  p.push('that backs it. A symbol or path you cannot locate in the files below');
  p.push('is a HALLUCINATION → an issue. A load-bearing file with no Map entry');
  p.push('is a completeness gap. Do not give claims the benefit of the doubt.');
  p.push('');
  p.push('## The README under review');
  p.push('```markdown');
  p.push(readme);
  p.push('```');
  p.push('');
  p.push('## The actual files in the directory (truncated)');
  for (const f of files) {
    p.push(`### ${f.name}`);
    p.push('```');
    p.push(f.content);
    p.push('```');
    p.push('');
  }
  p.push('## Score each 0-10');
  p.push('- **correctness** — every Map symbol/path exists; every Gotcha is');
  p.push('  true. Penalize hallucinated symbols, wrong file attributions,');
  p.push('  invented gotchas. (weight .45)');
  p.push('- **completeness** — run the CHECKLIST below — every "no" is a');
  p.push('  defect and goes in `missing`. Load-bearing files covered, no');
  p.push('  major file silently omitted, Purpose matches what the dir');
  p.push('  actually does. (.35)');
  p.push('- **sizing** — right-sized for the dir: not a 2-line stub for a');
  p.push('  20-file module, not bloated prose for a 1-file dir. (.20)');
  p.push('');
  p.push('## Completeness checklist — every miss is a `missing` entry');
  p.push('');
  p.push('Before scoring completeness, walk this list against the files above.');
  p.push('');
  p.push('1. **Every file** (excluding tests, type-only `.d.ts`, configs) is');
  p.push('   represented somewhere in the Map. Not every file needs its own');
  p.push('   bullet, but a file that exports the dir\'s main entry points or');
  p.push('   declares the dominant logic CANNOT be silently omitted.');
  p.push('2. **Every exported entry point** (top-level `export` of a function,');
  p.push('   class, handler, or default — `pub fn`, `pub struct` for Rust)');
  p.push('   appears in the Map with the right file·Symbol citation.');
  p.push('3. **Cross-file dependencies inside this dir** — if file A imports');
  p.push('   from file B and that wiring is load-bearing, the relationship');
  p.push('   is described.');
  p.push('4. **Any side-effecting symbols** — emitted events, `INSERT INTO`,');
  p.push('   `db.query`, `fetch(`, `spawn(`, log markers with stable prefixes');
  p.push('   used as grep targets — are documented (a Gotcha bullet, a Map');
  p.push('   line, or a Dependency).');
  p.push('5. **Decision logic** — if any file in the dir computes a');
  p.push('   decision (strategy weights, a router pick, a ranking, what to');
  p.push('   run next), the HOW is at least one-line summarized, not just');
  p.push('   "X.compute() is called from Y".');
  p.push('');
  p.push('Be generous with `missing`. If the dir has 6 source files and the');
  p.push('Map has 3 bullets, that\'s 3 missing items (unless the omitted files');
  p.push('are genuinely trivial). Empty `missing` only when every checklist');
  p.push('item is genuinely covered.');
  p.push('');
  p.push('## HARD CAP');
  p.push('ANY defect — one hallucinated symbol, one wrong path, one false');
  p.push('gotcha, one omitted load-bearing file, however small — caps overall');
  p.push('at 7. 8+ asserts the README is FLAWLESS against the files. Non-empty');
  p.push('issues/missing ⇒ overall ≤ 7.');
  p.push('');
  p.push('## Output — STRICT JSON ONLY');
  p.push('{"scores":{"correctness":<0-10>,"completeness":<0-10>,"sizing":<0-10>,"overall":<0-10>},');
  p.push(' "verdict":"ship"|"revise",');
  p.push(' "issues":["hallucinated/wrong things"],');
  p.push(' "missing":["load-bearing files/symbols absent from the README"],');
  p.push(' "suggestions":["concrete edits"]}');
  return p.join('\n');
}

/** Tolerant JSON parse + deterministic weighted overall (1 dp) + hard cap. */
export function parseReadmeValidation(text) {
  if (!text || !text.trim()) throw new Error('empty validator response');
  let raw = text.trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) raw = fence[1].trim();
  if (raw[0] !== '{') {
    const i = raw.indexOf('{'), j = raw.lastIndexOf('}');
    if (i === -1 || j === -1 || j < i) throw new Error('no JSON object in validator response');
    raw = raw.slice(i, j + 1);
  }
  let obj;
  try { obj = JSON.parse(raw); } catch (e) { throw new Error(`validator JSON parse failed: ${e.message}`); }
  const s = obj.scores || {};
  const clamp = n => Math.max(0, Math.min(10, Math.round(Number(n) || 0)));
  const scores = { correctness: clamp(s.correctness), completeness: clamp(s.completeness), sizing: clamp(s.sizing) };
  const round1 = x => Math.round(x * 10) / 10;
  scores.overall = round1(WEIGHTS.correctness * scores.correctness + WEIGHTS.completeness * scores.completeness + WEIGHTS.sizing * scores.sizing);
  const arr = v => Array.isArray(v) ? v.map(String) : [];
  const issues = arr(obj.issues), missing = arr(obj.missing);
  if (issues.length || missing.length) scores.overall = Math.min(scores.overall, 7);  // HARD CAP
  return {
    scores,
    verdict: ['ship', 'revise'].includes(obj.verdict) ? obj.verdict : (scores.overall >= PASS_BAR ? 'ship' : 'revise'),
    issues, missing, suggestions: arr(obj.suggestions),
  };
}

/** Resolve judge command: DOCGEN_JUDGE_CMD env, else claude -p. */
export function judgeCommand(model = 'claude-opus-4-7') {
  const override = (process.env.DOCGEN_JUDGE_CMD || '').trim();
  if (override) { const a = override.split(/\s+/); return { cmd: a[0], args: a.slice(1), source: 'DOCGEN_JUDGE_CMD' }; }
  return { cmd: 'claude', args: ['-p', '--model', model, '--output-format', 'text'], source: 'default' };
}

function spawnJudge(prompt, { model, timeoutMs = 12 * 60_000 } = {}) {
  const { cmd, args } = judgeCommand(model);
  return withRetry(() => new Promise((res, rej) => {
    const ch = spawn(cmd, args);
    const out = [], err = [];
    const t = setTimeout(() => { ch.kill('SIGKILL'); rej(new Error(`${cmd} timed out`)); }, timeoutMs);
    ch.stdout.on('data', c => out.push(c));
    ch.stderr.on('data', c => err.push(c));
    ch.on('close', code => { clearTimeout(t); code === 0 ? res(Buffer.concat(out).toString('utf8')) : rej(new Error(`${cmd} exited ${code}: ${Buffer.concat(err).toString('utf8').slice(0, 400)}`)); });
    ch.on('error', e => { clearTimeout(t); rej(e); });
    ch.stdin.end(prompt);
  }));
}

/** Validate one directory's AUTO_DOCS.md against its files. */
export async function validateReadme(dir, { runner, model, dryRun = false, root = process.cwd() } = {}) {
  const readmePath = join(dir, DOC_FILENAME);
  if (!existsSync(readmePath)) throw new Error(`no ${DOC_FILENAME} in ${dir}`);
  const readme = readFileSync(readmePath, 'utf8');
  const files = selectDirFiles(dir).map(f => {
    let content = '(unreadable)';
    try { content = readFileSync(f.full, 'utf8').slice(0, FILE_BYTE_CAP); } catch { /* */ }
    return { name: f.name, content };
  });
  const dirLabel = relative(root, dir) || dir;
  const prompt = buildReadmeValidatePrompt({ readme, files, dirLabel });
  const { cmd, args, source } = judgeCommand(model);
  const command = { display: `${cmd} ${args.join(' ')}`.trim(), source };
  if (dryRun) return { prompt, command, dryRun: true };
  const out = runner ? await runner(prompt) : await spawnJudge(prompt, { model });
  return { ...parseReadmeValidation(out), prompt, command };
}

export const _internal = { WEIGHTS, PASS_BAR };

// ─── CLI ────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const dir = args.find(a => !a.startsWith('--'));
  if (!dir) { process.stderr.write('usage: validate-readme.mjs <dir> [--dry-run] [--json]\n'); process.exit(2); }
  const r = await validateReadme(dir, { dryRun: args.includes('--dry-run') });
  if (r.dryRun) {
    process.stdout.write(`# judge: ${r.command.display} (${r.command.source}) — set DOCGEN_JUDGE_CMD for codex/gemini\n\n${r.prompt}\n`);
    process.exit(0);
  }
  if (args.includes('--json')) { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); process.exit(r.scores.overall >= 7 ? 0 : 1); }
  process.stdout.write(`${dir}: ${r.scores.overall}/10 (${r.verdict})  [correctness ${r.scores.correctness} completeness ${r.scores.completeness} sizing ${r.scores.sizing}]\n`);
  for (const i of r.issues) process.stdout.write(`  ✗ ${i}\n`);
  for (const m of r.missing) process.stdout.write(`  − missing: ${m}\n`);
  for (const s of r.suggestions) process.stdout.write(`  → ${s}\n`);
  process.exit(r.scores.overall >= 7 ? 0 : 1);
}
