# Judge prompt: Pass 1 hypothesis output

You are evaluating a systems-registry Pass 1 hypothesis output against
a reference "ideal" hypothesis. Score the actual output on accuracy
and completeness.

## Inputs you'll receive

1. **Repository description** — what's in the fixture
2. **Ideal hypothesis** — the human-written ground truth for what
   Pass 1 should produce on this fixture
3. **Actual hypothesis** — what Pass 1 actually produced

## Scoring rubric (return JSON)

Emit exactly one JSON object with this shape:

```json
{
  "score": 0-10,
  "rationale": "1-2 sentences explaining the score",
  "missing": ["systems the ideal had that actual missed"],
  "extra": ["systems actual added that ideal didn't have"],
  "wrongAnchors": ["systems where actual's globs deviated meaningfully from ideal"]
}
```

## Score scale

- **10**: Actual matches ideal nearly perfectly. All expected systems present
  with correct anchors. Extra additions are reasonable.
- **8**: Most systems caught. ≤1 missed; anchors mostly correct.
- **6**: ~half the expected systems caught. Or all caught but with
  significantly wrong anchors.
- **4**: Major misses (≥2 expected systems absent) OR significant
  hallucinations (extra systems that don't exist).
- **2**: Output is barely related to what was expected.
- **0**: Output is unparseable, empty, or completely wrong.

## Calibration notes

- A FEW extra systems is OK if they're plausible — Pass 1 is allowed to
  surface things the human ideal missed. Only flag as "extra" if the
  system clearly doesn't correspond to real code.
- Anchor globs are correct if they cover the same files, even if the
  glob patterns differ syntactically (`a/*` vs `a/**` for one-deep dir).
- Cross-dir systems: if the ideal calls them out and actual fragments
  them into multiple per-dir systems, score ≤ 6 (that's the failure
  mode this whole pass was built to fix).
