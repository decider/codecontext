import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrCommand, workdirFromCommand, changedDirs, docPathsFromStatus, docgenCandidates, sysregCandidates } from './auto-docs-refresh.mjs';
import { isAbsolute, sep } from 'node:path';

test('isPrCommand: matches PR-opening / updating commands', () => {
  assert.equal(isPrCommand('gh pr create --base main --title x'), true);
  assert.equal(isPrCommand('git push -u origin feat/x'), true);
  assert.equal(isPrCommand('git push origin HEAD:feat/x'), true);
  assert.equal(isPrCommand('cd /tmp/x && git push -u origin feat/x'), true);
  assert.equal(isPrCommand('gh   pr   create'), true);
});

test('isPrCommand: ignores non-PR / destructive commands', () => {
  assert.equal(isPrCommand('git status'), false);
  assert.equal(isPrCommand('gh pr view 123'), false);
  assert.equal(isPrCommand('gh pr merge 12 --squash'), false);
  assert.equal(isPrCommand('git push origin --delete feat/x'), false);
  assert.equal(isPrCommand('git push origin :feat/x'), false);
  assert.equal(isPrCommand(''), false);
  assert.equal(isPrCommand(null), false);
  assert.equal(isPrCommand(undefined), false);
});

test('workdirFromCommand: extracts cd / git -C, else fallback', () => {
  assert.equal(workdirFromCommand('cd /tmp/x && git push', 'FB'), '/tmp/x');
  assert.equal(workdirFromCommand('git -C /tmp/y push', 'FB'), '/tmp/y');
  assert.equal(workdirFromCommand("cd '/tmp/with space' && git push", 'FB'), '/tmp/with space');
  assert.equal(workdirFromCommand('cd "/tmp/q" && git push', 'FB'), '/tmp/q');
  assert.equal(workdirFromCommand('git push -u origin feat/x', 'FB'), 'FB');
  assert.equal(workdirFromCommand(null, 'FB'), 'FB');
});

test('changedDirs: unique parent dirs, root files → "."', () => {
  assert.deepEqual(changedDirs(['a/b.js', 'a/c.js', 'd.txt']).sort(), ['.', 'a']);
  assert.deepEqual(changedDirs(['tools/docgen/x.mjs', 'tools/docgen/y.mjs']), ['tools/docgen']);
  assert.deepEqual(changedDirs([]), []);
});

test('docPathsFromStatus: selects only doc files (AUTO_DOCS.md, docgen state, system docs)', () => {
  const porcelain = [
    ' M tools/foo/AUTO_DOCS.md',
    ' M docs/systems/app.md',
    ' M docs/systems.html',
    ' M tools/claude-code-auto-documentation/.docgen/state.json',
    ' M src/index.ts',
    ' M some/README.md',
    '?? scratch.txt',
  ].join('\n');
  assert.deepEqual(docPathsFromStatus(porcelain).sort(), [
    'docs/systems.html',
    'docs/systems/app.md',
    'tools/claude-code-auto-documentation/.docgen/state.json',
    'tools/foo/AUTO_DOCS.md',
  ]);
  // A hand-written README.md is NOT a doc file we own — must be excluded.
  assert.deepEqual(docPathsFromStatus(' M pkg/README.md'), []);
  // rename form `R  old -> new` keeps the new path
  assert.deepEqual(docPathsFromStatus('R  a/README.md -> a/AUTO_DOCS.md'), ['a/AUTO_DOCS.md']);
});

test('docgenCandidates: host-repo bins first, then the sibling bundled beside this hook', () => {
  const c = docgenCandidates('/repo');
  // host-repo copies are probed first, so a local override wins
  assert.deepEqual(c.slice(0, 2), ['/repo/tools/docgen/docgen', '/repo/tools/claude-code-auto-documentation/docgen']);
  // last candidate is the docgen that ships inside this bundle (absolute, regardless of mount point)
  const bundled = c[c.length - 1];
  assert.equal(isAbsolute(bundled), true);
  assert.equal(bundled.endsWith(`${sep}docgen${sep}docgen`), true);
  // bundled path is NOT under the passed-in repo root — it's resolved from this file's own location
  assert.equal(bundled.startsWith('/repo/'), false);
});

test('sysregCandidates: host-repo CLI first, then the sibling bundled beside this hook', () => {
  const c = sysregCandidates('/repo');
  assert.equal(c[0], '/repo/tools/systems-registry/cli.mjs');
  const bundled = c[c.length - 1];
  assert.equal(isAbsolute(bundled), true);
  assert.equal(bundled.endsWith(`${sep}systems-registry${sep}cli.mjs`), true);
  assert.equal(bundled.startsWith('/repo/'), false);
});
