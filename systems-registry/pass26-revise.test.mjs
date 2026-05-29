import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { reviseSystem, buildRevisePrompt } from './pass26-revise.mjs';

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'sr-revise-'));
  mkdirSync(join(root, 'apps/foo'), { recursive: true });
  writeFileSync(join(root, 'apps/foo/run.mjs'), "export const runFoo = () => {};\n");
  writeFileSync(join(root, 'apps/foo/capture.mjs'), "export const capture = () => ({});\n");
  mkdirSync(join(root, 'docs/systems'), { recursive: true });
  return root;
}

const VALID_BODY = `---
name: apps-foo
summary: tick loop
globs:
  - apps/foo/**
status: active
---

# apps-foo

## What it does

The runFoo() coordinator runs a loop.

## The loop

\`\`\`mermaid
flowchart LR
  a[start] --> b[work]
  b --> c[end]
  c --> a
\`\`\`

## Anchors

- \`apps/foo/run.mjs\` — coordinator
- \`apps/foo/capture.mjs\` — snapshot

## Closing arrow

Loop iterates forever.

## Invariants

- runs forever

## Failure modes

- crashes on disk full

## Where to start reading

1. apps/foo/run.mjs
`;

describe('buildRevisePrompt', () => {
  it('threads vet issues into Pass 2\'s HIGH-PRIORITY pre-task block (not a postscript)', () => {
    const p = buildRevisePrompt({
      hypothesisEntry: { name: 'x', globs: ['x/**'] },
      anchors: [{ path: 'x/y.mjs', content: 'code' }],
      priorBody: 'old body',
      vetIssues: [{ kind: 'hallucinated-symbol', detail: 'fakeFn' }],
    });
    // Feedback lives in Pass 2's HIGH-PRIORITY pre-task framing now,
    // not in a postscript that the model deprioritizes.
    assert.match(p, /Reviewer feedback on the PRIOR draft.*highest priority/);
    assert.match(p, /hallucinated-symbol/);
    assert.match(p, /fakeFn/);
    // Order check: feedback must appear BEFORE "## Your task" in prompt order.
    const fbIdx = p.indexOf('Reviewer feedback on the PRIOR draft');
    const taskIdx = p.indexOf('## Your task');
    assert.ok(fbIdx > -1 && taskIdx > -1);
    assert.ok(fbIdx < taskIdx, `feedback (${fbIdx}) must precede task (${taskIdx})`);
  });
});

describe('reviseSystem with mocked runner', () => {
  it('succeeds when first revision passes vet', async () => {
    const root = makeFixture();
    try {
      const manifestPath = join(root, 'docs/systems/apps-foo.md');
      // Initial state: a manifest with an obvious cheap-check failure
      const broken = VALID_BODY.replace('apps/foo/run.mjs', 'apps/foo/MISSING.mjs');
      writeFileSync(manifestPath, broken);

      const runner = async () => VALID_BODY;  // mock LLM emits a fixed valid body
      const r = await reviseSystem(root,
        { name: 'apps-foo', globs: ['apps/foo/**'] },
        { status: 'issues', problems: [{ kind: 'mentioned-path-not-on-disk', detail: 'apps/foo/MISSING.mjs' }] },
        { runner });

      assert.equal(r.finalStatus, 'ok');
      assert.equal(r.attempts.length, 1);
      // File now contains the revised valid body
      assert.match(readFileSync(manifestPath, 'utf8'), /apps\/foo\/run\.mjs/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('marks status: needs-review when retries exhausted', async () => {
    const root = makeFixture();
    try {
      const manifestPath = join(root, 'docs/systems/apps-foo.md');
      const broken = VALID_BODY.replace('apps/foo/run.mjs', 'apps/foo/MISSING.mjs');
      writeFileSync(manifestPath, broken);

      // Runner ALWAYS returns the same broken body — vet never passes
      const runner = async () => broken;
      const r = await reviseSystem(root,
        { name: 'apps-foo', globs: ['apps/foo/**'] },
        { status: 'issues', problems: [{ kind: 'mentioned-path-not-on-disk', detail: 'apps/foo/MISSING.mjs' }] },
        { runner, maxRetries: 2 });

      assert.equal(r.finalStatus, 'issues');
      assert.equal(r.attempts.length, 2);
      // Front-matter status must have flipped to needs-review
      assert.match(readFileSync(manifestPath, 'utf8'), /status:\s*needs-review/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('preserves what was right (revise only flagged content)', async () => {
    const root = makeFixture();
    try {
      const manifestPath = join(root, 'docs/systems/apps-foo.md');
      writeFileSync(manifestPath, VALID_BODY);
      const goodReport = { status: 'ok', problems: [] };
      const runner = async () => 'NEVER CALLED';
      const r = await reviseSystem(root,
        { name: 'apps-foo', globs: ['apps/foo/**'] },
        goodReport,
        { runner });
      assert.equal(r.finalStatus, 'ok');
      assert.equal(r.attempts.length, 0);  // nothing to revise
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
