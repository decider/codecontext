/**
 * Model tiers for every tool in this repo — docgen and systems-registry alike.
 *
 * These used to be hardcoded at nine call sites across two tools, which is why
 * they drifted: `claude-opus-4-7`, `claude-sonnet-4-6` and `claude-haiku-4-5`
 * were all live at once, and the Opus ones were two generations stale. Anything
 * that picks a model imports from here, so the next bump is a one-line edit
 * rather than a grep across the tree.
 *
 * Every tier is overridable per call and by env var, so a run can be pinned
 * without editing source.
 */

/** Heavy generation: systems-registry pass1 hypothesis, pass2 body + diagram. */
export const GENERATE_MODEL = process.env.CODECONTEXT_GENERATE_MODEL || 'claude-sonnet-5';

/** Judging and refinement — comparison, not writing. */
export const JUDGE_MODEL = process.env.CODECONTEXT_JUDGE_MODEL || 'claude-sonnet-5';

/**
 * Mechanical passes: vet, revise, organize. Checklist work over text that
 * already exists, so the cheapest capable tier is the right one.
 */
export const CHEAP_MODEL = process.env.CODECONTEXT_CHEAP_MODEL || 'claude-haiku-4-5-20251001';

/**
 * Per-directory doc generation.
 *
 * Deliberately still 4-6 and NOT bumped with the others: pbx-platform's
 * measured cost model ($0.143/call floor + $2.048 per million prompt chars)
 * was calibrated against this exact model. Moving it invalidates that
 * calibration, so the bump is a separate decision that should come with a
 * re-measurement, not a silent edit.
 */
export const DOCGEN_MODEL = process.env.CODECONTEXT_DOCGEN_MODEL || 'claude-sonnet-4-6';

/** Shared per-call timeout for the slow generation passes. */
export const DEFAULT_TIMEOUT_MS = 12 * 60_000;
