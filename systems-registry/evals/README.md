# systems-registry evals

Three-layer eval architecture for the systems-registry tool.

## Layer 1 — unit tests (existing)

`tools/systems-registry/*.test.mjs`. Function-level tests via `node --test`.
Fast, deterministic, free. Runs on every PR via CI.

```
node --test tools/systems-registry/*.test.mjs
```

## Layer 2 — fixture-based integration tests (this dir)

Tiny reference repos with known-correct outputs checked in as JSON.
Tests run the real Pass 0 detector against the fixture and assert
the candidate list matches the expected one.

Structure:

```
evals/
├── fixtures/
│   ├── tiny-clean/              # 2 clear dir-rooted systems
│   │   ├── apps/foo/run.mjs
│   │   ├── apps/foo/capture.mjs
│   │   ├── apps/foo/score.mjs
│   │   ├── tools/bar/cli.mjs
│   │   ├── tools/bar/lib.mjs
│   │   ├── tools/bar/run.mjs
│   │   └── .expected.json       # ground truth for Pass 0
│   ├── cross-dir/               # 1 system that spans 3 dirs
│   │   ├── apps/api/processor.ts
│   │   ├── packages/shared/event.ts
│   │   ├── scripts/relay.sh
│   │   └── .expected.json
│   └── empty/                   # no candidates
│       └── .expected.json
├── pass0.test.mjs               # runs Pass 0 against each fixture
└── README.md                    # you are here
```

Each `.expected.json` documents the **ground truth** for what the
detector should find. Format:

```json
{
  "minScore": 4,
  "expectedSystems": [
    { "name": "apps-foo", "minSignals": ["coordinator", "subprocess"] },
    { "name": "tools-bar", "minSignals": ["coordinator", "tests"] }
  ],
  "notes": "Tiny clean fixture — should detect both dir-rooted systems easily"
}
```

Run all Layer 2:

```
node --test tools/systems-registry/evals/*.test.mjs
```

## Layer 3 — LLM-as-judge evals (scaffolding here, run on cron)

Real LLM calls. Scored by a separate (cheaper) judge LLM. Slow,
expensive — NOT for every PR; scheduled nightly.

```
evals/
├── judge-prompts/               # the prompts the judge LLM uses to score
│   ├── pass1-hypothesis.md
│   ├── pass2-body.md
│   └── pass2.5-vet.md
├── judge-runner.mjs             # harness: runs Pass N + judges output
└── (fixtures shared with Layer 2)
```

To run a Layer 3 eval manually (requires `ANTHROPIC_API_KEY`):

```
node tools/systems-registry/evals/judge-runner.mjs --fixture tiny-clean --pass 1
```

Scoring: judge LLM emits `{score: 0-10, rationale}` per fixture. Suite
passes if mean score ≥ 8.0 and no individual score < 5.0.

In CI: this layer runs as a nightly GitHub Action (separate workflow
from the per-PR CI). When LLM evals fail, the workflow opens an issue
rather than blocking PRs.

## Layer 4 — injection-effectiveness eval (proposed)

Measures the thing the registry actually exists to do: when a manifest
is re-injected into Claude's context (the closing arrow), does Claude's
next action on that system get **measurably better** than with no
manifest? Fitness = lift of (answer with manifest) over (answer
without). Catches failures Layers 1-3 can't — a manifest that's accurate
but provides zero lift, or one that's actively misleading (negative
lift).

Expensive (2 Claude turns × probes × systems) → nightly, like Layer 3,
with a deterministic per-PR `fact-coverage` proxy. Becomes the
ground-truth fitness function the self-judge rubric is calibrated
against.

Full design: [`layer4-injection-eval-design.md`](./layer4-injection-eval-design.md).
**Status: proposed, not implemented.**

## Adding a new fixture

1. Create `evals/fixtures/<name>/` with the smallest possible repo layout
   that exercises the case you want to test.
2. Write `.expected.json` with the ground truth.
3. Re-run Layer 2: `node --test tools/systems-registry/evals/*.test.mjs`.
4. (Optional) Add an "ideal" Pass 1 hypothesis as
   `evals/fixtures/<name>/.expected-hypothesis.md` for Layer 3.
