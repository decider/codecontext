#!/usr/bin/env node
/**
 * systems-registry — Pass 2.7: LLM-as-judge validator.
 *
 * Scores a generated system manifest against the ACTUAL source code on
 * five dimensions — correctness, completeness, sizing, diagram, clarity —
 * and returns structured feedback the refine loop (refine.mjs) feeds back
 * into Pass 2 until the doc clears a target score. The `diagram` dimension
 * scores the primary `## The loop` Mermaid against the SAME five rules
 * Pass 2 is told to produce (verbs-not-files, labeled edges, subgraph
 * phases, ≤10 nodes, decision diamonds) — so the fitness function tracks
 * the readability surface we actually optimize for.
 *
 * ── Why this exists ───────────────────────────────────────────────────
 * Pass 2.5 (pass25-vet) does CHEAP structural checks (front-matter,
 * glob matches, mermaid syntax, splitting-candidate thresholds) and an
 * OPTIONAL same-shape LLM vet. This is the deeper, holistic judge: "is
 * this doc actually right, complete, and right-sized?" graded 0-10, with
 * a verdict (ship / revise / split) and concrete edits.
 *
 * ── Pluggable judge (portability) ─────────────────────────────────────
 * The tool ships canonical and is synced into other repos, so the only
 * judge guaranteed to exist everywhere is `claude -p` (Pass 1/2 already
 * depend on it). That's the default. But same-model judging is partly
 * blind to the generator's own systematic errors, so a different model
 * makes a stronger judge. Point `SYSREG_JUDGE_CMD` at any CLI that reads
 * a prompt on stdin and writes a response to stdout — codex, gemini,
 * etc. — to use it instead. Examples:
 *
 *     SYSREG_JUDGE_CMD="codex exec"          node cli.mjs validate --target foo
 *     SYSREG_JUDGE_CMD="gemini -p"           node cli.mjs validate --target foo
 *     # default (no env): claude -p --model $JUDGE_MODEL, see models.mjs (judging is a
 *     # discrimination task — Sonnet does it well at ~3x less than Opus)
 *
 * Tests inject a `runner` fn directly so nothing spawns.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { withRetry } from './llm-retry.mjs';

import { gatherInputsFor } from './pass2.mjs';
import { repoMeta } from './repo-meta.mjs';
import { JUDGE_MODEL } from './models.mjs';

// Dimension weights → overall. Correctness dominates (a wrong diagram is
// worse than a pretty one); sizing matters because right-sizing is the
// whole point of the subflow / splitting work; `diagram` carries real
// weight because the primary Mermaid is the FIRST thing a reader sees and
// is exactly what the Pass 2 prompt was rewritten to optimize for — if
// the judge can't see diagram quality, a dramatically-better picture can
// score LOWER on noise. Weights sum to 1.0.
const WEIGHTS = { correctness: 0.4, completeness: 0.25, sizing: 0.15, diagram: 0.1, clarity: 0.1 };

/**
 * Build the judge prompt. Pure function (no IO) so tests can assert the
 * rubric is present without spawning. The rubric is the documentation —
 * it travels inside the prompt, exactly what `--dry-run` prints.
 */
export function buildValidatePrompt({ manifestBody, anchors, repoName }) {
  const p = [];
  p.push('You are a STRICT senior engineer reviewing an auto-generated');
  p.push('"system design" document for accuracy against the real source code.');
  p.push(`Repository: ${repoName || 'this repo'}.`);
  p.push('');
  p.push('A "system" doc has: a one-line summary, file globs, a primary');
  p.push('Mermaid "loop" diagram, optional `## Subflow:` diagrams, anchors');
  p.push('(file → what it does), invariants, and failure modes.');
  p.push('');
  p.push('## How to review — DO NOT TRUST THE DOCUMENT');
  p.push('The document is auto-generated and is OFTEN subtly wrong. Your job is');
  p.push('to disprove it, not confirm it. Work claim-by-claim:');
  p.push('- For EVERY node/edge in each diagram, EVERY anchor, EVERY invariant');
  p.push('  and failure mode, find the exact supporting code in the source');
  p.push('  below. If you cannot point to the line that backs a claim, the');
  p.push('  claim is UNVERIFIED — list it under "issues" (do not give it the');
  p.push('  benefit of the doubt).');
  p.push('- Do not judge files in isolation. Trace how the anchor files relate —');
  p.push('  imports, calls, who-writes / who-reads for any DB table or event,');
  p.push('  the direction of every data-flow edge. Most doc errors are wrong');
  p.push('  EDGES (X reads Y when really X reads Z), not wrong nodes.');
  p.push('- Explore vs exploit: actively look at surrounding/related code the');
  p.push('  doc points to, not just the lines that make the doc look correct.');
  p.push('  A claim you only "mostly" confirmed is an issue, not a pass.');
  p.push('- A defect counts no matter how small: a wrong number, a stale path,');
  p.push('  one fabricated edge, one missing table, one overstated coupling.');
  p.push('');
  p.push('## The document under review');
  p.push('```markdown');
  p.push(manifestBody);
  p.push('```');
  p.push('');
  p.push('## The actual source it claims to describe');
  p.push('(Truncated. Judge correctness against THIS, not against your priors.)');
  for (const a of anchors) {
    p.push(`### ${a.path}`);
    p.push('```');
    p.push(a.content);
    p.push('```');
    p.push('');
  }
  p.push('## Scoring rubric — score each dimension 0-10');
  p.push('');
  p.push('- **correctness** — Do the diagrams, anchors, and invariants match');
  p.push('  what the code ACTUALLY does? Penalize hallucinated symbols/files,');
  p.push('  wrong control flow, invented invariants, edges that do not exist.');
  p.push('- **completeness** — Does it cover the real surface? Run the');
  p.push('  CHECKLIST below — every "no" is a defect and goes in `missing`.');
  p.push('  Penalize missing major flows, missing deployed entrypoints, DB');
  p.push('  tables/events the code uses but the doc omits, missing log markers');
  p.push('  that cross subsystem boundaries, missing failure modes, AND for');
  p.push('  any system that makes a decision (a strategy / router / ranker /');
  p.push('  scheduler) — a missing or hand-wavy description of HOW the');
  p.push('  decision is computed. "Polymorphic StrategyAccount.foo() is');
  p.push('  called" is the API surface, NOT the logic; that fails completeness.');
  p.push('- **sizing** — Is the doc RIGHT-SIZED for the system? 10 = right.');
  p.push('  Penalize BOTH directions: too-thin (a complex multi-file system');
  p.push('  documented in a few lines, no subflows where they are warranted)');
  p.push('  AND too-fat (one doc cramming what should be several systems —');
  p.push('  many unrelated flows, no subflow breakdown, >~12KB body). If');
  p.push('  too-fat, the verdict should be "split"; if too-thin, "revise".');
  p.push('- **diagram** — Score the PRIMARY `## The loop` Mermaid as a PICTURE a');
  p.push('  reader who has never opened the code must understand in 10 seconds.');
  p.push('  Grade it against these FIVE rules (the same ones the generator was');
  p.push('  told to follow). Each rule broken drops the score:');
  p.push('  1. **Verbs, not files.** Nodes name what each step DOES');
  p.push('     (`Generate body per system`), NOT the file it lives in (`pass2.mjs`).');
  p.push('     A diagram whose nodes are bare filenames is a code transcription —');
  p.push('     score it LOW (≤4).');
  p.push('  2. **Every edge is labeled** with what FLOWS across it —');
  p.push('     `A -->|draft manifest| B`, not `A --> B`. A wall of unlabeled');
  p.push('     arrows ("edge soup") tells the reader nothing — score it LOW.');
  p.push('  3. **Grouped into 2-4 `subgraph <Phase>` blocks** the eye can scan');
  p.push('     separately. No subgraphs = a flat wall of boxes the reader must');
  p.push('     chunk themselves — penalize.');
  p.push('  4. **≤ 10 nodes outside subgraphs (≤ 15 total).** More than that means');
  p.push('     the diagram lists every function call instead of collapsing linear');
  p.push('     chains into one labeled node — penalize bloat.');
  p.push('  5. **Decision diamonds `{label?}` for branches**, with labeled case');
  p.push('     edges (`-->|yes|` / `-->|no|`). A branching system with zero');
  p.push('     diamonds is a list pretending to be control-flow — penalize.');
  p.push('  6. **Reads top→bottom in execution order, no inverting back-edge.**');
  p.push('     The entry/trigger stage must be first; the loop must close into a');
  p.push('     TERMINAL sink node, NOT a literal edge from the last stage back up');
  p.push('     to the first (`Last -.-> First`). Such an upward back-edge makes');
  p.push('     mermaid hoist the terminal phase to the top so the picture renders');
  p.push('     BACKWARDS — penalize it (≤6) even if every node/edge is correct.');
  p.push('  Scoring guide: a code-transcription / unlabeled-edge-soup diagram');
  p.push('  scores LOW (≤4); a subgraph-grouped, fully-labeled, diamond-using,');
  p.push('  verb-named diagram of the right size scores HIGH (8-10). A diagram');
  p.push('  that is also factually wrong is BOTH a `diagram` and a `correctness`');
  p.push('  defect — dock both and list it under `issues`.');
  p.push('- **clarity** — Could a new engineer navigate the system from this');
  p.push('  doc alone? Anchors point at real start points, the summary and');
  p.push('  invariants read clearly, subflows are coherent. (Diagram quality is');
  p.push('  scored separately under `diagram` — do not double-count it here.)');
  p.push('');
  p.push('## Completeness checklist — every missing item is a `missing` entry');
  p.push('');
  p.push('Before scoring `completeness`, walk this list against the source.');
  p.push('Each "no" is a concrete missing item — list it under `missing`.');
  p.push('');
  p.push('1. **Every emitted event** the code declares (`emit!(`, `emitCpi!(`,');
  p.push('   `EventEmitter.emit`, etc.) appears in the doc with its parser and');
  p.push('   the DB table or downstream consumer it feeds.');
  p.push('2. **Every cross-subsystem log marker** (e.g. structured `msg!(...)`');
  p.push('   lines parsed by an off-chain reader, `console.log("[X] ...")`');
  p.push('   patterns piped to a log shipper, anything with a stable prefix');
  p.push('   used as a grep target) is documented with its emitter file:fn,');
  p.push('   its fields, and its consumer.');
  p.push('3. **Every persistent table** read OR written by the system appears');
  p.push('   with BOTH endpoints named: the writer (parser / handler /');
  p.push('   migration) AND the reader (API endpoint / dashboard query /');
  p.push('   cron job). Missing the reader side is the most common doc bug.');
  p.push('4. **Every entry point** — cron schedule, HTTP route, webhook,');
  p.push('   CPI-from-another-program, on-launch handler — is enumerated.');
  p.push('5. **Decision logic** — if the system computes a decision (strategy');
  p.push('   weights, a router pick, a ranking, an autotuner choice, what');
  p.push('   to run next), the HOW is described (inputs → computation →');
  p.push('   output) NOT just the API surface ("X.compute() is called").');
  p.push('   Cite the actual function + the constants it uses.');
  p.push('6. **Numeric invariants** that are load-bearing (account caps, slot');
  p.push('   budgets, slippage caps, dust thresholds, cron intervals) are');
  p.push('   in the invariants list with their value + file:line.');
  p.push('');
  p.push('Be generous with `missing`. If you list 6 missing items, the doc');
  p.push('IS incomplete — that is signal, not noise. Empty `missing` only');
  p.push('when every checklist item is genuinely covered.');
  p.push('');
  p.push('overall = round(0.4*correctness + 0.25*completeness + 0.15*sizing + 0.1*diagram + 0.1*clarity)');
  p.push('');
  p.push('## HARD CAP — non-negotiable');
  p.push('If you find ANYTHING wrong, missing, incorrect, or hallucinated —');
  p.push('however small — the overall score CANNOT exceed 7. A score of 8, 9,');
  p.push('or 10 asserts the doc is FLAWLESS against the code: zero issues, zero');
  p.push('missing items, every claim verified. If your "issues" or "missing"');
  p.push('lists are non-empty, overall MUST be <= 7. Only a doc you could not');
  p.push('find a single fault in earns an 8+. Do not round up out of charity.');
  p.push('');
  p.push('## Output — STRICT JSON ONLY, no prose, no markdown fences');
  p.push('{');
  p.push('  "scores": {"correctness": <0-10>, "completeness": <0-10>, "sizing": <0-10>, "diagram": <0-10>, "clarity": <0-10>, "overall": <0-10>},');
  p.push('  "verdict": "ship" | "revise" | "split",');
  p.push('  "issues": ["specific wrong/missing things, each one short"],');
  p.push('  "suggestions": ["concrete actionable edits to raise the score"],');
  p.push('  "missing": ["things present in the code but absent from the doc"],');
  p.push('  "sizing_note": "right-sized | too-thin: <why> | too-fat: <suggested split>"');
  p.push('}');
  return p.join('\n');
}

/**
 * Tolerant JSON extraction from an LLM response. Handles bare JSON,
 * ```json fenced blocks, and leading/trailing prose. Returns a
 * normalized object with all expected keys present (defaults filled),
 * or throws if no JSON object can be found at all.
 */
export function parseValidation(text) {
  if (!text || !text.trim()) throw new Error('empty validator response');
  let raw = text.trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) raw = fence[1].trim();
  // Grab the outermost {...} if there's still surrounding prose.
  if (raw[0] !== '{') {
    const i = raw.indexOf('{');
    const j = raw.lastIndexOf('}');
    if (i === -1 || j === -1 || j < i) throw new Error('no JSON object in validator response');
    raw = raw.slice(i, j + 1);
  }
  let obj;
  try { obj = JSON.parse(raw); }
  catch (e) { throw new Error(`validator JSON parse failed: ${e.message}`); }

  const s = obj.scores || {};
  const clamp = n => Math.max(0, Math.min(10, Math.round(Number(n) || 0)));
  const scores = {
    correctness: clamp(s.correctness),
    completeness: clamp(s.completeness),
    sizing: clamp(s.sizing),
    diagram: clamp(s.diagram),
    clarity: clamp(s.clarity),
  };
  // Overall is ALWAYS computed from the dimension scores (weighted), kept
  // to one decimal — never trust the model's self-reported `overall`. The
  // decimal matters: the pass bar is 8.5, which an integer overall can't
  // represent (it'd round to 9). One-decimal precision lets "flawless but
  // not perfect" docs land at 8.5–9 and merely-good ones below.
  const round1 = x => Math.round(x * 10) / 10;
  scores.overall = round1(
    WEIGHTS.correctness * scores.correctness +
    WEIGHTS.completeness * scores.completeness +
    WEIGHTS.sizing * scores.sizing +
    WEIGHTS.diagram * scores.diagram +
    WEIGHTS.clarity * scores.clarity
  );

  const arr = v => Array.isArray(v) ? v.map(String) : [];
  const issues = arr(obj.issues);
  const missing = arr(obj.missing);

  // HARD CAP backstop. Any defect → overall <= 7, no matter what the
  // model reported. The prompt instructs this, but a model that ignores
  // it (hands out a 9 with a non-empty issues list) cannot let a flawed
  // doc through: a doc scores above 7 ONLY when it is provably clean
  // (zero issues, zero missing). This is the rule that makes
  // `refine --min-score 8.5` mean "iterate until the doc has no findable
  // faults AND scores high across dimensions."
  if (issues.length > 0 || missing.length > 0) {
    scores.overall = Math.min(scores.overall, 7);
  }

  return {
    scores,
    verdict: ['ship', 'revise', 'split'].includes(obj.verdict) ? obj.verdict : (scores.overall >= 7 ? 'ship' : 'revise'),
    issues,
    suggestions: arr(obj.suggestions),
    missing,
    sizing_note: typeof obj.sizing_note === 'string' ? obj.sizing_note : '',
  };
}

/**
 * Resolve the judge command. `SYSREG_JUDGE_CMD` wins (split on spaces for
 * a base command + flags, e.g. "codex exec" or "gemini -p"); otherwise
 * `claude -p --model <model> --output-format text`.
 */
export function judgeCommand(model = JUDGE_MODEL) {
  const override = (process.env.SYSREG_JUDGE_CMD || '').trim();
  if (override) {
    const parts = override.split(/\s+/);
    return { cmd: parts[0], args: parts.slice(1), source: 'SYSREG_JUDGE_CMD' };
  }
  return { cmd: 'claude', args: ['-p', '--model', model, '--output-format', 'text'], source: 'default' };
}

function spawnJudge(prompt, { model, timeoutMs = 12 * 60_000 } = {}) {
  const { cmd, args } = judgeCommand(model);
  return withRetry(() => new Promise((res, rej) => {
    const ch = spawn(cmd, args);
    const out = []; const err = [];
    const t = setTimeout(() => { ch.kill('SIGKILL'); rej(new Error(`${cmd} timed out`)); }, timeoutMs);
    ch.stdout.on('data', c => out.push(c));
    ch.stderr.on('data', c => err.push(c));
    ch.on('close', code => {
      clearTimeout(t);
      if (code === 0) res(Buffer.concat(out).toString('utf8'));
      else rej(new Error(`${cmd} exited ${code}: ${Buffer.concat(err).toString('utf8').slice(0, 400)}`));
    });
    ch.on('error', e => { clearTimeout(t); rej(e); });
    ch.stdin.end(prompt);
  }));
}

/**
 * Validate one system manifest. Gathers the manifest body + its anchor
 * source (reusing Pass 2's reader), builds the judge prompt, runs it via
 * the pluggable runner, parses the JSON verdict.
 *
 *   { runner }  inject for tests — (prompt) => Promise<string>
 *   { dryRun }  don't run; return { prompt, command } for inspection
 *
 * Returns { ...parsedValidation, prompt, command } on a real run.
 */
export async function validateSystem(repoRoot, manifestPath, { runner, model, dryRun = false } = {}) {
  if (!existsSync(manifestPath)) throw new Error(`manifest not found: ${manifestPath}`);
  const manifestBody = readFileSync(manifestPath, 'utf8');

  // Reuse Pass 2's glob → anchor reader so the judge sees the same source
  // the generator saw. Parse the manifest's own globs out of front-matter.
  const globs = parseGlobsFromFrontMatter(manifestBody);
  const inputs = gatherInputsFor(repoRoot, { name: 'under-review', globs });
  const { name: repoName } = repoMeta(repoRoot);

  const prompt = buildValidatePrompt({ manifestBody, anchors: inputs.anchors, repoName });
  const command = describeCommand(model);

  if (dryRun) return { prompt, command, dryRun: true };

  const text = runner ? await runner(prompt) : await spawnJudge(prompt, { model });
  const result = parseValidation(text);
  return { ...result, prompt, command };
}

/** Human-readable description of what will run (for --dry-run + logs). */
export function describeCommand(model) {
  const { cmd, args, source } = judgeCommand(model);
  return { display: `${cmd} ${args.join(' ')}`.trim(), source };
}

/** Pull `globs:` list out of a manifest's YAML front-matter. */
export function parseGlobsFromFrontMatter(text) {
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return [];
  const out = [];
  let inGlobs = false;
  for (const line of fm[1].split('\n')) {
    if (/^globs:/.test(line)) { inGlobs = true; continue; }
    if (inGlobs && /^\s*-\s/.test(line)) { out.push(line.replace(/^\s*-\s*/, '').trim().replace(/^["']|["']$/g, '')); continue; }
    if (inGlobs && /^\S/.test(line)) inGlobs = false;
  }
  return out;
}

/**
 * Stamp a `quality_score` (and `quality_verdict`) into a manifest's YAML
 * front-matter so the build/viewer can surface it and a later run knows
 * the last judged score. Idempotent — replaces an existing line or
 * inserts before the closing `---`. Returns true if written.
 */
export function writeQualityScore(manifestPath, score, verdict, inputHash) {
  if (!existsSync(manifestPath)) return false;
  let text = readFileSync(manifestPath, 'utf8');
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return false;
  let body = fm[1]
    .split('\n')
    .filter(l => !/^quality_score:/.test(l) && !/^quality_verdict:/.test(l) && !/^quality_input_hash:/.test(l))
    .join('\n');
  body += `\nquality_score: ${score}`;
  if (verdict) body += `\nquality_verdict: ${verdict}`;
  if (inputHash) body += `\nquality_input_hash: ${inputHash}`;
  const rebuilt = `---\n${body}\n---` + text.slice(fm[0].length);
  writeFileSync(manifestPath, rebuilt);
  return true;
}

/**
 * Hash the validator's INPUTS for a system (manifest body + each anchor
 * file's content). When the next run produces the same hash, the prior
 * quality_score is still valid — skip the LLM call entirely.
 */
export function computeQualityInputHash(repoRoot, manifestPath, globs) {
  const h = createHash('sha256');
  try { h.update(readFileSync(manifestPath, 'utf8')); } catch { /* skip */ }
  // Resolve globs the same way Pass 2 does, hash file contents in path order.
  const files = [];
  for (const g of globs || []) {
    if (g.endsWith('/**')) {
      const base = resolve(repoRoot, g.slice(0, -3));
      walkForHash(base, repoRoot, files);
    } else if (!g.includes('*')) {
      const p = resolve(repoRoot, g);
      if (existsSync(p)) files.push(p);
    }
  }
  for (const p of files.sort().slice(0, 24)) {
    try { h.update(p); h.update('\0'); h.update(readFileSync(p, 'utf8').slice(0, 6000)); h.update('\0'); }
    catch { /* skip unreadable */ }
  }
  return h.digest('hex').slice(0, 16);
}
function walkForHash(dir, root, out, depth = 0) {
  if (depth > 6) return;
  let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist') continue;
    const full = `${dir}/${e.name}`;
    if (e.isDirectory()) walkForHash(full, root, out, depth + 1);
    else if (e.isFile()) out.push(full);
  }
}

/** Read the cached quality block out of a manifest's front-matter. */
export function readCachedQuality(manifestPath) {
  if (!existsSync(manifestPath)) return null;
  const text = readFileSync(manifestPath, 'utf8');
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;
  const score = fm[1].match(/^quality_score:\s*([\d.]+)/m);
  const verdict = fm[1].match(/^quality_verdict:\s*(\S+)/m);
  const hash = fm[1].match(/^quality_input_hash:\s*(\S+)/m);
  if (!score) return null;
  return { score: Number(score[1]), verdict: verdict ? verdict[1] : null, input_hash: hash ? hash[1] : null };
}

/** Read quality_score back out of a manifest's front-matter (or null). */
export function readQualityScore(text) {
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;
  const m = fm[1].match(/^quality_score:\s*([\d.]+)/m);
  return m ? Number(m[1]) : null;
}

export const _internal = { WEIGHTS };
