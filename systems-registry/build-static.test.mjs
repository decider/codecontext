import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildSite, _internal } from './build-static.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sr-build-'));
  mkdirSync(join(root, 'docs/systems'), { recursive: true });
  writeFileSync(join(root, 'docs/systems/README.md'), `# overview
\`\`\`mermaid
flowchart LR
  composite-->view
\`\`\`
`);
  writeFileSync(join(root, 'docs/systems/alpha.md'), `---
name: alpha
summary: first system
globs:
  - tools/alpha/**
detector_score: 5
detector_signals:
  - loop
  - tests
---

# alpha

## What it does

Alpha does the thing.

## The loop

\`\`\`mermaid
flowchart LR
  a-->b
\`\`\`

## Invariants

- be alpha
- not beta
`);
  writeFileSync(join(root, 'docs/systems/beta.md'), `---
name: beta
summary: second system
globs:
  - tools/beta/**
detector_score: 4
---

# beta

## What it does

Beta exists.
`);
  return root;
}

describe('buildSite', () => {
  it('writes index.html + .nojekyll', () => {
    const root = fixture();
    try {
      const r = buildSite({ root, out: 'dist/systems' });
      assert.equal(r.systems, 2);
      assert.equal(r.composite, true);
      assert.ok(existsSync(r.outFile));
      assert.ok(existsSync(join(root, 'dist/systems/.nojekyll')));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines all system sections + composite + mermaid blocks', () => {
    const root = fixture();
    try {
      const r = buildSite({ root, out: 'dist/systems' });
      const html = readFileSync(r.outFile, 'utf8');
      assert.match(html, /id="alpha"/);
      assert.match(html, /id="beta"/);
      assert.match(html, /id="__composite__"/);
      assert.match(html, /first system/);
      assert.match(html, /Alpha does the thing/);
      // sanitizeMermaid normalizes LR→TB for viewer parity with the static build
      assert.match(html, /flowchart TB/);
      assert.match(html, /composite--&gt;view/);  // mermaid bodies are html-escaped in <pre>
      assert.match(html, /a--&gt;b/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('renders sidebar nav with one link per system', () => {
    const root = fixture();
    try {
      const r = buildSite({ root, out: 'dist/systems' });
      const html = readFileSync(r.outFile, 'utf8');
      // alpha + beta both glob into tools/ → grouped under a tools/ folder
      // header, rendered as nested links.
      assert.match(html, /<h3 class="nav-folder">tools\/<\/h3>/);
      assert.match(html, /href="#alpha"/);
      assert.match(html, /href="#beta"/);
      assert.match(html, /<a href="#__composite__"/);
      // The score badge appears for systems that have detector_score
      assert.match(html, /<span class="score">5<\/span>/);
      assert.match(html, /<span class="score">4<\/span>/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('handles empty registry gracefully', () => {
    const root = mkdtempSync(join(tmpdir(), 'sr-build-empty-'));
    try {
      mkdirSync(join(root, 'docs/systems'), { recursive: true });
      const r = buildSite({ root, out: 'dist/systems' });
      assert.equal(r.systems, 0);
      const html = readFileSync(r.outFile, 'utf8');
      assert.match(html, /id="__composite__"/);
      // No system pages
      assert.doesNotMatch(html, /class="system-page"/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('html escaping in renderSystemSection', () => {
  it('escapes < and > in system content', () => {
    const sys = {
      name: 'evil',
      summary: 'has <script>alert(1)</script> in summary',
      globs: ['<bad>'],
      detector_signals: [],
      _body: 'just a body',
      _relPath: 'docs/systems/evil.md',
    };
    const html = _internal.renderSystemSection(sys);
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /&lt;bad&gt;/);
  });
});

import { groupSystems } from './build-static.mjs';

describe('groupSystems', () => {
  it('groups by first hyphen segment, singletons stay flat', () => {
    const groups = groupSystems([
      { name: 'apps-api', detector_score: 5 },
      { name: 'apps-web', detector_score: 4 },
      { name: 'scripts', detector_score: 4 },
      { name: 'tools-docgen', detector_score: 7 },
      { name: 'tools-ux-loop', detector_score: 4 },
    ]);
    const byFolder = Object.fromEntries(groups.map(g => [g.folder, g.items.map(i => i.name)]));
    assert.deepEqual(byFolder.apps, ['apps-api', 'apps-web']);
    assert.deepEqual(byFolder.tools, ['tools-docgen', 'tools-ux-loop']);
    assert.deepEqual(byFolder.scripts, ['scripts']);
  });

  it('sorts groups + items alphabetically', () => {
    const groups = groupSystems([
      { name: 'tools-z' }, { name: 'tools-a' },
      { name: 'apps-b' }, { name: 'apps-a' },
    ]);
    assert.deepEqual(groups.map(g => g.folder), ['apps', 'tools']);
    assert.deepEqual(groups[0].items.map(i => i.name), ['apps-a', 'apps-b']);
    assert.deepEqual(groups[1].items.map(i => i.name), ['tools-a', 'tools-z']);
  });
});

describe('groupSystems with LLM categories', () => {
  it('groups by semantic categories when provided', () => {
    const systems = [
      { name: 'api-gateway', globs: ['services/**'] },
      { name: 'parser', globs: ['research/**'] },
      { name: 'docgen', globs: ['tools/**'] },
    ];
    const categories = { categories: [
      { name: 'Runtime', systems: ['api-gateway'] },
      { name: 'Research', systems: ['parser'] },
      { name: 'Tooling', systems: ['docgen'] },
    ]};
    const groups = groupSystems(systems, categories);
    assert.deepEqual(groups.map(g => g.folder), ['Runtime', 'Research', 'Tooling']);
    assert.ok(groups.every(g => g.semantic === true));
  });

  it('puts uncategorized systems into an Other bucket', () => {
    const systems = [{ name: 'a', globs: ['x/**'] }, { name: 'b', globs: ['y/**'] }];
    const categories = { categories: [{ name: 'Core', systems: ['a'] }] };
    const groups = groupSystems(systems, categories);
    const other = groups.find(g => g.folder === 'Other');
    assert.ok(other);
    assert.deepEqual(other.items.map(i => i.name), ['b']);
  });

  it('falls back to glob-dir grouping when no categories', () => {
    const systems = [
      { name: 'api-service', globs: ['services/api/**'] },
      { name: 'job-runner', globs: ['workers/jobs/**'] },
    ];
    const groups = groupSystems(systems, null);
    assert.deepEqual(groups.map(g => g.folder).sort(), ['services', 'workers']);
    assert.ok(groups.every(g => g.semantic === false));
  });
});
