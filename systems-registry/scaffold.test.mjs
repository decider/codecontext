import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { manifestText, writeManifest } from './scaffold.mjs';
import { parseFrontMatter } from './registry.mjs';

const detection = {
  name: 'example',
  dir: 'tools/example',
  score: 5,
  signals: ['coordinator', 'persistent-state', 'loop', 'subprocess', 'cross-tree'],
  anchors: ['tools/example/**', '.claude/settings.json'],
};

describe('manifestText', () => {
  it('produces parseable front-matter', () => {
    const text = manifestText(detection);
    const { frontMatter } = parseFrontMatter(text);
    assert.equal(frontMatter.name, 'example');
    assert.equal(frontMatter.status, 'draft');
    assert.deepEqual(frontMatter.globs, ['tools/example/**', '.claude/settings.json']);
    assert.deepEqual(frontMatter.detector_signals, detection.signals);
    assert.equal(frontMatter.detector_score, 5);
  });

  it('honours status override + summary override', () => {
    const text = manifestText(detection, { status: 'active', summary: 'one liner' });
    const { frontMatter } = parseFrontMatter(text);
    assert.equal(frontMatter.status, 'active');
    assert.equal(frontMatter.summary, 'one liner');
  });
});

describe('writeManifest', () => {
  it('writes manifest and refuses to overwrite without --force', () => {
    const root = mkdtempSync(join(tmpdir(), 'sr-scaf-'));
    try {
      const r1 = writeManifest(root, detection);
      assert.equal(r1.written, true);
      assert.ok(existsSync(join(root, 'docs/systems/example.md')));
      const r2 = writeManifest(root, detection);
      assert.equal(r2.written, false);
      assert.equal(r2.reason, 'exists');
      const r3 = writeManifest(root, detection, { force: true });
      assert.equal(r3.written, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
