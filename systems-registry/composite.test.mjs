/**
 * Hermetic tests for composite.mjs — the cross-system README generator.
 * Each test creates a fresh /tmp fixture and asserts against the rendered
 * Mermaid + table; no real-repo I/O.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { parseHypothesis, renderCompositeMermaid, buildCompositeReadme, writeCompositeReadme } from './composite.mjs';

function fixture(setup) {
  const root = mkdtempSync(join(tmpdir(), 'sr-composite-'));
  mkdirSync(join(root, 'docs/systems'), { recursive: true });
  setup(root);
  return root;
}
const cleanup = root => { try { rmSync(root, { recursive: true, force: true }); } catch { /* */ } };

describe('parseHypothesis', () => {
  it('extracts name + summary + consumes from YAML systems: block', () => {
    const text = `# Header

systems:
  - name: alpha
    summary: First system.
    consumes:
      - beta
      - gamma
  - name: beta
    summary: Second.
    consumes: []
  - name: gamma
    summary: Third.
`;
    const out = parseHypothesis(text);
    assert.equal(out.length, 3);
    assert.equal(out[0].name, 'alpha');
    assert.deepEqual(out[0].consumes, ['beta', 'gamma']);
    assert.equal(out[1].consumes.length, 0);
  });

  it('handles YAML block-scalar summaries (`summary: >-`)', () => {
    const text = `systems:
  - name: foo
    summary: >-
      A multi-line
      summary that
      spans lines.
    consumes:
      - bar
`;
    const out = parseHypothesis(text);
    assert.match(out[0].summary, /multi-line summary that spans lines/);
    assert.deepEqual(out[0].consumes, ['bar']);
  });
});

describe('renderCompositeMermaid', () => {
  it('emits one node per system + one edge per consumes ref, with kind-class suffix', () => {
    const md = renderCompositeMermaid([
      { name: 'a', kind: 'pipeline', consumes: ['b'] },
      { name: 'b', kind: 'pipeline', consumes: [] },
    ]);
    assert.match(md, /^```mermaid/);
    // Composite uses flowchart TB (top-bottom) for parity with viewer sanitization.
    assert.match(md, /flowchart TB/);
    assert.match(md, /a\["a"\]:::kind_pipeline/);
    assert.match(md, /b\["b"\]:::kind_pipeline/);
    assert.match(md, /a --> b/);
    assert.match(md, /```$/);
  });

  it('sanitises ids with non-word chars to underscores', () => {
    const md = renderCompositeMermaid([
      { name: 'foo-bar', kind: 'pipeline', consumes: ['baz.qux'] },
      { name: 'baz.qux', kind: 'pipeline', consumes: [] },
    ]);
    assert.match(md, /foo_bar/);
    assert.match(md, /foo_bar --> baz_qux/);
  });

  it('groups nodes into subgraphs by kind (Bootstrap / Producers / Hooks / Gates)', () => {
    const md = renderCompositeMermaid([
      { name: 'inst', kind: 'installer', consumes: [] },
      { name: 'pipe', kind: 'pipeline',  consumes: [] },
      { name: 'hk',   kind: 'hook',      consumes: [] },
      { name: 'gt',   kind: 'gate',      consumes: [] },
    ]);
    assert.match(md, /subgraph bootstrap_grp \["Bootstrap"\]/);
    assert.match(md, /subgraph producers_grp \["Producers"\]/);
    assert.match(md, /subgraph hooks_grp \["Hooks"\]/);
    assert.match(md, /subgraph gates_grp \["Gates"\]/);
  });

  it('synthesizes Claude / Host repo anchor nodes when systems close into them', () => {
    const md = renderCompositeMermaid([
      { name: 'sys-a', kind: 'pipeline', consumes: [], closes_loop_via: 'next_llm_turn — via PreToolUse hook' },
      { name: 'sys-b', kind: 'hook',     consumes: [], closes_loop_via: 'host_repo — commits back onto PR branch' },
      { name: 'sys-c', kind: 'gate',     consumes: [], closes_loop_via: 'none' },
    ]);
    assert.match(md, /claude_turn\(\["Claude/);
    assert.match(md, /host_repo\(\["Host repo/);
    // Thick `==>` edges to anchors, labeled with the prose tail after the token.
    assert.match(md, /sys_a ==>\|via PreToolUse hook\| claude_turn/);
    assert.match(md, /sys_b ==>\|commits back onto PR branch\| host_repo/);
    assert.match(md, /classDef anchor fill:/);
    // kind:none token does NOT get a closes-loop arrow.
    assert.ok(!/sys_c ==>/.test(md), 'kind:none should not emit a closes-loop edge');
  });

  it('truncates long closes-loop labels at a word boundary with an ellipsis (no dangling punctuation)', () => {
    const md = renderCompositeMermaid([
      { name: 'sys-a', kind: 'hook', consumes: [],
        closes_loop_via: 'next_llm_turn — stdout from PreToolUse is injected into the model context for the next turn' },
    ]);
    const edge = md.split('\n').find(l => l.includes('==>'));
    assert.ok(edge, 'a closes-loop edge should exist');
    // Ends with an ellipsis (was truncated) and the char before `…` is NOT
    // dangling punctuation or a mid-word cut.
    assert.match(edge, /…\| claude_turn$/);
    assert.ok(!/['";:,]…/.test(edge), 'no dangling punctuation before the ellipsis');
    // Label must not exceed the cap by much (word-boundary backup).
    const label = edge.match(/==>\|([^|]*)\|/)[1];
    assert.ok(label.length <= 50, `label should be <=50 chars, got ${label.length}`);
  });

  it('emits a `click` binding per node pointing at the in-page hash anchor', () => {
    const md = renderCompositeMermaid([
      { name: 'a', consumes: ['b'] },
      { name: 'foo-bar', consumes: [] },
    ]);
    // node id is sanitized to a_b_c, but the URL keeps the kebab-case
    // because the in-page anchors use the system NAME, not the node id.
    assert.match(md, /click a "#a"/);
    assert.match(md, /click foo_bar "#foo-bar"/);
  });

  it('every click binding sets `_self` so navigation stays in the same tab', () => {
    const md = renderCompositeMermaid([
      { name: 'a', consumes: [] },
      { name: 'b', consumes: [] },
    ]);
    // Mermaid defaults to target=_blank when no target is specified;
    // without `_self` every composite click opens in a new tab in
    // webviews like cmux. The explicit target keeps the user in place.
    assert.match(md, /click a "#a" _self/);
    assert.match(md, /click b "#b" _self/);
    // No bare click lines (would indicate forgotten _self for some node).
    const bareClickRe = /^\s*click \w+ "[^"]+"\s*$/m;
    assert.ok(!bareClickRe.test(md), 'every click line should set _self');
  });
});

describe('buildCompositeReadme', () => {
  it('writes header + mermaid + table; filters consumes to known systems', () => {
    const root = fixture(r => {
      writeFileSync(join(r, 'docs/systems/_hypothesis.md'), `
systems:
  - name: a
    summary: Alpha.
    consumes:
      - b
      - notreal
  - name: b
    summary: Beta.
    consumes: []
`);
      writeFileSync(join(r, 'docs/systems/a.md'), '---\nname: a\nsummary: Alpha summary from manifest.\n---\nbody');
      writeFileSync(join(r, 'docs/systems/b.md'), '---\nname: b\nsummary: Beta summary from manifest.\n---\nbody');
    });
    try {
      const md = buildCompositeReadme(root);
      assert.match(md, /auto-generated by systems-registry composite/);
      assert.match(md, /flowchart TB/);
      // Edge to a real system is kept; edge to "notreal" is dropped.
      assert.match(md, /a --> b/);
      assert.ok(!/a --> notreal/.test(md), 'should not emit edges to unknown systems');
      // Table prefers manifest summary over hypothesis summary.
      assert.match(md, /\| \[a\]\(a\.md\) \| Alpha summary from manifest\./);
    } finally { cleanup(root); }
  });

  it('throws if hypothesis is missing', () => {
    const root = fixture(() => { /* no hypothesis */ });
    try {
      assert.throws(() => buildCompositeReadme(root), /needs.*_hypothesis\.md/);
    } finally { cleanup(root); }
  });
});

describe('writeCompositeReadme', () => {
  it('persists README.md and reports systems + edge count', () => {
    const root = fixture(r => {
      writeFileSync(join(r, 'docs/systems/_hypothesis.md'), `
systems:
  - name: x
    consumes: [y]
  - name: y
    consumes: []
`);
    });
    try {
      const r = writeCompositeReadme(root);
      assert.equal(r.systems, 2);
      assert.equal(r.edges, 1);
      const written = readFileSync(r.path, 'utf8');
      assert.match(written, /x --> y/);
    } finally { cleanup(root); }
  });
});
