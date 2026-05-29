import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startServer, _internal } from './view.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sr-view-'));
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
detector_signals:
  - subprocess
---

# beta

## What it does

Beta exists.
`);
  return root;
}

describe('renderPage', () => {
  it('renders the overview (composite) on the default landing, not a system body', () => {
    const root = fixture();
    try {
      const html = _internal.renderPage(root);
      assert.match(html, /Systems Registry/);
      assert.match(html, /<nav>/);
      assert.match(html, /alpha/);   // nav lists all systems
      assert.match(html, /beta/);
      assert.match(html, /How the systems feed each other/);
      // composite mermaid rendered. sanitizeMermaid normalizes LR→TB for
      // viewer parity with the static build, so assert on the normalized form.
      assert.match(html, /flowchart TB/);
      // landing is overview-only — no individual system body
      assert.doesNotMatch(html, /Alpha does the thing\./);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('surfaces run-report data: color-coded sidebar score badges + Quality & vet panel + Last run summary', () => {
    const root = fixture();
    try {
      // Stamp a quality score into beta.md frontmatter (the score-badge
      // fallback path) and write a .run-report.json that records both
      // systems — beta below the bar, alpha above. The viewer should
      // surface the score badges and the Quality panel.
      writeFileSync(join(root, 'docs/systems/beta.md'), `---
name: beta
summary: second system
globs:
  - tools/beta/**
quality_score: 5.5
quality_verdict: revise
---

# beta

## What it does

Beta exists.
`);
      writeFileSync(join(root, 'docs/systems/.run-report.json'), JSON.stringify({
        schemaVersion: 1,
        startedAt: '2026-05-27T00:00:00.000Z',
        finishedAt: '2026-05-27T00:01:00.000Z',
        minScore: 7,
        llmVetEnabled: false,
        summary: { total: 2, active: 1, needsReview: 1, errored: 0, avgQualityScore: 7.25, belowBar: ['beta (5.5)'] },
        pruned: [],
        systems: [
          {
            name: 'alpha', status: 'active', qualityScore: 9.0, qualityVerdict: 'ship',
            reviseAttempts: 0, refineRounds: 0, elapsedMs: 1200,
            finalProblems: [], initialProblems: [], llmFindings: null,
          },
          {
            name: 'beta', status: 'needs-review', qualityScore: 5.5, qualityVerdict: 'revise',
            reviseAttempts: 2, refineRounds: 1, elapsedMs: 4500,
            finalProblems: [{ kind: 'hallucinated-symbol', detail: 'fakeFn' }],
            initialProblems: [
              { kind: 'hallucinated-symbol', detail: 'fakeFn' },
              { kind: 'missing-section', detail: 'Invariants' },
            ],
            llmFindings: { rationale: 'fakeFn does not appear in any anchor file' },
          },
        ],
      }));

      // Overview: Last run summary visible with below-bar link
      const overview = _internal.renderPage(root);
      assert.match(overview, /Last pipeline run/);
      assert.match(overview, /<b>2<\/b> systems/);
      assert.match(overview, /<b>1<\/b> needs-review/);
      assert.match(overview, /below bar/);
      assert.match(overview, /href="\/\?system=beta"/);

      // Sidebar score badges color-coded — alpha green, beta red
      assert.match(overview, /class="qbadge"[^>]*title="quality score 9[^"]*"/);
      assert.match(overview, /class="qbadge"[^>]*title="quality score 5\.5[^"]*"/);

      // Per-system page: Quality & vet panel with outstanding problem
      const betaPage = _internal.renderPage(root, 'beta');
      assert.match(betaPage, /Quality &amp; vet/);
      assert.match(betaPage, /5\.5\/10/);
      assert.match(betaPage, /Still flagged after 2 retries/);
      assert.match(betaPage, /hallucinated-symbol/);
      assert.match(betaPage, /fakeFn/);
      // The missing-section was caught + fixed by revise (in initial, not final)
      assert.match(betaPage, /Caught \+ fixed by revise/);
      assert.match(betaPage, /missing-section/);
      // Judge rationale surfaces
      assert.match(betaPage, /Judge rationale/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('renders only the selected system when ?system=beta (no composite on the page)', () => {
    const root = fixture();
    try {
      const html = _internal.renderPage(root, 'beta');
      assert.match(html, /Beta exists\./);
      assert.doesNotMatch(html, /Alpha does the thing\./);
      // the cross-system map must NOT appear on an individual system page
      assert.doesNotMatch(html, /How the systems feed each other/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('renders subflows as separate mermaid blocks with anchor IDs', () => {
    // System body with a primary Loop + two named subflows. The viewer should
    // render every mermaid block (not just the first) and anchor each subflow
    // for sidebar jump-links.
    const root = mkdtempSync(join(tmpdir(), 'sr-view-subflows-'));
    try {
      mkdirSync(join(root, 'docs/systems'), { recursive: true });
      writeFileSync(join(root, 'docs/systems/gamma.md'), `---
name: gamma
summary: with subflows
globs:
  - tools/gamma/**
---

## The loop

\`\`\`mermaid
flowchart LR
  start-->done
\`\`\`

## Subflow: phase-one

phase-one prose intro

\`\`\`mermaid
flowchart LR
  p1a-->p1b
\`\`\`

## Subflow: phase-two

\`\`\`mermaid
flowchart LR
  p2a-->p2b
\`\`\`
`);
      const html = _internal.renderPage(root, 'gamma');
      // Both subflow diagrams rendered as mermaid (3 total: 1 primary + 2 subflows)
      const mermaidCount = (html.match(/class="mermaid"/g) || []).length;
      assert.equal(mermaidCount, 3, 'expected 3 mermaid blocks (1 loop + 2 subflows)');
      // Subflow anchor IDs are slug-based so sidebar jumplinks work
      assert.match(html, /id="subflow-phase-one"/);
      assert.match(html, /id="subflow-phase-two"/);
      // Sidebar shows expanded jumplinks for the active system
      assert.match(html, /class="subflow-list"/);
      assert.match(html, /href="\/\?system=gamma#subflow-phase-one"/);
      // The Subflow markdown headers are NOT duplicated as body prose
      // (they're rendered via <details><summary>, not via renderMarkdown's h2).
      assert.doesNotMatch(html, /<h2>Subflow: phase-one<\/h2>/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('handles empty registry gracefully', () => {
    const root = mkdtempSync(join(tmpdir(), 'sr-view-empty-'));
    try {
      const html = _internal.renderPage(root, null);
      assert.match(html, /No systems registered/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('renderMarkdown', () => {
  it('renders headings, lists, code blocks', () => {
    const md = `## heading\n\nparagraph\n\n- item one\n- item two\n\n\`\`\`\ncode line\n\`\`\``;
    const html = _internal.renderMarkdown(md);
    assert.match(html, /<h2>heading<\/h2>/);
    assert.match(html, /<p>paragraph<\/p>/);
    assert.match(html, /<ul>/);
    assert.match(html, /<li>item one<\/li>/);
    assert.match(html, /<pre><code>code line<\/code><\/pre>/);
  });

  it('escapes HTML in content', () => {
    const html = _internal.renderMarkdown('paragraph with <script>alert(1)</script>');
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;script&gt;/);
  });

  it('linkifies markdown links', () => {
    const html = _internal.renderMarkdown('see [docs](https://example.com)');
    assert.match(html, /<a href="https:\/\/example.com" target="_blank">docs<\/a>/);
  });
});

describe('startServer', () => {
  it('serves / and /api/systems', async () => {
    const root = fixture();
    try {
      const { server, url } = await startServer({ port: 0, root, open: false });
      try {
        const r1 = await fetch(url);
        assert.equal(r1.status, 200);
        const html = await r1.text();
        assert.match(html, /Systems Registry/);

        const r2 = await fetch(url + 'api/systems');
        assert.equal(r2.status, 200);
        const data = await r2.json();
        assert.equal(data.length, 2);
        assert.deepEqual(data.map(s => s.name).sort(), ['alpha', 'beta']);

        const r3 = await fetch(url + 'nothing');
        assert.equal(r3.status, 404);
      } finally {
        server.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
