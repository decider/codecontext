# Layer 4 — injection-effectiveness eval (design)

Status: **proposed, not implemented.** This is the design for the eval
that measures the thing the systems-registry actually exists to do.

## The problem with the current fitness function

Today the only quality signal a manifest gets is `validate.mjs` — an
LLM-as-judge that scores the manifest 0-10 on correctness / completeness
/ sizing / clarity / diagram, against the anchor code. That is an LLM
**grading its own homework**. It tells us whether the manifest is a
*good document*. It does **not** tell us whether the manifest does its
job.

A manifest's job is the **closing arrow**: a PreToolUse hook re-injects
it into Claude's context so the next turn is better-oriented about the
system being touched. So the question that actually matters is:

> When this manifest is injected, does Claude's next action on this
> system get measurably better than with no manifest at all?

A manifest can self-score 9/10 and provide **zero** lift (Claude already
nailed the task from the raw code). Another can self-score 6/10 and
reliably orient Claude away from a trap. The self-judge ranks the first
higher; the closing arrow says the second is more valuable. The current
pipeline has no way to see that gap.

## What Layer 4 measures

`fitness(manifest) = score(answer WITH manifest injected)
                   − score(answer WITHOUT manifest injected)`

i.e. the **lift** the manifest provides on a real task that touches its
system. Positive lift = the manifest earns its place. ~Zero lift = the
system is already self-evident from code and may not need a page (this
is signal the splitting/merging guards can't produce). Negative lift =
the manifest is actively misleading — the worst case, and one the
self-judge cannot detect.

## Harness

```
evals/
├── fixtures/<name>/
│   ├── .probes.json              # NEW: task probes + ground truth per system
│   └── ...                        # (existing fixture repo files)
├── layer4-runner.mjs              # NEW: A/B runner + grader
└── layer4-injection-eval-design.md   # you are here
```

### 1. Probe generation (held-out, non-circular)

For each system, an LLM reads the **anchor code only — never the
manifest** — and emits 5-10 task probes a developer would realistically
hit, each with a ground-truth answer verified against the code:

```json
{
  "system": "systems-registry-pipeline",
  "probes": [
    {
      "q": "Where does the pipeline's loop close back into Claude?",
      "truth": "inject.mjs PreToolUse hook re-injects the matching manifest's Mermaid + page link into the next turn",
      "anchors": ["systems-registry/inject.mjs"]
    },
    {
      "q": "What triggers Pass 2.6 (revise)?",
      "truth": "a fixable vet issue from Pass 2.5 (hasFixableIssue in run-pipeline.mjs); capped at 2 retries",
      "anchors": ["systems-registry/run-pipeline.mjs", "systems-registry/pass26-revise.mjs"]
    }
  ]
}
```

Holding the manifest out of probe generation is **load-bearing** — if
the probes were written from the manifest, a manifest that restates its
own probes would score perfectly while teaching Claude nothing new.

### 2. A/B conditions

For each probe, run two Claude turns:

- **Condition A (control):** the probe question + the raw repo (the
  agent can Read/Grep but gets no manifest injected).
- **Condition B (treatment):** the same, plus the system's manifest
  injected exactly as the PreToolUse hook would inject it.

To isolate the manifest's value, **cap the turn** (e.g. a small tool
budget or a "answer from what's in front of you" instruction). If the
agent is allowed to read the whole repo with no budget, A and B
converge and the manifest's lift vanishes into the noise — which is
itself a finding (manifests help *fast orientation*, not *exhaustive
investigation*), but the eval should measure the orientation case.

### 3. Grading

Grade each answer against `truth` with a structured-extraction judge
(emit `{correct: bool, partial: bool, rationale}`), not a freeform
0-10 — booleans are far less noisy across runs. Aggregate:

```
lift = accuracy(B) − accuracy(A)        # per system
suite_lift = mean(lift over all systems)
```

A system passes if `lift(system) >= 0` and the suite mean clears a bar
(say `>= +0.15`). Negative-lift systems get surfaced loudly — a
misleading manifest is worse than none.

## Cost & where it plugs in

Full A/B is expensive: `2 turns × probes × systems`. So:

- **Nightly, not per-PR** — mirror the existing Layer 3 LLM-judge
  cadence (separate GitHub Action; opens an issue on regression rather
  than blocking PRs).
- **Cheap per-PR proxy — fact-coverage.** Deterministically check
  whether the manifest *contains the facts the probes need* (string /
  symbol presence against `truth`). No extra Claude turns. The refine
  loop (`refine.mjs`) can target the proxy; the nightly Layer 4 run
  validates that the proxy still correlates with real lift. If the
  proxy and the real eval diverge, the proxy needs tightening.

## Open questions / risks

- **Probe quality.** Garbage probes → garbage signal. Mitigate with a
  fixed, versioned probe set per system (checked in, reviewed like
  code) rather than regenerating probes every run.
- **Grader noise.** Boolean correctness + a fixed grader prompt reduces
  variance vs a 0-10 freeform score, but doesn't eliminate it. Run each
  probe k times and majority-vote if needed.
- **Turn-budget calibration.** Too generous → no lift measurable; too
  stingy → measures prompt-stuffing, not orientation. Needs tuning
  against a couple of hand-checked systems first.
- **Determinism.** Claude turns are non-deterministic; pin
  temperature-equivalents where possible and treat the metric as a
  distribution, not a point.

## Relationship to the other fitness work

- `validate.mjs` (self-judge) stays as the cheap per-PR gate — it's
  fine for catching hallucinations and structural defects.
- Layer 4 becomes the **ground-truth fitness function** that the
  self-judge rubric is periodically *calibrated against*: if a rubric
  change makes self-scores go up but Layer 4 lift go down, the rubric
  change was wrong. That closes the loop on "are we optimizing the
  right thing?"
