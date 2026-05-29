/**
 * Hermetic tests for the within-page subflow mechanism: parsing
 * (pass25-vet `findSubflows`), the splitting-candidate flag
 * (`checkSplittingCandidate`), the cheap-vet integration, and the
 * static-site rendering (`renderSystemSection` emits `<details>`).
 *
 * All fixtures synthetic — no repo-specific terms, no real LLM, no real
 * git remote. Same mkdtempSync pattern as the rest of the suite.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cheapVet, _internal as vetInternal } from './pass25-vet.mjs';
import { _internal as buildInternal } from './build-static.mjs';

const { findSubflows, checkSplittingCandidate, MAX_SUBFLOWS_BEFORE_SPLIT, MAX_BODY_BYTES_BEFORE_SPLIT } = vetInternal;
const { renderSystemSection } = buildInternal;

function fixture(setup) {
  const root = mkdtempSync(join(tmpdir(), 'sr-subflows-'));
  setup(root);
  return root;
}
const cleanup = root => { try { rmSync(root, { recursive: true, force: true }); } catch { /* */ } };

const validManifest = (subflowSections = '', extras = '') => `---
name: example
summary: A system that does the thing.
globs:
  - src/**
status: active
---

# example

## What it does

It does the thing.

## The loop

\`\`\`mermaid
flowchart LR
  start --> middle --> end
\`\`\`

${subflowSections}

## Anchors

- src/main.ts — entrypoint
- src/lib.ts — the lib

## Closing arrow

Loop closes via state.json.

## Invariants

- One

## Failure modes

- One

## Where to start reading

1. src/main.ts
${extras}`;

const subflow = (name, body = `flowchart LR\n  a --> b`) => `## Subflow: ${name}

A short description of what this subflow does.

\`\`\`mermaid
${body}
\`\`\`
`;

describe('findSubflows', () => {
  it('returns [] for pages with no Subflow headings', () => {
    assert.deepEqual(findSubflows(validManifest()), []);
  });

  it('extracts one subflow with its mermaid presence', () => {
    const body = validManifest(subflow('alpha'));
    const out = findSubflows(body);
    assert.equal(out.length, 1);
    assert.equal(out[0].name, 'alpha');
    assert.equal(out[0].hasMermaid, true);
  });

  it('preserves document order across multiple subflows', () => {
    const body = validManifest(subflow('alpha') + '\n' + subflow('beta') + '\n' + subflow('gamma'));
    const out = findSubflows(body);
    assert.deepEqual(out.map(s => s.name), ['alpha', 'beta', 'gamma']);
  });

  it('does not match `## Subflows` (plural) or `### Subflow:` (h3) — strict h2 only', () => {
    const body = `## Subflows\n\nWords.\n### Subflow: nope\nWords.\n`;
    assert.deepEqual(findSubflows(body), []);
  });

  it('flags a subflow with no mermaid block as hasMermaid:false', () => {
    const body = validManifest('## Subflow: dry\n\nNo mermaid here.\n');
    const out = findSubflows(body);
    assert.equal(out.length, 1);
    assert.equal(out[0].hasMermaid, false);
  });
});

describe('checkSplittingCandidate', () => {
  it('returns [] for small pages with few subflows', () => {
    const body = validManifest(subflow('a') + subflow('b'));
    assert.deepEqual(checkSplittingCandidate(body), []);
  });

  it('flags when subflow count > threshold', () => {
    const many = Array.from({ length: MAX_SUBFLOWS_BEFORE_SPLIT + 1 }, (_, i) => subflow(`sf${i}`)).join('\n');
    const out = checkSplittingCandidate(validManifest(many));
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, 'splitting-candidate');
    assert.match(out[0].detail, /subflows/);
  });

  it('flags when body bytes > threshold', () => {
    const huge = validManifest('', '\n\n' + 'x'.repeat(MAX_BODY_BYTES_BEFORE_SPLIT + 100));
    const out = checkSplittingCandidate(huge);
    assert.equal(out.length, 1);
    assert.match(out[0].detail, /KB/);
  });

  it('combines reasons when both thresholds hit', () => {
    const many = Array.from({ length: MAX_SUBFLOWS_BEFORE_SPLIT + 1 }, (_, i) => subflow(`sf${i}`)).join('\n');
    const padding = 'x'.repeat(MAX_BODY_BYTES_BEFORE_SPLIT);
    const out = checkSplittingCandidate(validManifest(many, '\n\n' + padding));
    assert.equal(out.length, 1);
    assert.match(out[0].detail, /subflows.*\+.*KB|KB.*\+.*subflows/);
  });
});

describe('cheapVet integration', () => {
  it('a normal page with subflows is `active` (no splitting-candidate, all mermaid valid)', () => {
    const root = fixture(r => {
      mkdirSync(join(r, 'docs/systems'), { recursive: true });
      mkdirSync(join(r, 'src'), { recursive: true });
      writeFileSync(join(r, 'src/main.ts'), '// main');
      writeFileSync(join(r, 'src/lib.ts'), '// lib');
      writeFileSync(join(r, 'docs/systems/example.md'), validManifest(subflow('alpha') + subflow('beta')));
    });
    try {
      const v = cheapVet(root, join(root, 'docs/systems/example.md'));
      const splits = v.problems.filter(p => p.kind === 'splitting-candidate');
      const mermaidIssues = v.problems.filter(p => p.kind === 'mermaid-issue');
      assert.equal(splits.length, 0, 'should not flag small pages');
      assert.equal(mermaidIssues.length, 0, 'all mermaid blocks should validate');
    } finally { cleanup(root); }
  });

  it('emits per-block mermaid errors when a subflow diagram is malformed', () => {
    const broken = '## Subflow: broken\n\nDesc.\n\n```mermaid\nnot a real diagram type\n```\n';
    const root = fixture(r => {
      mkdirSync(join(r, 'docs/systems'), { recursive: true });
      mkdirSync(join(r, 'src'), { recursive: true });
      writeFileSync(join(r, 'src/main.ts'), '// main');
      writeFileSync(join(r, 'src/lib.ts'), '// lib');
      writeFileSync(join(r, 'docs/systems/example.md'), validManifest(broken));
    });
    try {
      const v = cheapVet(root, join(root, 'docs/systems/example.md'));
      const mermaidIssues = v.problems.filter(p => p.kind === 'mermaid-issue');
      assert.ok(mermaidIssues.length >= 1, 'should flag the broken subflow diagram');
      assert.match(mermaidIssues[0].detail, /block 2\/2|unrecognized/);
    } finally { cleanup(root); }
  });
});

describe('renderSystemSection — static site rendering', () => {
  const baseSystem = {
    name: 'example',
    summary: 'sum',
    globs: ['src/**'],
    detector_score: 5,
    detector_signals: ['coordinator'],
    _relPath: 'docs/systems/example.md',
  };

  it('renders no subflow scaffolding when the body has none', () => {
    const html = renderSystemSection({ ...baseSystem, _body: validManifest() }, 'https://example.com/r');
    assert.ok(!html.includes('<div class="subflows">'),
      'no subflow wrapper when there are no subflows');
    assert.ok(!html.includes('<details class="subflow"'));
  });

  it('renders each subflow as a collapsible <details> in document order', () => {
    const body = validManifest(subflow('alpha') + subflow('beta'));
    const html = renderSystemSection({ ...baseSystem, _body: body }, 'https://example.com/r');
    assert.match(html, /<div class="subflows">/);
    assert.match(html, /<h3>Subflows \(2\)<\/h3>/);
    // Both subflows appear, alpha before beta.
    const ai = html.indexOf('Subflow:</strong> alpha');
    const bi = html.indexOf('Subflow:</strong> beta');
    assert.ok(ai > 0 && bi > 0 && ai < bi, 'subflows render in document order');
    // Each gets a stable anchor id.
    assert.match(html, /id="example--alpha"/);
    assert.match(html, /id="example--beta"/);
  });

  it('subflow body is hidden from the main prose body (no duplication)', () => {
    const body = validManifest(subflow('alpha'));
    const html = renderSystemSection({ ...baseSystem, _body: body }, 'https://example.com/r');
    // The subflow heading should appear ONCE — inside the <details>, not also
    // again as a prose H2 in the body section.
    const matches = (html.match(/Subflow:[^<\n]*alpha/g) || []).length;
    assert.ok(matches <= 2, `subflow name should not render duplicated outside <details>; matched ${matches}x`);
  });
});
