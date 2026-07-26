/**
 * Model tiers for the systems-registry pipeline.
 *
 * These used to be hardcoded at eight separate call sites, which is why they
 * drifted: `claude-opus-4-7`, `claude-sonnet-4-6` and `claude-haiku-4-5` were
 * all live at once, and the Opus ones were two generations stale. One place to
 * change means the next model bump is a one-line edit, not a grep.
 *
 * Every tier is overridable per call, and by env var, so a run can be pinned
 * without editing source.
 */

/** Heavy passes: hypothesis (pass1) and body+diagram generation (pass2). */
export const GENERATE_MODEL = process.env.SYSREG_GENERATE_MODEL || 'claude-sonnet-5';

/** Judging and refinement — comparative, not generative. */
export const JUDGE_MODEL = process.env.SYSREG_JUDGE_MODEL || 'claude-sonnet-5';

/**
 * Mechanical passes: vet, revise, organize. These are checklist work over
 * text that already exists, so the cheapest capable tier is the right one.
 */
export const CHEAP_MODEL = process.env.SYSREG_CHEAP_MODEL || 'claude-haiku-4-5-20251001';

/** Shared per-call timeout. Generation on a large system is genuinely slow. */
export const DEFAULT_TIMEOUT_MS = 12 * 60_000;
