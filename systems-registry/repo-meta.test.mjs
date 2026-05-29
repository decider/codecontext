/**
 * Hermetic tests for repo-meta.mjs — the canonical tool stays repo-
 * agnostic by deriving titles + GitHub URLs from `git remote get-url
 * origin`. Tests assert all the parser branches; the live-`git`
 * integration is exercised by the consumer repos themselves.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { parseGitRemote, repoMeta } from './repo-meta.mjs';

describe('parseGitRemote', () => {
  it('handles SSH github form (git@host:org/repo.git)', () => {
    const r = parseGitRemote('git@github.com:acme/example.git');
    assert.equal(r.url, 'https://github.com/acme/example');
    assert.equal(r.name, 'example');
    assert.equal(r.slug, 'acme/example');
  });

  it('handles HTTPS github form (https://host/org/repo.git)', () => {
    const r = parseGitRemote('https://github.com/acme/example.git');
    assert.equal(r.url, 'https://github.com/acme/example');
    assert.equal(r.name, 'example');
  });

  it('handles HTTPS form without .git suffix', () => {
    const r = parseGitRemote('https://github.com/acme/example');
    assert.equal(r.url, 'https://github.com/acme/example');
    assert.equal(r.name, 'example');
  });

  it('handles HTTPS form with embedded token (token@host)', () => {
    const r = parseGitRemote('https://x-access-token:abc123@github.com/acme/example.git');
    assert.equal(r.url, 'https://github.com/acme/example');
    assert.equal(r.name, 'example');
  });

  it('returns null for empty / unparseable input', () => {
    assert.equal(parseGitRemote(''), null);
    assert.equal(parseGitRemote(null), null);
    assert.equal(parseGitRemote(undefined), null);
  });

  it('falls back to basename for unrecognized formats', () => {
    const r = parseGitRemote('/some/local/path/repo.git');
    assert.equal(r.name, 'repo');
    assert.equal(r.slug, null);   // can't extract org/repo from a local path
  });

  it('handles non-GitHub hosts too (GitLab, self-hosted)', () => {
    const r = parseGitRemote('git@gitlab.example.com:team/proj.git');
    assert.equal(r.url, 'https://gitlab.example.com/team/proj');
    assert.equal(r.name, 'proj');
  });
});

describe('repoMeta', () => {
  it('falls back to dir basename when not in a git repo', () => {
    const root = mkdtempSync(join(tmpdir(), 'sr-repo-meta-NOT-A-REPO-'));
    try {
      const r = repoMeta(root);
      assert.ok(r.name, 'falls back to a non-empty name');
      assert.equal(r.url, '');  // empty URL signals "no link, render plain text"
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
