import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { candidatePaths, resetDedup } from './reset-inject-dedup.mjs';

test('candidatePaths covers both inject scripts naming schemes', () => {
  const paths = candidatePaths('abc-123');
  const filenames = paths.map(p => p.split('/').pop());
  assert.ok(filenames.includes('systems-registry-injected-abc-123.json'),
    'should include systems-registry naming (raw session_id)');
  assert.ok(filenames.includes('docgen-injected-abc-123.json'),
    'should include docgen naming (sanitized session_id)');
});

test('candidatePaths sanitizes docgen path the same way docgen does', () => {
  // docgen replaces non-alphanumeric chars with _
  const paths = candidatePaths('weird/session.id with spaces');
  const docgenName = paths.find(p => p.includes('docgen-injected'));
  assert.ok(docgenName, 'should include a docgen path');
  // Original chars stripped (no /, no ., no spaces)
  assert.ok(!docgenName.includes('/session'),
    'forward slashes should be sanitized');
  assert.ok(!docgenName.includes('.id'),
    'dots should be sanitized');
  assert.ok(!docgenName.includes(' '),
    'spaces should be sanitized');
});

test('candidatePaths preserves systems-registry raw session_id', () => {
  // systems-registry's inject.mjs does NOT sanitize — it just uses
  // `${sessionId || "unknown"}`. We must mirror that exactly or the
  // reset misses real dedup files.
  const paths = candidatePaths('abc-123-with.dots');
  const srName = paths.find(p => p.includes('systems-registry-injected'));
  assert.ok(srName.endsWith('systems-registry-injected-abc-123-with.dots.json'),
    `expected raw session_id passthrough, got ${srName}`);
});

test('candidatePaths handles missing session_id by checking both fallback names', () => {
  const paths = candidatePaths(null);
  const names = paths.map(p => p.split('/').pop());
  // docgen falls back to 'nosession', systems-registry to 'unknown'
  assert.ok(names.includes('systems-registry-injected-unknown.json'));
  assert.ok(names.includes('docgen-injected-nosession.json'));
});

test('resetDedup removes existing dedup files and returns their paths', () => {
  // Place real files in tmpdir() with both naming schemes, then call
  // resetDedup and verify they're gone.
  const dir = tmpdir();
  const sid = `test-reset-${process.pid}-${Date.now()}`;
  const sr = join(dir, `systems-registry-injected-${sid}.json`);
  const dg = join(dir, `docgen-injected-${sid}.json`);
  writeFileSync(sr, '{"systems":["x"]}');
  writeFileSync(dg, '["a"]');
  assert.ok(existsSync(sr) && existsSync(dg), 'pre-condition: files exist');

  const removed = resetDedup(sid);

  assert.ok(removed.includes(sr), 'should report sr file removed');
  assert.ok(removed.includes(dg), 'should report docgen file removed');
  assert.ok(!existsSync(sr), 'sr file should be gone');
  assert.ok(!existsSync(dg), 'docgen file should be gone');
});

test('resetDedup is a no-op when no dedup files exist (does not throw)', () => {
  const sid = `nonexistent-${process.pid}-${Date.now()}`;
  // Should NOT throw even though nothing matches
  const removed = resetDedup(sid);
  assert.deepEqual(removed, [],
    'should return empty list when nothing to clean up');
});
