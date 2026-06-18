import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cheapVet, vetSystem, checkSubflowRegression, _internal } from './pass25-vet.mjs';

const SUB = (name) => `## Subflow: ${name}\n\n\`\`\`mermaid\nflowchart LR\n  A --> B\n\`\`\`\n`;
const DOC = (...names) => `---\nname: x\n---\n\n# x\n\n## The loop\n\n\`\`\`mermaid\nflowchart LR\n  A --> B\n\`\`\`\n\n${names.map(SUB).join('\n')}`;

describe('checkSubflowRegression', () => {
  it('flags a regen that drops a mermaid subflow the prior had', () => {
    const probs = checkSubflowRegression(DOC('alpha', 'beta'), DOC('alpha'));
    assert.equal(probs.length, 1);
    assert.equal(probs[0].kind, 'subflow-regression');
    assert.match(probs[0].detail, /beta/);
  });

  it('passes when all prior subflows are preserved (order/extra additions OK)', () => {
    assert.deepEqual(checkSubflowRegression(DOC('alpha', 'beta'), DOC('beta', 'alpha', 'gamma')), []);
  });

  it('is case-insensitive on subflow names', () => {
    assert.deepEqual(checkSubflowRegression(DOC('Agentic-Decode'), DOC('agentic-decode')), []);
  });

  it('ignores subflows that lacked a mermaid diagram (no richness to protect)', () => {
    const priorStub = `## Subflow: stub\n\nno diagram here\n`;
    assert.deepEqual(checkSubflowRegression(priorStub, DOC('alpha')), []);
  });

  it('returns [] when there is no prior or no current body', () => {
    assert.deepEqual(checkSubflowRegression('', DOC('alpha')), []);
    assert.deepEqual(checkSubflowRegression(DOC('alpha'), ''), []);
  });
});

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'sr-vet-'));
  mkdirSync(join(root, 'apps/foo'), { recursive: true });
  writeFileSync(join(root, 'apps/foo/run.mjs'), "export const runFoo = () => {};\n");
  writeFileSync(join(root, 'apps/foo/capture.mjs'), "export const capture = () => ({});\n");
  mkdirSync(join(root, 'docs/systems'), { recursive: true });
  return root;
}

function writeManifest(root, name, body) {
  const p = join(root, 'docs/systems', `${name}.md`);
  writeFileSync(p, body);
  return p;
}

const GOOD_BODY = `---
name: apps-foo
summary: A tick-loop runner.
globs:
  - apps/foo/**
status: active
---

# apps-foo

## What it does

The runFoo() coordinator orchestrates capture and score in a loop.

## The loop

\`\`\`mermaid
flowchart LR
  a[start] --> b[capture]
  b --> c[score]
  c --> a
\`\`\`

## Anchors

- \`apps/foo/run.mjs\` — coordinator
- \`apps/foo/capture.mjs\` — snapshot

## Closing arrow

State writes to disk each tick.

## Invariants

- run.mjs imports capture
- Loop is unbounded

## Failure modes

- Disk full crashes the loop

## Where to start reading

1. apps/foo/run.mjs
`;

describe('cheap deterministic checks', () => {
  it('passes a valid manifest', () => {
    const root = makeFixture();
    try {
      const p = writeManifest(root, 'apps-foo', GOOD_BODY);
      const r = cheapVet(root, p);
      assert.deepEqual(r.problems, []);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('flags missing front-matter', () => {
    const root = makeFixture();
    try {
      const p = writeManifest(root, 'apps-foo', '# no front matter\nbody');
      const r = cheapVet(root, p);
      assert.ok(r.problems.some(x => x.kind === 'no-front-matter'));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('flags glob that matches no files', () => {
    const root = makeFixture();
    const broken = GOOD_BODY.replace('apps/foo/**', 'nonexistent/dir/**');
    try {
      const p = writeManifest(root, 'apps-foo', broken);
      const r = cheapVet(root, p);
      assert.ok(r.problems.some(x => x.kind === 'glob-no-matches'));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('flags backticked-path that does not exist on disk', () => {
    const root = makeFixture();
    const broken = GOOD_BODY.replace('apps/foo/run.mjs`', 'apps/foo/HALLUCINATED.mjs`');
    try {
      const p = writeManifest(root, 'apps-foo', broken);
      const r = cheapVet(root, p);
      assert.ok(r.problems.some(x => x.kind === 'mentioned-path-not-on-disk' && /HALLUCINATED/.test(x.detail)));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('flags missing required sections', () => {
    const root = makeFixture();
    const broken = GOOD_BODY.replace('## Invariants\n\n- run.mjs imports capture\n- Loop is unbounded\n\n', '');
    try {
      const p = writeManifest(root, 'apps-foo', broken);
      const r = cheapVet(root, p);
      assert.ok(r.problems.some(x => x.kind === 'missing-section' && x.detail === 'Invariants'));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('flags mermaid block missing edges (generic stub)', () => {
    const root = makeFixture();
    const broken = GOOD_BODY.replace(/```mermaid[\s\S]*?```/, '```mermaid\nflowchart LR\n  TODO\n```');
    try {
      const p = writeManifest(root, 'apps-foo', broken);
      const r = cheapVet(root, p);
      assert.ok(r.problems.some(x => x.kind === 'mermaid-issue'));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('flags missing mermaid block entirely', () => {
    const root = makeFixture();
    const broken = GOOD_BODY.replace(/```mermaid[\s\S]*?```/, '(no diagram)');
    try {
      const p = writeManifest(root, 'apps-foo', broken);
      const r = cheapVet(root, p);
      assert.ok(r.problems.some(x => x.kind === 'mermaid-issue' && /no mermaid/.test(x.detail)));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('does NOT flag a complete small manifest as a merging-candidate', () => {
    const root = makeFixture();
    try {
      const p = writeManifest(root, 'apps-foo', GOOD_BODY);
      const r = cheapVet(root, p);
      assert.ok(!r.problems.some(x => x.kind === 'merging-candidate'),
        'complete small manifest (2 anchors, 3-node loop) must not trip merge guard');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('flags a thin manifest as a merging-candidate via cheapVet', () => {
    const root = makeFixture();
    // No anchors and no real mermaid loop -> two signals fire together.
    const thin = `---
name: apps-foo
summary: A thin stub.
globs:
  - apps/foo/**
status: active
---

# apps-foo

## What it does

A thing.

## The loop

(no diagram)

## Anchors

(none yet)

## Closing arrow

x

## Invariants

- y

## Failure modes

- z

## Where to start reading

1. somewhere
`;
    try {
      const p = writeManifest(root, 'apps-foo', thin);
      const r = cheapVet(root, p);
      assert.ok(r.problems.some(x => x.kind === 'merging-candidate'));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('checkMergingCandidate (unit)', () => {
  const { checkMergingCandidate } = _internal;

  it('returns a problem when two signals fire (0 anchors + 0 loop nodes)', () => {
    const body = '## The loop\n\n(no diagram)\n\n## Anchors\n\n(none)\n';
    const r = checkMergingCandidate(body);
    assert.equal(r.length, 1);
    assert.equal(r[0].kind, 'merging-candidate');
    assert.match(r[0].detail, /thin manifest \(0 anchors, 0 mermaid nodes, \d+ bytes\)/);
  });

  it('does NOT fire on a single signal alone (tiny body, but full anchors + loop)', () => {
    // 3 anchors + a 3-node loop -> only the byte signal could fire -> < 2 -> clean.
    const body = `## The loop

\`\`\`mermaid
flowchart LR
  a[x] --> b[y]
  b --> c[z]
  c --> a
\`\`\`

## Anchors

- \`a/one.mjs\` — one
- \`a/two.mjs\` — two
- \`a/three.mjs\` — three
`;
    assert.deepEqual(checkMergingCandidate(body), []);
  });

  it('fires when anchors are thin AND the loop diagram is too small', () => {
    const body = `## The loop

\`\`\`mermaid
flowchart LR
  a[only] --> a
\`\`\`

## Anchors

- \`a/one.mjs\` — one
`;
    const r = checkMergingCandidate(body);
    assert.equal(r.length, 1);
    assert.equal(r[0].kind, 'merging-candidate');
  });
});

describe('vetSystem with mocked LLM', () => {
  it('passes a perfect manifest with empty LLM findings', async () => {
    const root = makeFixture();
    try {
      const p = writeManifest(root, 'apps-foo', GOOD_BODY);
      const runner = async () => '{"hallucinatedSymbols":[],"invariantContradictions":[],"wrongClosingArrow":false,"rationale":"ok"}';
      const r = await vetSystem(root, p, { runner });
      assert.equal(r.status, 'ok');
      assert.deepEqual(r.problems, []);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('flags hallucinated symbols from LLM finding', async () => {
    const root = makeFixture();
    try {
      const p = writeManifest(root, 'apps-foo', GOOD_BODY);
      const runner = async () => '{"hallucinatedSymbols":["fakeFunction"],"invariantContradictions":[],"wrongClosingArrow":false}';
      const r = await vetSystem(root, p, { runner });
      assert.equal(r.status, 'issues');
      assert.ok(r.problems.some(x => x.kind === 'hallucinated-symbol' && x.detail === 'fakeFunction'));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('combines cheap + LLM findings', async () => {
    const root = makeFixture();
    const broken = GOOD_BODY.replace('apps/foo/run.mjs`', 'apps/foo/missing.mjs`');
    try {
      const p = writeManifest(root, 'apps-foo', broken);
      const runner = async () => '{"hallucinatedSymbols":["missingFn"],"wrongClosingArrow":false}';
      const r = await vetSystem(root, p, { runner });
      assert.equal(r.status, 'issues');
      assert.ok(r.problems.some(x => x.kind === 'mentioned-path-not-on-disk'));
      assert.ok(r.problems.some(x => x.kind === 'hallucinated-symbol'));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('llm: false skips the LLM call', async () => {
    const root = makeFixture();
    try {
      const p = writeManifest(root, 'apps-foo', GOOD_BODY);
      const runner = async () => { throw new Error('should not call LLM'); };
      const r = await vetSystem(root, p, { llm: false, runner });
      assert.equal(r.status, 'ok');
      assert.equal(r.llmFindings, null);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('vet skips npm scoped package specifiers', () => {
  it('does not flag @scope/pkg.js as a missing file', () => {
    const root = makeFixture();
    const body = GOOD_BODY.replace('## Closing arrow', '## Closing arrow\n\nUses `@acme/sdk` for RPC.\n');
    try {
      const p = writeManifest(root, 'apps-foo', body);
      const r = cheapVet(root, p);
      assert.ok(!r.problems.some(x => x.detail === '@acme/sdk'));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('empty kind: front-matter does not crash the vet', () => {
  // Regression: parseFrontMatter yields [] for an empty `kind:` line, and []
  // is truthy, so `(frontMatter.kind || '').toLowerCase()` threw a TypeError
  // and took down the whole refresh on any manifest with a blank kind.
  it('findMissingSections treats a non-string kind ([]) as unset', () => {
    assert.doesNotThrow(() => _internal.findMissingSections('# x', { kind: [] }));
    // unset kind => not in KINDS_WITHOUT_CLOSING_ARROW => Closing arrow required
    const missing = _internal.findMissingSections('# x', { kind: [] });
    assert.ok(missing.includes('Closing arrow'));
  });

  it('cheapVet survives a manifest whose kind: line is blank', () => {
    const root = makeFixture();
    const body = GOOD_BODY.replace('status: active', 'kind:\nstatus: active');
    try {
      const p = writeManifest(root, 'apps-foo', body);
      let r;
      assert.doesNotThrow(() => { r = cheapVet(root, p); });
      assert.deepEqual(r.problems, []);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
