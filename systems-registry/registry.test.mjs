import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseFrontMatter,
  globToRegex,
  matchGlob,
  loadAll,
  match,
  extractMermaid,
  renderInjection,
} from './registry.mjs';

describe('parseFrontMatter', () => {
  it('parses scalars + lists', () => {
    const { rest, frontMatter } = parseFrontMatter(`---
name: foo
summary: hello world
globs:
  - tools/foo/**
  - "**/bar.json"
status: active
---
body
`);
    assert.equal(frontMatter.name, 'foo');
    assert.equal(frontMatter.summary, 'hello world');
    assert.deepEqual(frontMatter.globs, ['tools/foo/**', '**/bar.json']);
    assert.equal(frontMatter.status, 'active');
    assert.equal(rest.trim(), 'body');
  });

  it('parses nested map (inject block)', () => {
    const { frontMatter } = parseFrontMatter(`---
name: foo
inject:
  mermaid: true
  page_link: false
  cap_bytes: 8192
---
body`);
    assert.deepEqual(frontMatter.inject, { mermaid: true, page_link: false, cap_bytes: 8192 });
  });

  it('returns null front-matter when none present', () => {
    const { rest, frontMatter } = parseFrontMatter('# no front matter\nbody');
    assert.equal(frontMatter, null);
    assert.equal(rest, '# no front matter\nbody');
  });
});

describe('globToRegex / matchGlob', () => {
  it('matches simple ** patterns', () => {
    assert.ok(matchGlob('tools/docgen/docgen.mjs', 'tools/docgen/**'));
    assert.ok(matchGlob('tools/docgen', 'tools/docgen/**'));  // dir itself
    assert.ok(!matchGlob('tools/other/foo.mjs', 'tools/docgen/**'));
  });

  it('matches single-segment globs', () => {
    assert.ok(matchGlob('a/b.json', 'a/*.json'));
    assert.ok(!matchGlob('a/sub/b.json', 'a/*.json'));
  });

  it('escapes regex metachars in literal segments', () => {
    assert.ok(matchGlob('a.b/file', 'a.b/file'));
    assert.ok(!matchGlob('axb/file', 'a.b/file'));
  });

  it('handles ?', () => {
    assert.ok(matchGlob('a/b', 'a/?'));
    assert.ok(!matchGlob('a/bb', 'a/?'));
  });
});

describe('loadAll', () => {
  it('returns systems from front-matter, skipping README.md and drafts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sr-test-'));
    try {
      mkdirSync(join(dir, 'docs/systems'), { recursive: true });
      writeFileSync(join(dir, 'docs/systems/README.md'), '# overview');  // should be skipped
      writeFileSync(join(dir, 'docs/systems/active.md'), `---
name: active
globs:
  - foo/**
---
body`);
      writeFileSync(join(dir, 'docs/systems/draft.md'), `---
name: draft
status: draft
globs:
  - bar/**
---
body`);
      const systems = loadAll(dir);
      assert.equal(systems.length, 1);
      assert.equal(systems[0].name, 'active');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('match', () => {
  it('returns systems whose globs cover the path', () => {
    const systems = [
      { name: 'a', globs: ['foo/**'] },
      { name: 'b', globs: ['bar/**', 'shared/*.md'] },
      { name: 'c', globs: [] },
    ];
    assert.deepEqual(match(systems, 'foo/x/y.ts').map(s => s.name), ['a']);
    assert.deepEqual(match(systems, 'bar/q.ts').map(s => s.name), ['b']);
    assert.deepEqual(match(systems, 'shared/x.md').map(s => s.name), ['b']);
    assert.deepEqual(match(systems, 'unrelated/z.ts').map(s => s.name), []);
  });
});

describe('extractMermaid', () => {
  it('extracts first mermaid block', () => {
    const m = extractMermaid('intro\n```mermaid\nflowchart LR\n  a-->b\n```\nafter');
    assert.ok(m && m.includes('flowchart LR'));
  });
  it('returns null when none', () => {
    assert.equal(extractMermaid('no diagram'), null);
  });
});

describe('extractAllMermaid', () => {
  it('returns empty array when no diagrams', async () => {
    const { extractAllMermaid } = await import('./registry.mjs');
    assert.deepEqual(extractAllMermaid('no diagram here'), []);
  });

  it('extracts every block in document order with nearest heading', async () => {
    const { extractAllMermaid } = await import('./registry.mjs');
    const body = [
      '## The loop',
      '```mermaid',
      'flowchart LR',
      '  a-->b',
      '```',
      '',
      'prose',
      '',
      '## Subflow: hot-path',
      '```mermaid',
      'flowchart LR',
      '  c-->d',
      '```',
      '',
      '## Subflow: withdrawals',
      'no diagram in this section',
      '',
      '## Anchors',
      '```mermaid',
      'flowchart LR',
      '  e-->f',
      '```',
    ].join('\n');
    const blocks = extractAllMermaid(body);
    assert.equal(blocks.length, 3);
    assert.equal(blocks[0].heading, 'The loop');
    assert.ok(blocks[0].block.includes('a-->b'));
    assert.equal(blocks[1].heading, 'Subflow: hot-path');
    assert.ok(blocks[1].block.includes('c-->d'));
    // Third block lives under ## Anchors (the nearest prior ##)
    assert.equal(blocks[2].heading, 'Anchors');
    assert.ok(blocks[2].block.includes('e-->f'));
  });

  it('uses empty heading when a block appears before any ##', async () => {
    const { extractAllMermaid } = await import('./registry.mjs');
    const body = '```mermaid\nflowchart LR\n  a-->b\n```';
    const blocks = extractAllMermaid(body);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].heading, '');
  });
});

describe('renderInjection — multi-mermaid', () => {
  it('emits ALL mermaid blocks with their subflow headings', () => {
    const sys = {
      name: 'billing-engine',
      summary: 'mock',
      _body: [
        '## The loop',
        '```mermaid',
        'flowchart LR',
        '  loop_a-->loop_b',
        '```',
        '## Subflow: hot-path',
        '```mermaid',
        'flowchart LR',
        '  hot_c-->hot_d',
        '```',
      ].join('\n'),
      _relPath: 'docs/systems/billing-engine.md',
      inject: { mermaid: true, page_link: true, cap_bytes: 10240 },
    };
    const out = renderInjection(sys);
    assert.ok(out.includes('loop_a-->loop_b'), 'top-level loop must appear');
    assert.ok(out.includes('hot_c-->hot_d'), 'subflow must also appear');
    assert.ok(out.includes('### Subflow: hot-path'), 'subflow heading must be emitted as ### label');
  });

  it('whole-block-trims trailing subflows when total exceeds cap_bytes', () => {
    // Two large blocks (~800 chars each) with cap that fits only the first
    const big = 'flowchart LR\n' + Array.from({length: 30}, (_, i) => `  node${i}-->next${i}`).join('\n');
    const sys = {
      name: 'big-system',
      summary: 'mock',
      _body: [
        '## The loop',
        '```mermaid',
        big,
        '```',
        '## Subflow: extra',
        '```mermaid',
        big,
        '```',
      ].join('\n'),
      _relPath: 'docs/systems/big.md',
      inject: { mermaid: true, page_link: true, cap_bytes: 1200 },
    };
    const out = renderInjection(sys);
    // First block survives intact (no mid-diagram truncation)
    assert.ok(out.includes('node0-->next0'));
    assert.ok(out.includes('node29-->next29'),
      'first block must be whole, never mid-diagram truncated');
    // Second block was dropped
    assert.ok(!out.includes('### Subflow: extra'),
      'trailing subflow should have been dropped under the cap');
    // Still under cap
    assert.ok(out.length <= 1200, `expected <= 1200 chars, got ${out.length}`);
  });

  it('falls back to hard truncation only when one block alone exceeds cap', () => {
    const huge = 'a'.repeat(500);
    const sys = {
      name: 's',
      summary: '',
      _body: '## L\n```mermaid\n' + huge + '\n```',
      _relPath: 'docs/systems/s.md',
      inject: { mermaid: true, page_link: false, cap_bytes: 200 },
    };
    const out = renderInjection(sys);
    assert.ok(out.includes('truncated'),
      'single-block-exceeds-cap path must hard-truncate');
  });
});

describe('renderInjection', () => {
  it('emits summary + mermaid + link', () => {
    const sys = {
      name: 'docgen',
      summary: 'self-updating docs',
      _body: '## loop\n```mermaid\nflowchart LR\n  a-->b\n```\nrest',
      _relPath: 'docs/systems/docgen.md',
      inject: { mermaid: true, page_link: true, cap_bytes: 4096 },
    };
    const out = renderInjection(sys);
    assert.ok(out.includes('systems-registry: docgen'));
    assert.ok(out.includes('self-updating docs'));
    assert.ok(out.includes('mermaid'));
    assert.ok(out.includes('docs/systems/docgen.md'));
  });

  it('respects cap_bytes', () => {
    const sys = {
      name: 'foo',
      summary: 'x'.repeat(8000),
      _body: '',
      _relPath: 'docs/systems/foo.md',
      inject: { mermaid: false, page_link: true, cap_bytes: 200 },
    };
    const out = renderInjection(sys);
    assert.ok(out.length <= 250);
    assert.ok(out.includes('truncated'));
  });
});
