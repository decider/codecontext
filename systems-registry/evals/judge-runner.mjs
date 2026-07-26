#!/usr/bin/env node
/**
 * Layer 3 — LLM-as-judge eval harness (scaffolding).
 *
 * This is the runner spec. It is NOT wired to a real API call yet —
 * v2's Pass 1/2/2.5 implementations need to land first, and we want
 * the API budget allocation decision before flipping on real calls.
 *
 * When ready:
 *  1. Set `ANTHROPIC_API_KEY` in env (or use `claude -p` for generator)
 *  2. Set `JUDGE_MODEL` (cheaper than generator; see ../../models.mjs)
 *  3. Run: `node judge-runner.mjs --fixture tiny-clean --pass 1`
 *  4. Output: `evals/runs/<timestamp>/<fixture>-pass<N>.json` with
 *     score, rationale, missing/extra/wrongAnchors arrays
 *
 * CI integration: a nightly GitHub Action invokes this against all
 * fixtures. Mean score < 8.0 OR any individual score < 5.0 opens an
 * issue rather than blocking PRs.
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { runPass1 } from '../pass1.mjs';
import { generateBody } from '../pass2.mjs';
import { GENERATE_MODEL, CHEAP_MODEL } from '../../models.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');

function usage() {
  process.stdout.write(`judge-runner — Layer 3 LLM-as-judge harness (scaffolding)

USAGE
  node judge-runner.mjs --fixture <name> --pass <0|1|2|2.5>
  node judge-runner.mjs --all-fixtures --pass <0|1|2|2.5>

Options:
  --judge-model <name>     default: CHEAP_MODEL, see ../../models.mjs
  --generator-model <name> default: GENERATE_MODEL, see ../../models.mjs
  --dry-run                print prompts that WOULD be sent, no API calls

Outputs to evals/runs/<ISO-timestamp>/<fixture>-pass<N>.json.

NOT WIRED TO REAL API YET. Pass 1/2/2.5 implementations need to land
first. This file exists as the scaffold + interface.
`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fixture') args.fixture = argv[++i];
    else if (a === '--pass') args.pass = argv[++i];
    else if (a === '--judge-model') args.judgeModel = argv[++i];
    else if (a === '--generator-model') args.generatorModel = argv[++i];
    else if (a === '--all-fixtures') args.allFixtures = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
  }
  return args;
}

export function loadJudgePrompt(passId) {
  const promptFile = passId === '1' ? 'pass1-hypothesis.md'
    : passId === '2' ? 'pass2-body.md'
    : passId === '2.5' ? 'pass2.5-vet.md'
    : null;
  if (!promptFile) throw new Error(`unknown pass: ${passId}`);
  return readFileSync(join(__dirname, 'judge-prompts', promptFile), 'utf8');
}

export function loadFixture(name, passId = '1') {
  const dir = join(__dirname, 'fixtures', name);
  if (!existsSync(dir)) throw new Error(`fixture not found: ${name}`);
  const expected = JSON.parse(readFileSync(join(dir, '.expected.json'), 'utf8'));
  // Pass 1 reads .expected-hypothesis.md; Pass 2 reads .expected-body-*.md.
  let ideal = null;
  if (passId === '1') {
    const p = join(dir, '.expected-hypothesis.md');
    if (existsSync(p)) ideal = readFileSync(p, 'utf8');
  } else if (passId === '2') {
    for (const f of readdirSync(dir)) {
      if (f.startsWith('.expected-body-') && f.endsWith('.md')) {
        ideal = readFileSync(join(dir, f), 'utf8');
        break;
      }
    }
  }
  return { dir, expected, idealHypothesis: ideal };
}

/**
 * Build the full judge prompt for a (pass, fixture, actualOutput) triple.
 */
export function buildJudgePromptPayload({ passId, fixture, actualOutput }) {
  const judgePrompt = loadJudgePrompt(passId);
  const { expected, idealHypothesis } = loadFixture(fixture, passId);

  return [
    judgePrompt,
    '---',
    '# Repository description',
    expected.description || '(none)',
    '',
    '# Ideal output',
    idealHypothesis || JSON.stringify(expected, null, 2),
    '',
    '# Actual output',
    actualOutput,
    '',
    'Emit your JSON response now:'
  ].join('\n');
}

/**
 * Spawn `claude -p` with a model + prompt, return stdout. Same shape as
 * docgen + pass1's runner contract.
 */
function callClaude(prompt, { model = CHEAP_MODEL, timeoutMs = 5 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--model', model, '--output-format', 'text'];
    const child = spawn('claude', args);
    const chunks = []; const errs = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`claude -p timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', c => chunks.push(c));
    child.stderr.on('data', c => errs.push(c));
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks).toString('utf8'));
      else reject(new Error(`claude -p exited ${code}: ${Buffer.concat(errs).toString('utf8').slice(0, 500)}`));
    });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.stdin.end(prompt);
  });
}

/**
 * Parse the judge's response. Expects JSON; tolerates surrounding prose.
 */
function parseJudgeResponse(text) {
  // Find the first balanced { ... } block. Handles judges that emit prose
  // before/after the JSON, OR emit content past the trailing brace.
  const start = text.indexOf('{');
  if (start === -1) {
    return { score: null, rationale: 'judge returned no JSON', _raw: text.slice(0, 500) };
  }
  // Scan forward, tracking { depth, ignoring braces inside strings.
  let depth = 0, inStr = false, esc = false;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) {
    return { score: null, rationale: 'judge JSON: unbalanced braces', _raw: text.slice(0, 500) };
  }
  const blob = text.slice(start, end + 1);
  try {
    return JSON.parse(blob);
  } catch (e) {
    return { score: null, rationale: 'judge JSON parse failed: ' + e.message, _raw: blob.slice(0, 500) };
  }
}

async function callJudge({ payload, judgeModel, dryRun }) {
  if (dryRun) {
    return { score: null, rationale: 'dry-run', _prompt_chars: payload.length };
  }
  if (process.env.ENABLE_LLM_EVALS !== '1') {
    return { score: null, rationale: 'LLM evals disabled — set ENABLE_LLM_EVALS=1 to enable' };
  }
  const response = await callClaude(payload, { model: judgeModel || CHEAP_MODEL });
  return parseJudgeResponse(response);
}

/**
 * Run the generator (Pass 1 for the moment) against the fixture and return
 * its output. This is the thing the judge then evaluates.
 */
/**
 * Pass-2 target per fixture: which specific system to generate the body for.
 * Pass 1 evaluates whole-fixture hypothesis; Pass 2 evaluates ONE system at a time.
 */
const FIXTURE_PASS2_TARGETS = {
  'tiny-clean': {
    name: 'apps-foo',
    summary: 'A tick-loop runner that snapshots, scores, persists, and spawns each tick',
    globs: ['apps/foo/**'],
    closes_loop_via: 'state.json write + spawn each tick',
  },
};

export async function generateForFixture(passId, fixtureDir, { generatorModel = GENERATE_MODEL } = {}) {
  if (passId === '1') {
    const result = await runPass1(fixtureDir, {
      runner: async (prompt) => callClaude(prompt, { model: generatorModel }),
      model: generatorModel,
    });
    return result.response;
  }
  if (passId === '2') {
    const fixtureName = fixtureDir.split('/').pop();
    const target = FIXTURE_PASS2_TARGETS[fixtureName];
    if (!target) throw new Error(`Pass 2 fixture has no target configured: ${fixtureName}`);
    const result = await generateBody(fixtureDir, target, {
      runner: async (prompt) => callClaude(prompt, { model: generatorModel }),
      model: generatorModel,
      write: false,  // eval doesn't pollute the fixture
    });
    return result.body;
  }
  throw new Error(`generation not yet wired for pass ${passId}`);
}

async function runOne({ fixture, passId, judgeModel, dryRun, actualOutput }) {
  const payload = buildJudgePromptPayload({ passId, fixture, actualOutput });
  const result = await callJudge({ payload, judgeModel, dryRun });
  return { fixture, passId, ...result };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.fixture && !args.allFixtures) { usage(); process.exit(1); }
  if (!args.pass) { usage(); process.exit(1); }

  const fixtures = args.allFixtures
    ? ['tiny-clean', 'cross-dir', 'empty']
    : [args.fixture];

  // One run dir per invocation captures FULL telemetry — generator prompt,
  // generator response, judge prompt, judge response, timings, errors.
  // Each fixture gets a subdir for easy diffing across runs.
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = join(__dirname, 'runs', ts);
  mkdirSync(runDir, { recursive: true });
  process.stderr.write(`telemetry → ${runDir}\n`);

  const summary = [];
  for (const f of fixtures) {
    const fixtureRunDir = join(runDir, f);
    mkdirSync(fixtureRunDir, { recursive: true });
    const fixtureDir = join(__dirname, 'fixtures', f);
    const telemetry = {
      fixture: f,
      passId: args.pass,
      generatorModel: args.generatorModel || GENERATE_MODEL,
      judgeModel: args.judgeModel || CHEAP_MODEL,
      startedAt: new Date().toISOString(),
      dryRun: !!args.dryRun,
      llmEvalsEnabled: process.env.ENABLE_LLM_EVALS === '1',
      steps: [],
    };

    // ── Step 1: generate ────────────────────────────────────────────
    let actualOutput = '(no generation — dry-run)';
    let genError = null;
    let genStart = Date.now();
    if (!args.dryRun && telemetry.llmEvalsEnabled) {
      process.stderr.write(`[${f}] generating pass ${args.pass}…\n`);
      try {
        actualOutput = await generateForFixture(args.pass, fixtureDir, {
          generatorModel: telemetry.generatorModel,
        });
      } catch (e) {
        genError = e.message;
        actualOutput = `(generation failed: ${e.message})`;
      }
    }
    const genElapsed = Date.now() - genStart;
    writeFileSync(join(fixtureRunDir, 'generator-output.md'), actualOutput);
    telemetry.steps.push({
      step: 'generate',
      passId: args.pass,
      model: telemetry.generatorModel,
      elapsed_ms: genElapsed,
      output_bytes: actualOutput.length,
      error: genError,
      outputFile: 'generator-output.md',
    });

    // ── Step 2: judge ───────────────────────────────────────────────
    process.stderr.write(`[${f}] judging…\n`);
    const judgePayload = buildJudgePromptPayload({ passId: args.pass, fixture: f, actualOutput });
    writeFileSync(join(fixtureRunDir, 'judge-prompt.md'), judgePayload);
    let judgeStart = Date.now();
    let judgeError = null;
    let judgeResult;
    try {
      judgeResult = await callJudge({ payload: judgePayload, judgeModel: telemetry.judgeModel, dryRun: args.dryRun });
    } catch (e) {
      judgeError = e.message;
      judgeResult = { score: null, rationale: 'judge call failed: ' + e.message };
    }
    const judgeElapsed = Date.now() - judgeStart;
    writeFileSync(join(fixtureRunDir, 'judge-response.json'), JSON.stringify(judgeResult, null, 2));
    telemetry.steps.push({
      step: 'judge',
      model: telemetry.judgeModel,
      elapsed_ms: judgeElapsed,
      score: judgeResult.score,
      error: judgeError,
      promptFile: 'judge-prompt.md',
      responseFile: 'judge-response.json',
    });

    // ── Result summary ──────────────────────────────────────────────
    telemetry.score = judgeResult.score;
    telemetry.rationale = judgeResult.rationale;
    telemetry.finishedAt = new Date().toISOString();
    telemetry.totalElapsedMs = genElapsed + judgeElapsed;
    writeFileSync(join(fixtureRunDir, 'telemetry.json'), JSON.stringify(telemetry, null, 2));

    const oneLine = {
      fixture: f,
      score: judgeResult.score,
      rationale: judgeResult.rationale,
      missing: judgeResult.missing,
      extra: judgeResult.extra,
      wrongAnchors: judgeResult.wrongAnchors,
      gen_ms: genElapsed,
      judge_ms: judgeElapsed,
    };
    summary.push(oneLine);
    process.stdout.write(JSON.stringify(oneLine, null, 2) + '\n');
  }

  writeFileSync(join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
  process.stderr.write(`summary at ${runDir}/summary.json\n`);

  // Pass/fail
  const scores = summary.map(r => r.score).filter(s => typeof s === 'number');
  if (scores.length === 0) {
    process.exit(args.dryRun ? 0 : 1);
  }
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const min = Math.min(...scores);
  process.stderr.write(`mean: ${mean.toFixed(2)}, min: ${min}\n`);
  if (mean < 8.0 || min < 5.0) {
    process.stderr.write('FAILED: mean<8.0 or min<5.0\n');
    process.exit(1);
  }
  process.stderr.write('PASSED\n');
  process.exit(0);
}

if (import.meta.url.endsWith(process.argv[1]) || process.argv[1]?.endsWith('judge-runner.mjs')) {
  main().catch(e => { process.stderr.write(String(e) + '\n'); process.exit(1); });
}
