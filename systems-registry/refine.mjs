#!/usr/bin/env node
/**
 * systems-registry — refine loop (Pass 2 ⇄ Pass 2.7).
 *
 * Drives a single system's manifest to a target quality score by
 * alternating generate → validate → regenerate-with-feedback, until the
 * validator's `overall` score clears `minScore` (default 9), the round
 * budget is exhausted, or the verdict is `split` (a structural decision
 * a human must make — looping can't fix "this should be N systems").
 *
 *   refineSystem(repoRoot, hypothesisEntry, {
 *     minScore = 9, maxRounds = 2,
 *     genRunner,   // injected LLM for generateBody  (tests)
 *     judgeRunner, // injected LLM for validateSystem (tests)
 *   })
 *
 * Returns { name, finalScore, rounds: [...], status, manifestPath }.
 * `rounds` records each {round, score, verdict, scores} for telemetry.
 *
 * The generator and the judge are SEPARATE runners on purpose: in prod
 * the judge can be a different model (SYSREG_JUDGE_CMD) for stronger,
 * less self-blind evaluation while the generator stays on claude -p.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { generateBody } from './pass2.mjs';
import { validateSystem } from './validate.mjs';
import { cheapVet } from './pass25-vet.mjs';
import { GENERATE_MODEL, JUDGE_MODEL } from '../models.mjs';

// Structural problem kinds that make a regeneration WORSE than its
// predecessor. A regen that introduces any of these (relative to the
// prior round) is structurally broken — keep-best discards it. These
// are the breaks that produced the ci-test-gate regression: a refine
// round emptied the Mermaid + dropped Anchors/Invariants/Failure modes,
// and the old keep-LAST logic shipped that stub.
const STRUCTURAL_BREAK_KINDS = new Set([
  'missing-section', 'mermaid-issue', 'no-front-matter',
  'front-matter-missing-name', 'front-matter-missing-globs',
]);

function structuralBreaks(repoRoot, manifestPath) {
  try {
    const { problems } = cheapVet(repoRoot, manifestPath);
    return (problems || []).filter(p => STRUCTURAL_BREAK_KINDS.has(p.kind)).length;
  } catch { return 0; }
}

export async function refineSystem(repoRoot, hypothesisEntry, {
  minScore = 7,
  maxRounds = 2,
  genRunner,
  judgeRunner,
  // Refine runs on Sonnet by default: the INITIAL draft (Pass 2) is Opus
  // for quality, but the refine REWRITES are iterative + cheap, and the
  // keep-best guard discards any Sonnet rewrite that scores below the Opus
  // draft — so we never ship a worse doc. The judge is a discrimination
  // task Sonnet does well. Pass `--model`/env to override.
  genModel = GENERATE_MODEL,
  judgeModel = JUDGE_MODEL,
  // generateFirst=true: standalone use — produce a fresh body on round 1
  // then judge it. generateFirst=false: the sweep already generated +
  // vetted + revised a manifest, so VALIDATE that existing doc first and
  // only regenerate on later rounds if it falls short. Saves one whole
  // generation per already-good system.
  generateFirst = true,
  log = () => {},
} = {}) {
  const name = hypothesisEntry.name;
  const manifestPath = resolve(repoRoot, 'docs/systems', `${name}.md`);
  const rounds = [];
  let feedback = null;
  let status = 'max-rounds';   // pessimistic default; overwritten on success/split

  // Keep-BEST, not keep-LAST. A regeneration can score WORSE than a prior
  // round (it dropped sections, emptied the diagram, etc). The old logic
  // shipped whatever was on disk after the final round — so a regression
  // overwrote a better earlier draft. We now snapshot the best-scoring
  // body and restore it at the end if the last round didn't win.
  let best = null;   // { body, score, verdict, scores, round }

  for (let round = 1; round <= maxRounds; round++) {
    // Generate on every round EXCEPT a round-1 when generateFirst=false
    // (then we validate the pre-existing manifest). Rounds >1 always
    // regenerate, carrying the prior round's feedback.
    if (round > 1 || generateFirst) {
      log(`[${name}] round ${round}: generating${feedback ? ' (with feedback)' : ''}…`);
      await generateBody(repoRoot, hypothesisEntry, { runner: genRunner, model: genModel, feedback });
    }

    // Post-regen structural guard: if this regen introduced MORE structural
    // breaks than the best-so-far had (missing sections, empty/broken
    // mermaid, broken front-matter), it's a regression. Don't bother
    // judging it — record a sentinel round and keep the prior best.
    const breaks = structuralBreaks(repoRoot, manifestPath);
    if (best && breaks > (best.breaks ?? 0)) {
      log(`[${name}] round ${round}: REJECTED — ${breaks} structural break(s) vs best's ${best.breaks ?? 0}; keeping round ${best.round}`);
      rounds.push({ round, score: null, verdict: 'rejected-structural-break', rejected: true, breaks });
      // restore the best body so the next regen builds on the good one,
      // and so disk is never left holding the broken stub.
      writeFileSync(manifestPath, best.body);
      feedback = best.scores ? { scores: best.scores, verdict: best.verdict } : feedback;
      continue;
    }

    log(`[${name}] round ${round}: validating…`);
    const v = await validateSystem(repoRoot, manifestPath, { runner: judgeRunner, model: judgeModel });
    rounds.push({ round, score: v.scores.overall, verdict: v.verdict, scores: v.scores });
    log(`[${name}] round ${round}: ${v.scores.overall}/10 (${v.verdict})`);

    // Track the best-scoring round. Snapshot the body from disk NOW (before
    // the next round overwrites it).
    if (!best || v.scores.overall > best.score) {
      best = {
        body: readFileSync(manifestPath, 'utf8'),
        score: v.scores.overall, verdict: v.verdict, scores: v.scores,
        round, breaks,
      };
    }

    if (v.scores.overall >= minScore) { status = 'passed'; break; }
    if (v.verdict === 'split') { status = 'needs-split'; break; }

    feedback = v;   // feed this round's critique into the next regen
  }

  // If the last round on disk isn't the best, restore the best body so we
  // never ship a regression. This is the core keep-best guarantee.
  if (best && best.body !== undefined) {
    const onDisk = (() => { try { return readFileSync(manifestPath, 'utf8'); } catch { return null; } })();
    if (onDisk !== best.body) {
      writeFileSync(manifestPath, best.body);
      log(`[${name}] restored best round ${best.round} (${best.score}/10) over a worse final round`);
    }
  }

  const finalScore = best ? best.score : 0;
  const finalVerdict = best ? best.verdict : 'revise';
  const finalScores = best ? best.scores : null;   // per-dimension breakdown of the kept round
  return { name, finalScore, finalVerdict, finalScores, rounds, status, manifestPath };
}
