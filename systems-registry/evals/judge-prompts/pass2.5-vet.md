# Judge prompt: Pass 2.5 vet output

You are evaluating whether Pass 2.5 (the vetting pass) correctly
identifies problems in a known-broken system manifest.

## Inputs

1. **Original system body** (intentionally seeded with N known issues)
2. **Seeded issues list** — what was deliberately broken
3. **Vet output** — what Pass 2.5 actually flagged

## Scoring rubric

```json
{
  "score": 0-10,
  "rationale": "1-2 sentences",
  "truePositives": ["seeded issues vet correctly caught"],
  "falsePositives": ["things vet flagged that weren't actually issues"],
  "falseNegatives": ["seeded issues vet MISSED"]
}
```

## Score scale

- **10**: vet caught all seeded issues + zero false positives.
- **8**: vet caught ≥90% of seeded issues; ≤1 false positive.
- **6**: vet caught ~70% of seeded issues; some false positives but tolerable.
- **4**: vet missed a major seeded issue OR had multiple false positives.
- **2**: vet's output is barely related to the actual issues.
- **0**: vet emitted no issues for a clearly-broken manifest, OR
  flagged every line for a clearly-correct manifest.

## What "issues" means

For this eval, seeded issues are one of:
- Hallucinated file path (e.g., `nonexistent/file.ts` in anchors)
- Invariant contradicted by code (body says X, code says Y)
- Missing closing-arrow target
- Cross-system overlap (same code claimed by 2 systems)

A perfect vet catches every seeded issue with zero false flags.
