#!/usr/bin/env node
/**
 * systems-registry — repo metadata helpers.
 *
 * The tool ships canonical from a single home repo and is synced into
 * consumer repos. Any hard-coded URL or display name in the tool source
 * would leak into every consumer build. This module is where every
 * "what is this repo called / where does it live on GitHub" question
 * goes — derive it once from `git remote get-url origin`, never bake a
 * literal into UI / output strings.
 *
 * No I/O outside `git remote get-url` and `git rev-parse`. Pure function
 * downstream callers can mock by passing a fixed `{ url, name }`.
 */

import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

/**
 * Pure parser — string → { url, name, slug } | null.
 *
 * Accepts the two GitHub remote URL forms (`git@github.com:org/repo.git`
 * and `https://github.com/org/repo.git`) plus the no-`.git` variants.
 * Other Git hosts pass through unchanged for `url`; `name` falls back to
 * the path basename. Returns null for an empty / unparseable input so
 * callers can fall back gracefully.
 */
export function parseGitRemote(remote) {
  if (!remote) return null;
  const r = remote.trim();
  if (!r) return null;
  // git@github.com:org/repo(.git)?
  let m = r.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (m) {
    const slug = m[2];
    return { url: `https://${m[1]}/${slug}`, name: basename(slug), slug };
  }
  // https://github.com/org/repo(.git)?  (also handles http, ssh:// with host)
  m = r.match(/^(?:https?|ssh):\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?$/);
  if (m) {
    const slug = m[2];
    return { url: `https://${m[1]}/${slug}`, name: basename(slug), slug };
  }
  // Local path / unrecognized form — at least extract a name from it.
  return { url: r, name: basename(r.replace(/\.git$/, '')), slug: null };
}

/**
 * Derive repo metadata from the cwd (or a passed-in root). Best-effort:
 * if not in a git repo, returns a safe default so the tool keeps working.
 */
export function repoMeta(root) {
  const args = ['remote', 'get-url', 'origin'];
  if (root) args.unshift('-C', root);
  try {
    const remote = execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const parsed = parseGitRemote(remote);
    if (parsed) return parsed;
  } catch { /* not a git repo / no remote */ }
  // Fall back to the dir basename. Consumers see this in titles + READMEs;
  // it's the right thing when running locally in an unconfigured clone.
  const dirName = root ? basename(root) : basename(process.cwd());
  return { url: '', name: dirName, slug: null };
}
