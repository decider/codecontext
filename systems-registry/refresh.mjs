#!/usr/bin/env node
// systems-registry — incremental refresh.
//
// The cheap, scoped counterpart to `run` (full rewrite). Given the set of
// files changed in a push, regenerate ONLY the systems whose anchors were
// touched — plus any newly-detected candidate worth a fresh diagram. Skips
// everything else. Most pushes touch 0-1 systems, so most refreshes are
// ~$0 to ~$0.35 instead of the full ~$3 rewrite.
//
// Gating logic (computeImpact):
//   - impacted: existing manifests whose globs match a changed file
//   - newCandidates: Pass-0 detector hits NOT covered by any existing manifest
//   - if both empty → skip entirely
//
// When new candidates appear we re-run Pass 1 (one call) so the whole set
// gets consistent semantic names; otherwise we reuse each impacted manifest's
// own front-matter as its Pass-2 input (no Pass 1 needed → cheaper).
//
// Always finishes with organize (re-anchored) + build so the rendered HTML
// + categories stay in sync.

import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { detect } from './detect.mjs';
import { parseFrontMatter, globToRegex } from './registry.mjs';
import { runPass1 } from './pass1.mjs';
import { generateBody } from './pass2.mjs';
import { vetSystem, checkSubflowRegression } from './pass25-vet.mjs';
import { reviseSystem } from './pass26-revise.mjs';
import { runOrganize } from './organize.mjs';
import { buildSite } from './build-static.mjs';

const FIXABLE_KINDS = new Set([
  'hallucinated-symbol', 'invariant-contradiction', 'wrong-closing-arrow',
  'missing-section', 'mermaid-issue', 'mentioned-path-not-on-disk',
  'no-front-matter', 'front-matter-missing-name', 'front-matter-missing-globs',
]);
const hasFixable = problems => problems.some(p => FIXABLE_KINDS.has(p.kind));

/** Load existing manifests' {name, globs} from front-matter. */
export function loadManifestGlobs(repoRoot) {
  const dir = join(repoRoot, 'docs/systems');
  const out = [];
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md') || f === 'README.md' || f.startsWith('_')) continue;
    try {
      const { frontMatter } = parseFrontMatter(readFileSync(join(dir, f), 'utf8'));
      if (frontMatter && frontMatter.name) {
        out.push({ name: frontMatter.name, summary: frontMatter.summary, globs: frontMatter.globs || [], file: f });
      }
    } catch { /* skip */ }
  }
  return out;
}

/**
 * Decide what to regenerate given the changed files.
 * Returns { impacted: [manifest], newCandidates: [detection], skip: bool }.
 */
export function computeImpact(repoRoot, changedFiles) {
  const manifests = loadManifestGlobs(repoRoot);
  const changed = changedFiles.filter(Boolean);

  // Impacted existing systems: any glob matches any changed file.
  const impacted = manifests.filter(m =>
    (m.globs || []).some(g => {
      const re = globToRegex(g);
      return changed.some(f => re.test(f));
    })
  );

  // New candidates: detector hits whose dir isn't covered by any existing
  // manifest glob (a genuinely new system worth its own diagram).
  const candidates = detect(repoRoot);
  const coveredBy = (dir) => manifests.some(m =>
    (m.globs || []).some(g => globToRegex(g).test(dir) || globToRegex(g).test(dir + '/x')));
  const newCandidates = candidates.filter(c => {
    // Only "new" if the candidate's dir was touched AND not already covered.
    const touched = changed.some(f => f.startsWith(c.dir + '/') || f === c.dir);
    return touched && !coveredBy(c.dir);
  });

  const skip = impacted.length === 0 && newCandidates.length === 0;
  return { impacted, newCandidates, skip, manifestCount: manifests.length };
}

/**
 * Must-keep feedback for a retry after a subflow regression, in pass-2's
 * structured `feedback` shape ({ verdict, issues, missing, suggestions }) — the
 * same channel the refine loop uses, threaded into the regen prompt as the
 * highest-priority instruction. The prior, already-shipped manifest carried
 * these mermaid subflows and the fresh regen dropped them; tell the model to
 * retain every one (additive — never drop).
 */
function keepSubflowFeedback(dropped) {
  return {
    verdict: 'subflow-regression',
    issues: [
      'Your previous draft DROPPED mermaid subflow diagrams that the prior, ' +
        'already-shipped version of this doc had. Dropping a prior subflow is a ' +
        'regression and will be rejected.',
    ],
    missing: dropped.map(
      (n) =>
        `Subflow "${n}" — restore it as its own "## Subflow: ${n}" heading with its ` +
        'own ```mermaid diagram (it was in the prior version and must be kept).',
    ),
    suggestions: [
      'Keep EVERY prior subflow and only ADD new ones for newer code; never drop ' +
        'one the prior version had.',
    ],
  };
}

/**
 * One generate → static-vet → revise-if-fixable cycle. Returns the body left on
 * disk, the vet verdict, the revise-attempt count, and the manifest path. An
 * optional `feedback` string is threaded into the regen prompt (used by the
 * preserve-and-retry path below).
 */
async function genVetReviseOnce(repoRoot, entry, { runner, feedback = null }) {
  const p2 = await generateBody(repoRoot, entry, { runner, feedback });
  let vet = await vetSystem(repoRoot, p2.outPath, { llm: false, runner });
  let attempts = 0;
  if (vet.status === 'issues' && hasFixable(vet.problems)) {
    const revised = await reviseSystem(repoRoot, entry, vet, { runner });
    attempts = revised.attempts.length;
    vet = { status: revised.finalStatus, problems: revised.finalProblems };
  }
  const body = existsSync(p2.outPath) ? readFileSync(p2.outPath, 'utf8') : '';
  return { body, vet, attempts, outPath: p2.outPath };
}

async function genVetRevise(repoRoot, entry, { runner }) {
  // Capture the prior, previously-shipped manifest BEFORE generateBody
  // overwrites it — the anti-regression guard compares against it, and even
  // the revise pass only ever sees the (possibly thinner) regen on disk.
  const manifestPath = resolve(repoRoot, 'docs/systems', `${entry.name}.md`);
  const originalBody = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : '';

  let r = await genVetReviseOnce(repoRoot, entry, { runner });
  let attempts = r.attempts;
  let regression = checkSubflowRegression(originalBody, r.body);

  // Preserve-and-retry: an ADDITIVE change (a new subsystem layered onto an
  // already-rich doc) can make a single regen drop prior subflows while it adds
  // the new one. Rather than give up immediately, regenerate ONCE more telling
  // the model exactly which subflows it must keep. The guard itself never
  // weakens — we only fall back to keep-prior if the retry ALSO regresses.
  if (regression.length > 0 && regression[0].dropped?.length) {
    const retry = await genVetReviseOnce(repoRoot, entry, {
      runner, feedback: keepSubflowFeedback(regression[0].dropped),
    });
    attempts += retry.attempts + 1;
    r = retry;
    regression = checkSubflowRegression(originalBody, retry.body);
  }

  // Anti-regression guard: a refresh must never ship a manifest that DROPS
  // mermaid subflows the prior had. If even the retry lost any, restore the
  // richer original rather than regress the doc. The prior was already a
  // shipped, validated manifest, so keeping it is strictly safe; the change is
  // simply skipped and surfaced for a deeper `run`.
  if (regression.length > 0) {
    writeFileSync(r.outPath, originalBody);
    return { name: entry.name, status: 'kept-prior', attempts, regression: regression[0].detail };
  }

  const onlyUnfixable = r.vet.status === 'issues' && !hasFixable(r.vet.problems);
  return { name: entry.name, status: (r.vet.status === 'ok' || onlyUnfixable) ? 'active' : 'needs-review', attempts };
}

export async function refreshIncremental(repoRoot, changedFiles, {
  write = process.stdout.write.bind(process.stdout),
  runner,
} = {}) {
  const log = (m) => write(`[refresh] ${m}\n`);
  const impact = computeImpact(repoRoot, changedFiles);

  if (impact.skip) {
    log('no impacted systems + no new candidates — skipping');
    return { skipped: true, regenerated: [] };
  }
  log(`impacted: ${impact.impacted.length}, new candidates: ${impact.newCandidates.length}`);

  // Build the list of (name, globs, summary) entries to regenerate.
  let entries;
  if (impact.newCandidates.length > 0) {
    // New systems present → refresh the hypothesis so naming stays consistent,
    // then regenerate impacted + new from the fresh hypothesis where matched.
    log('new candidates detected → refreshing hypothesis (Pass 1)…');
    await runPass1(repoRoot, { runner });
    // Reload manifests' globs AFTER pass1? Pass 1 only writes _hypothesis.md,
    // not manifests. For simplicity, regenerate impacted manifests (existing
    // front-matter) + create new ones from detector candidates.
    entries = [
      ...impact.impacted.map(m => ({ name: m.name, summary: m.summary, globs: m.globs })),
      ...impact.newCandidates.map(c => ({ name: c.name, summary: '', globs: c.anchors })),
    ];
  } else {
    // Common case: reuse impacted manifests' own front-matter as Pass-2 input.
    entries = impact.impacted.map(m => ({ name: m.name, summary: m.summary, globs: m.globs }));
  }

  const regenerated = [];
  for (const entry of entries) {
    log(`regenerating ${entry.name}…`);
    const r = await genVetRevise(repoRoot, entry, { runner });
    const glyph = r.status === 'active' ? '✓' : r.status === 'kept-prior' ? '↺' : '✗';
    log(`  ${glyph} ${entry.name} (${r.attempts} retries)${r.status === 'kept-prior' ? ` — kept prior: ${r.regression}` : ''}`);
    regenerated.push(r);
  }

  // Re-organize (re-anchored on prior categories) + rebuild HTML so the
  // sidebar + diagrams reflect the updated manifests.
  try {
    log('organize…');
    await runOrganize(repoRoot, { runner });
  } catch (e) { log(`organize failed (non-fatal): ${e.message}`); }
  try {
    log('build…');
    buildSite({ root: repoRoot, out: 'docs/systems.html' });
  } catch (e) { log(`build failed (non-fatal): ${e.message}`); }

  return { skipped: false, regenerated, impact };
}

export const _internal = { hasFixable, FIXABLE_KINDS };
