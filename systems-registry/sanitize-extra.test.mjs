import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeMermaid } from './build-static.mjs';

describe('sanitizeMermaid', () => {
  it('quotes unquoted node labels (rectangle)', () => {
    const out = sanitizeMermaid('flowchart LR\n  A[hello world]');
    assert.match(out, /A\["hello world"\]/);
  });

  it('quotes unquoted decision labels', () => {
    const out = sanitizeMermaid('flowchart LR\n  A{is it?}');
    assert.match(out, /A\{"is it\?"\}/);
  });

  it('quotes cylinder labels', () => {
    const out = sanitizeMermaid('flowchart LR\n  A[(database)]');
    assert.match(out, /A\[\("database"\)\]/);
  });

  it('defuses nested brackets in labels (the redact[REDACTED] case)', () => {
    const out = sanitizeMermaid('flowchart LR\n  R[redact to [REDACTED]]');
    // inner [...] becomes (...) inside the label
    assert.match(out, /R\["redact to \(REDACTED\)"\]/);
  });

  it('encodes raw & in labels (the P&L case)', () => {
    const out = sanitizeMermaid('flowchart LR\n  A[verdict: P&L]');
    assert.match(out, /A\["verdict: P&amp;L"\]/);
    // does not double-encode pre-existing entities
    const out2 = sanitizeMermaid('flowchart LR\n  A[already &amp; encoded]');
    assert.match(out2, /already &amp; encoded/);
  });

  it('adds space after subgraph identifier (subgraph foo[Title] case)', () => {
    const out = sanitizeMermaid('flowchart LR\n  subgraph foo[my title]\n  end');
    assert.match(out, /subgraph foo \["my title"\]/);
  });

  it('leaves already-quoted labels alone', () => {
    const out = sanitizeMermaid('flowchart LR\n  A["already"]');
    assert.match(out, /A\["already"\]/);
    // shouldn't double-quote
    assert.doesNotMatch(out, /A\["{2}/);
  });

  it('sequenceDiagram: strips <br/> from participant aliases', () => {
    const out = sanitizeMermaid('sequenceDiagram\n  participant W as workflow/<br/>orchestrate.ts');
    assert.match(out, /participant W as workflow\/ orchestrate\.ts/);
    assert.doesNotMatch(out, /<br/);
  });

  it('sequenceDiagram: removes Unicode arrows from messages', () => {
    const out = sanitizeMermaid('sequenceDiagram\n  A->>B: click Run →');
    assert.doesNotMatch(out, /→/);
  });

  it('sequenceDiagram: strips quote marks from message text', () => {
    const out = sanitizeMermaid('sequenceDiagram\n  A->>B: click "Run request-pipeline"');
    assert.doesNotMatch(out, /"Run request-pipeline"/);
    assert.match(out, /click Run request-pipeline/);
  });

  it('does not touch non-mermaid input', () => {
    const out = sanitizeMermaid('not a mermaid diagram');
    assert.equal(out, 'not a mermaid diagram');
  });
});

import { sanitizeMermaid as sm2 } from './build-static.mjs';

describe('reserved-keyword renaming', () => {
  it('renames `graph` node ID to graph_n', () => {
    const out = sm2('flowchart LR\n  graph[my label] --> next');
    assert.doesNotMatch(out, /\bgraph\b\[/);
    assert.match(out, /graph_n\[/);
  });

  it('renames `class` used as a node ID', () => {
    const out = sm2('flowchart LR\n  class{decision}');
    assert.match(out, /class_n\{/);
  });

  it('does NOT rename `subgraph` at start of subgraph declaration', () => {
    const out = sm2('flowchart LR\n  subgraph foo [Title]\n  end');
    assert.match(out, /subgraph foo/);  // subgraph keyword preserved as declaration
  });

  it('does NOT rename `flowchart` at start of diagram', () => {
    const out = sm2('flowchart LR\n  a --> b');
    // sanitizeMermaid normalizes LR→TB for viewer parity, but `flowchart`
    // itself must be preserved (not renamed as a reserved keyword).
    assert.match(out, /^flowchart (LR|TB)/);
  });

  it('renames keyword on both sides of an arrow', () => {
    const out = sm2('flowchart LR\n  graph --> style');
    assert.match(out, /graph_n -->/);
    assert.match(out, /--> style_n/);
  });
});
