/**
 * Hermetic tests for the LLM-as-judge validator + refine loop. Runners
 * are injected (canned responses) so nothing spawns claude/codex/gemini.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildValidatePrompt, parseValidation, judgeCommand,
  validateSystem, parseGlobsFromFrontMatter,
  writeQualityScore, readQualityScore,
} from './validate.mjs';
import { refineSystem } from './refine.mjs';

function fixture(setup) {
  const root = mkdtempSync(join(tmpdir(), 'sr-validate-'));
  setup(root);
  return root;
}
const cleanup = r => { try { rmSync(r, { recursive: true, force: true }); } catch { /* */ } };

const manifest = `---
name: example
summary: Does the thing.
globs:
  - src/**
status: active
---

# example

## The loop

\`\`\`mermaid
flowchart LR
  a --> b
\`\`\`

## Anchors
- src/main.ts — entry
`;

describe('buildValidatePrompt', () => {
  it('includes the rubric, the doc, and the source', () => {
    const p = buildValidatePrompt({
      manifestBody: manifest,
      anchors: [{ path: 'src/main.ts', content: 'export const x = 1;' }],
      repoName: 'my-repo',
    });
    assert.match(p, /STRICT/);
    assert.match(p, /correctness/);
    assert.match(p, /completeness/);
    assert.match(p, /sizing/);
    assert.match(p, /diagram/);
    assert.match(p, /clarity/);
    // diagram dimension names the five Pass-2 rules it grades against
    assert.match(p, /Verbs, not files/);
    assert.match(p, /Every edge is labeled/);
    assert.match(p, /Decision diamonds/);
    assert.match(p, /STRICT JSON ONLY/);
    assert.match(p, /my-repo/);
    assert.match(p, /export const x = 1;/);   // the source is embedded
    assert.match(p, /flowchart LR/);          // the doc is embedded
    // don't-trust stance + hard cap must be present
    assert.match(p, /DO NOT TRUST THE DOCUMENT/);
    assert.match(p, /UNVERIFIED/);
    assert.match(p, /HARD CAP/);
    assert.match(p, /CANNOT exceed 7/);
  });
});

describe('parseValidation', () => {
  it('parses bare JSON and computes overall to one decimal', () => {
    // 0.4*9 + 0.25*8 + 0.15*10 + 0.1*9 + 0.1*9 = 8.9 (model's self-reported overall ignored)
    const r = parseValidation('{"scores":{"correctness":9,"completeness":8,"sizing":10,"diagram":9,"clarity":9,"overall":9},"verdict":"ship","issues":[],"suggestions":[],"missing":[],"sizing_note":"right-sized"}');
    assert.equal(r.scores.overall, 8.9);
    assert.equal(r.scores.diagram, 9);
    assert.equal(r.verdict, 'ship');
  });

  it('produces a half-point overall (8.5 is representable)', () => {
    // 0.4*9 + 0.25*8 + 0.15*8 + 0.1*8 + 0.1*9 = 8.5
    const r = parseValidation('{"scores":{"correctness":9,"completeness":8,"sizing":8,"diagram":8,"clarity":9},"verdict":"ship","issues":[],"suggestions":[],"missing":[]}');
    assert.equal(r.scores.overall, 8.5);
  });

  it('a poor diagram drags overall down even when other dims are high', () => {
    // 0.4*10 + 0.25*10 + 0.15*10 + 0.1*2 + 0.1*9 = 9.1 vs 10 if diagram were 10
    const r = parseValidation('{"scores":{"correctness":10,"completeness":10,"sizing":10,"diagram":2,"clarity":9},"verdict":"ship","issues":[],"suggestions":[],"missing":[]}');
    assert.equal(r.scores.overall, 9.1);
  });

  it('parses JSON inside ```json fences with preamble prose', () => {
    const txt = 'Here is my review:\n\n```json\n{"scores":{"correctness":7,"completeness":6,"sizing":8,"diagram":7,"clarity":7},"verdict":"revise","issues":["x"],"suggestions":["y"],"missing":["z"],"sizing_note":"too-thin: needs subflows"}\n```\nDone.';
    const r = parseValidation(txt);
    assert.equal(r.scores.correctness, 7);
    assert.deepEqual(r.issues, ['x']);
    assert.equal(r.sizing_note, 'too-thin: needs subflows');
  });

  it('recomputes overall from weights when the model omits it', () => {
    // 0.4*10 + 0.25*10 + 0.15*10 + 0.1*10 + 0.1*10 = 10
    const r = parseValidation('{"scores":{"correctness":10,"completeness":10,"sizing":10,"diagram":10,"clarity":10},"verdict":"ship"}');
    assert.equal(r.scores.overall, 10);
  });

  it('recomputes overall when the model lies about it (off by >1)', () => {
    // weighted = round1(0.4*2+0.25*2+0.15*2+0.1*2+0.1*2)=2, model claims 10
    const r = parseValidation('{"scores":{"correctness":2,"completeness":2,"sizing":2,"diagram":2,"clarity":2,"overall":10},"verdict":"ship"}');
    assert.equal(r.scores.overall, 2);   // not fooled
  });

  it('clamps out-of-range scores', () => {
    const r = parseValidation('{"scores":{"correctness":99,"completeness":-5,"sizing":10,"diagram":99,"clarity":10},"verdict":"x"}');
    assert.equal(r.scores.correctness, 10);
    assert.equal(r.scores.completeness, 0);
    assert.equal(r.scores.diagram, 10);
  });

  it('throws on a response with no JSON object', () => {
    assert.throws(() => parseValidation('I could not produce JSON.'), /no JSON|parse/);
  });

  it('HARD CAP: any issue forces overall <= 7 even if the model reports 9', () => {
    const r = parseValidation('{"scores":{"correctness":9,"completeness":9,"sizing":9,"diagram":9,"clarity":9,"overall":9},"verdict":"ship","issues":["one wrong edge"],"suggestions":[],"missing":[],"sizing_note":""}');
    assert.equal(r.scores.overall, 7);
  });

  it('HARD CAP: a non-empty `missing` list also caps at 7', () => {
    const r = parseValidation('{"scores":{"correctness":10,"completeness":10,"sizing":10,"diagram":10,"clarity":10,"overall":10},"verdict":"ship","issues":[],"suggestions":[],"missing":["pm25_aggregates table"],"sizing_note":""}');
    assert.equal(r.scores.overall, 7);
  });

  it('no cap when issues AND missing are both empty (flawless → can score 8+)', () => {
    const r = parseValidation('{"scores":{"correctness":10,"completeness":10,"sizing":10,"diagram":10,"clarity":10,"overall":10},"verdict":"ship","issues":[],"suggestions":["nice-to-have"],"missing":[],"sizing_note":"right-sized"}');
    assert.equal(r.scores.overall, 10);   // suggestions alone don't cap
  });
});

describe('judgeCommand', () => {
  it('defaults to claude -p on Sonnet (cheap critic — judging is discrimination)', () => {
    delete process.env.SYSREG_JUDGE_CMD;
    const c = judgeCommand();
    assert.equal(c.cmd, 'claude');
    assert.ok(c.args.includes('-p'));
    assert.equal(c.source, 'default');
    // Guard: the judge must default to Sonnet, not Opus. Matched by FAMILY,
    // not exact version — pinning `claude-sonnet-4-6` here turned a routine
    // model bump into a test failure, and it is the same drift that left
    // `claude-opus-4-7` live in the pipeline two generations late.
    const model = c.args[c.args.indexOf('--model') + 1] || '';
    assert.match(model, /sonnet/, `expected a sonnet default, got ${c.args.join(' ')}`);
    assert.doesNotMatch(model, /opus/, 'the judge must not default to Opus');
  });

  it('honors SYSREG_JUDGE_CMD for codex / gemini', () => {
    process.env.SYSREG_JUDGE_CMD = 'codex exec --foo';
    const c = judgeCommand();
    assert.equal(c.cmd, 'codex');
    assert.deepEqual(c.args, ['exec', '--foo']);
    assert.equal(c.source, 'SYSREG_JUDGE_CMD');
    delete process.env.SYSREG_JUDGE_CMD;
  });
});

describe('parseGlobsFromFrontMatter', () => {
  it('extracts the globs list', () => {
    assert.deepEqual(parseGlobsFromFrontMatter(manifest), ['src/**']);
  });
});

describe('validateSystem', () => {
  it('dry-run returns the prompt + command without invoking a runner', async () => {
    const root = fixture(r => {
      mkdirSync(join(r, 'docs/systems'), { recursive: true });
      mkdirSync(join(r, 'src'), { recursive: true });
      writeFileSync(join(r, 'src/main.ts'), 'export const x = 1;');
      writeFileSync(join(r, 'docs/systems/example.md'), manifest);
    });
    try {
      const r2 = await validateSystem(root, join(root, 'docs/systems/example.md'), { dryRun: true });
      assert.equal(r2.dryRun, true);
      assert.match(r2.prompt, /Scoring rubric/);
      assert.ok(r2.command.display.length > 0);
    } finally { cleanup(root); }
  });

  it('runs the injected runner and returns parsed scores', async () => {
    const root = fixture(r => {
      mkdirSync(join(r, 'docs/systems'), { recursive: true });
      mkdirSync(join(r, 'src'), { recursive: true });
      writeFileSync(join(r, 'src/main.ts'), 'export const x = 1;');
      writeFileSync(join(r, 'docs/systems/example.md'), manifest);
    });
    try {
      const runner = async () => '{"scores":{"correctness":9,"completeness":9,"sizing":9,"diagram":9,"clarity":9,"overall":9},"verdict":"ship","issues":[],"suggestions":[],"missing":[],"sizing_note":"right-sized"}';
      const r2 = await validateSystem(root, join(root, 'docs/systems/example.md'), { runner });
      assert.equal(r2.scores.overall, 9);
      assert.equal(r2.verdict, 'ship');
    } finally { cleanup(root); }
  });
});

describe('refineSystem (generate ⇄ validate loop)', () => {
  function baseRepo(setup) {
    return fixture(r => {
      mkdirSync(join(r, 'docs/systems'), { recursive: true });
      mkdirSync(join(r, 'src'), { recursive: true });
      writeFileSync(join(r, 'src/main.ts'), 'export const x = 1;');
      setup?.(r);
    });
  }
  const entry = { name: 'example', globs: ['src/**'], summary: 's' };
  // gen runner just writes a minimal valid manifest body each round.
  const genRunner = async () => manifest;

  it('stops as soon as the judge clears min-score', async () => {
    const root = baseRepo();
    try {
      const judgeRunner = async () => '{"scores":{"correctness":9,"completeness":9,"sizing":9,"diagram":9,"clarity":9,"overall":9},"verdict":"ship","issues":[],"suggestions":[],"missing":[],"sizing_note":"ok"}';
      const res = await refineSystem(root, entry, { minScore: 9, maxRounds: 3, genRunner, judgeRunner });
      assert.equal(res.status, 'passed');
      assert.equal(res.rounds.length, 1);
      assert.equal(res.finalScore, 9);
    } finally { cleanup(root); }
  });

  it('default min-score 7: a good doc with a minor nit (capped to 7) passes round 1', async () => {
    const root = baseRepo();
    try {
      // High dimensions but one minor issue → hard cap pins overall to 7.
      // Under the gate-7 default this PASSES immediately (the reconciliation
      // of "any defect caps at 7" with an achievable pass bar). At the old
      // 8.5 default this would have looped uselessly to max rounds.
      const judgeRunner = async () => '{"scores":{"correctness":9,"completeness":9,"sizing":9,"diagram":9,"clarity":9},"verdict":"revise","issues":["one minor nit"],"suggestions":[],"missing":[]}';
      const res = await refineSystem(root, entry, { maxRounds: 3, genRunner, judgeRunner }); // no minScore → default 7
      assert.equal(res.status, 'passed');
      assert.equal(res.rounds.length, 1);
      assert.equal(res.finalScore, 7);   // capped, and 7 >= default 7 → passes
    } finally { cleanup(root); }
  });

  it('loops up to maxRounds when the score never clears', async () => {
    const root = baseRepo();
    try {
      const judgeRunner = async () => '{"scores":{"correctness":5,"completeness":5,"sizing":5,"diagram":5,"clarity":5,"overall":5},"verdict":"revise","issues":["x"],"suggestions":["y"],"missing":[],"sizing_note":""}';
      const res = await refineSystem(root, entry, { minScore: 9, maxRounds: 3, genRunner, judgeRunner });
      assert.equal(res.status, 'max-rounds');
      assert.equal(res.rounds.length, 3);
    } finally { cleanup(root); }
  });

  it('stops immediately on verdict=split (human decision, not loopable)', async () => {
    const root = baseRepo();
    try {
      const judgeRunner = async () => '{"scores":{"correctness":8,"completeness":5,"sizing":2,"diagram":4,"clarity":7,"overall":6},"verdict":"split","issues":["too big"],"suggestions":[],"missing":[],"sizing_note":"too-fat: split into a,b,c"}';
      const res = await refineSystem(root, entry, { minScore: 9, maxRounds: 3, genRunner, judgeRunner });
      assert.equal(res.status, 'needs-split');
      assert.equal(res.rounds.length, 1);
    } finally { cleanup(root); }
  });

  it('keep-best: a worse-scoring later round does NOT overwrite a better earlier round', async () => {
    // The ci-test-gate regression in miniature. Round 1 scores 6, round 2
    // regenerates to a structurally-equivalent body that the judge scores
    // 4. Neither clears minScore=9, so both rounds run. The OLD keep-LAST
    // logic returned 4 and left round-2's body on disk; keep-best must
    // return 6 and restore round-1's body.
    const root = baseRepo();
    try {
      const bodyR1 = manifest.replace('# example', '# example\n<!-- ROUND-1 -->');
      const bodyR2 = manifest.replace('# example', '# example\n<!-- ROUND-2 -->');
      let gen = 0;
      const gens = [bodyR1, bodyR2];
      const genRunner2 = async () => gens[gen++];
      let jc = 0;
      const scores = [6, 4];
      const judgeRunner = async () => `{"scores":{"correctness":${scores[jc]},"completeness":${scores[jc]},"sizing":${scores[jc]},"diagram":${scores[jc]},"clarity":${scores[jc]},"overall":${scores[jc++]}},"verdict":"revise","issues":["x"],"suggestions":["y"],"missing":[],"sizing_note":""}`;
      const res = await refineSystem(root, entry, { minScore: 9, maxRounds: 2, genRunner: genRunner2, judgeRunner });
      assert.equal(res.finalScore, 6, 'should keep the better round-1 score, not round-2 (4)');
      const onDisk = readFileSync(join(root, 'docs/systems/example.md'), 'utf8');
      assert.match(onDisk, /ROUND-1/, 'round-1 body must be restored on disk');
      assert.doesNotMatch(onDisk, /ROUND-2/, 'round-2 (worse) body must NOT be on disk');
    } finally { cleanup(root); }
  });

  it('post-regen guard: a regen that introduces NEW structural breaks is rejected, prior best kept', async () => {
    // Round 1 = a complete manifest (all required sections). Round 2 = a
    // broken stub (empty loop, missing sections) — MORE structural breaks.
    // The guard must reject round 2 WITHOUT judging it and restore round 1.
    const root = baseRepo();
    try {
      const complete = `---
name: example
kind: pipeline
summary: complete.
globs:
  - src/**
status: active
---

# example

## What it does
Does the thing via src/main.ts.

## The loop
\`\`\`mermaid
flowchart TB
  a[start] --> b{ok?}
  b -->|yes| c[done]
\`\`\`

## Anchors
- src/main.ts — entry

## Closing arrow
writes state.

## Invariants
- holds

## Failure modes
- crashes

## Where to start reading
1. src/main.ts
`;
      const stub = `---
name: example
summary: stub.
globs:
  - src/**
status: active
---

# example

## What it does
thin.

## The loop
`;
      let gen = 0;
      const gens = [complete, stub];
      const genRunner2 = async () => gens[gen++];
      let judgeCalls = 0;
      // Round 1 judged at 6 (below min so it would loop); round 2 should be
      // REJECTED before judging, so the judge is called exactly once.
      const judgeRunner = async () => { judgeCalls++; return '{"scores":{"correctness":6,"completeness":6,"sizing":6,"diagram":6,"clarity":6,"overall":6},"verdict":"revise","issues":["x"],"suggestions":[],"missing":[]}'; };
      const res = await refineSystem(root, entry, { minScore: 9, maxRounds: 2, genRunner: genRunner2, judgeRunner });
      assert.equal(judgeCalls, 1, 'the broken round-2 regen must NOT be judged');
      assert.equal(res.finalScore, 6, 'final score is the kept round-1 score');
      assert.ok(res.rounds.some(r => r.verdict === 'rejected-structural-break'), 'round 2 recorded as rejected');
      const onDisk = readFileSync(join(root, 'docs/systems/example.md'), 'utf8');
      assert.match(onDisk, /## Invariants/, 'complete round-1 body restored');
    } finally { cleanup(root); }
  });

  it('improves across rounds and passes only when the doc is clean', async () => {
    const root = baseRepo();
    try {
      // First two rounds have issues (→ capped at 7 each by parseValidation,
      // regardless of the raw scores); the final round is flawless (empty
      // issues+missing) so it legitimately reaches 9. This exercises the
      // HARD CAP inside the loop: you only pass by eliminating every fault.
      let call = 0;
      const judgeRunner = async () => {
        call++;
        if (call < 3) {
          return '{"scores":{"correctness":9,"completeness":9,"sizing":9,"diagram":9,"clarity":9,"overall":9},"verdict":"revise","issues":["still one wrong edge"],"suggestions":["fix it"],"missing":[],"sizing_note":""}';
        }
        return '{"scores":{"correctness":9,"completeness":9,"sizing":9,"diagram":9,"clarity":9,"overall":9},"verdict":"ship","issues":[],"suggestions":[],"missing":[],"sizing_note":"right-sized"}';
      };
      const res = await refineSystem(root, entry, { minScore: 9, maxRounds: 5, genRunner, judgeRunner });
      assert.equal(res.status, 'passed');
      // rounds 1-2 capped to 7 despite raw 9s; round 3 clean → 9
      assert.deepEqual(res.rounds.map(r => r.score), [7, 7, 9]);
    } finally { cleanup(root); }
  });
});

describe('writeQualityScore / readQualityScore', () => {
  const fm = `---
name: ex
summary: s
globs:
  - src/**
status: active
---

# ex
body`;
  it('stamps quality_score + quality_verdict into front-matter, idempotently', () => {
    const root = mkdtempSync(join(tmpdir(), 'sr-qs-'));
    try {
      const p = join(root, 'ex.md');
      writeFileSync(p, fm);
      assert.equal(writeQualityScore(p, 8.5, 'ship'), true);
      let t = readFileSync(p, 'utf8');
      assert.match(t, /quality_score: 8\.5/);
      assert.match(t, /quality_verdict: ship/);
      assert.equal(readQualityScore(t), 8.5);
      // re-stamp replaces, doesn't duplicate
      writeQualityScore(p, 9, 'ship');
      t = readFileSync(p, 'utf8');
      assert.equal((t.match(/quality_score:/g) || []).length, 1);
      assert.equal(readQualityScore(t), 9);
      // body preserved
      assert.match(t, /# ex\nbody/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('refineSystem generateFirst=false (sweep mode)', () => {
  it('validates the existing manifest first; passes without regenerating', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sr-gf-'));
    try {
      mkdirSync(join(root, 'docs/systems'), { recursive: true });
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src/main.ts'), '// main');
      writeFileSync(join(root, 'docs/systems/ex.md'), `---
name: ex
summary: s
globs:
  - src/**
status: active
---
# ex
## The loop
\`\`\`mermaid
flowchart LR
  a --> b
\`\`\`
`);
      let genCalls = 0;
      const genRunner = async () => { genCalls++; return 'regenerated'; };
      const judgeRunner = async () => '{"scores":{"correctness":9,"completeness":9,"sizing":9,"diagram":9,"clarity":9},"verdict":"ship","issues":[],"suggestions":[],"missing":[]}';
      const res = await refineSystem(root, { name: 'ex', globs: ['src/**'], summary: 's' }, {
        generateFirst: false, genRunner, judgeRunner, maxRounds: 3,
      });
      assert.equal(res.status, 'passed');
      assert.equal(genCalls, 0);   // existing doc was clean → never regenerated
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
