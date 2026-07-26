import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadManifestGlobs, computeImpact, refreshIncremental } from './refresh.mjs';

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'sr-refresh-'));
  // Two systems with code + manifests
  mkdirSync(join(root, 'apps/foo'), { recursive: true });
  writeFileSync(join(root, 'apps/foo/run.mjs'),
    "import { capture } from './capture.mjs';\nimport { score } from './score.mjs';\n" +
    "import { writeFileSync } from 'node:fs';\nimport { spawn } from 'node:child_process';\n" +
    "while (true) { writeFileSync('s.json', '1'); spawn('echo', ['x']); }\n");
  writeFileSync(join(root, 'apps/foo/capture.mjs'), 'export const capture = () => {};\n');
  writeFileSync(join(root, 'apps/foo/score.mjs'), 'export const score = () => {};\n');
  mkdirSync(join(root, 'tools/bar'), { recursive: true });
  writeFileSync(join(root, 'tools/bar/cli.mjs'), 'export const x = 1;\n');

  mkdirSync(join(root, 'docs/systems'), { recursive: true });
  writeFileSync(join(root, 'docs/systems/foo-system.md'),
    '---\nname: foo-system\nsummary: the foo\nglobs:\n  - apps/foo/**\nstatus: active\n---\n\n# foo-system\n\nbody');
  writeFileSync(join(root, 'docs/systems/bar-system.md'),
    '---\nname: bar-system\nsummary: the bar\nglobs:\n  - tools/bar/**\nstatus: active\n---\n\n# bar-system\n\nbody');
  return root;
}

describe('loadManifestGlobs', () => {
  it('reads name + globs from each manifest front-matter', () => {
    const root = makeFixture();
    try {
      const m = loadManifestGlobs(root);
      assert.equal(m.length, 2);
      const foo = m.find(x => x.name === 'foo-system');
      assert.deepEqual(foo.globs, ['apps/foo/**']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('computeImpact', () => {
  it('flags only the system whose glob matches the changed file', () => {
    const root = makeFixture();
    try {
      const impact = computeImpact(root, ['apps/foo/score.mjs']);
      assert.equal(impact.impacted.length, 1);
      assert.equal(impact.impacted[0].name, 'foo-system');
      assert.equal(impact.skip, false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('skips when no glob matches the changed files', () => {
    const root = makeFixture();
    try {
      const impact = computeImpact(root, ['README.md', 'package.json']);
      assert.equal(impact.impacted.length, 0);
      assert.equal(impact.newCandidates.length, 0);
      assert.equal(impact.skip, true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('detects a brand-new candidate dir not covered by any manifest', () => {
    const root = makeFixture();
    // Add a new system dir with coordinator + loop + subprocess + state + tests
    mkdirSync(join(root, 'lab/newthing'), { recursive: true });
    writeFileSync(join(root, 'lab/newthing/run.mjs'),
      "import { a } from './a.mjs';\nimport { b } from './b.mjs';\n" +
      "import { writeFileSync } from 'node:fs';\nimport { spawn } from 'node:child_process';\n" +
      "while (true) { writeFileSync('state.json','1'); spawn('x',[]); }\n");
    writeFileSync(join(root, 'lab/newthing/a.mjs'), 'export const a = 1;\n');
    writeFileSync(join(root, 'lab/newthing/b.mjs'), 'export const b = 2;\n');
    writeFileSync(join(root, 'lab/newthing/run.test.mjs'), "import { test } from 'node:test';\ntest('a',()=>{});");
    writeFileSync(join(root, 'lab/newthing/a.test.mjs'), "import { test } from 'node:test';\ntest('b',()=>{});");
    writeFileSync(join(root, 'lab/newthing/b.test.mjs'), "import { test } from 'node:test';\ntest('c',()=>{});");
    writeFileSync(join(root, 'lab/newthing/README.md'), '# newthing\n\nhand-written readme');
    try {
      const impact = computeImpact(root, ['lab/newthing/run.mjs']);
      assert.ok(impact.newCandidates.length >= 1, 'should detect lab/newthing as new candidate');
      assert.ok(impact.newCandidates.some(c => c.dir === 'lab/newthing'));
      assert.equal(impact.skip, false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('refreshIncremental with mocked runner', () => {
  it('skips cleanly when nothing impacted', async () => {
    const root = makeFixture();
    try {
      const runner = async () => { throw new Error('LLM should NOT be called on skip'); };
      const r = await refreshIncremental(root, ['README.md'], { write: () => {}, runner });
      assert.equal(r.skipped, true);
      assert.deepEqual(r.regenerated, []);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('regenerates ONLY the impacted system, leaving the other untouched', async () => {
    const root = makeFixture();
    const barBefore = readFileSync(join(root, 'docs/systems/bar-system.md'), 'utf8');
    try {
      const runner = async (prompt) => {
        // Pass 2 body for the impacted system
        if (prompt.includes('writing a complete system manifest')) {
          return '---\nname: foo-system\nsummary: REGENERATED foo\nglobs:\n  - apps/foo/**\nstatus: active\n---\n\n# foo-system\n\n## What it does\nx\n\n## The loop\n```mermaid\nflowchart LR\n a-->b\n```\n\n## Anchors\n- `apps/foo/run.mjs` — x\n\n## Closing arrow\nstate\n\n## Invariants\n- x\n\n## Failure modes\n- y\n\n## Where to start reading\n1. apps/foo/run.mjs\n';
        }
        // organize call
        if (prompt.includes('organizing a repository')) {
          return '{"categories":[{"name":"Apps","systems":["foo-system","bar-system"]}]}';
        }
        return '{}';
      };
      const r = await refreshIncremental(root, ['apps/foo/score.mjs'], { write: () => {}, runner });
      assert.equal(r.skipped, false);
      assert.equal(r.regenerated.length, 1);
      assert.equal(r.regenerated[0].name, 'foo-system');
      // foo regenerated
      assert.match(readFileSync(join(root, 'docs/systems/foo-system.md'), 'utf8'), /REGENERATED foo/);
      // bar untouched
      assert.equal(readFileSync(join(root, 'docs/systems/bar-system.md'), 'utf8'), barBefore);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('refreshIncremental preserve-and-retry (additive subflow recovery)', () => {
  // foo-system manifest that ALREADY ships two mermaid subflows worth protecting.
  function fixtureWithFooSubflows() {
    const root = makeFixture();
    writeFileSync(join(root, 'docs/systems/foo-system.md'),
      '---\nname: foo-system\nsummary: the foo\nglobs:\n  - apps/foo/**\nstatus: active\n---\n\n' +
      '# foo-system\n\n## The loop\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n' +
      '## Subflow: alpha\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n' +
      '## Subflow: beta\n\n```mermaid\nflowchart LR\n  A --> B\n```\n');
    return root;
  }
  // A regenerated body carrying exactly the named subflows (plus required sections).
  const bodyWith = (subflows) =>
    '---\nname: foo-system\nsummary: REGEN foo\nglobs:\n  - apps/foo/**\nstatus: active\n---\n\n' +
    '# foo-system\n\n## What it does\nx\n\n## The loop\n```mermaid\nflowchart LR\n a-->b\n```\n\n' +
    subflows.map((n) => `## Subflow: ${n}\n\n\`\`\`mermaid\nflowchart LR\n  A --> B\n\`\`\`\n`).join('\n') +
    '\n## Anchors\n- `apps/foo/run.mjs` — x\n\n## Closing arrow\nstate\n\n## Invariants\n- x\n\n' +
    '## Failure modes\n- y\n\n## Where to start reading\n1. apps/foo/run.mjs\n';

  it('retries with must-keep feedback and recovers a dropped subflow', async () => {
    const root = fixtureWithFooSubflows();
    try {
      const runner = async (prompt) => {
        if (prompt.includes('writing a complete system manifest')) {
          // The retry prompt carries the must-keep feedback → restore beta.
          // The first (un-fed) pass drops it.
          return prompt.includes('DROPPED mermaid subflow')
            ? bodyWith(['alpha', 'beta'])
            : bodyWith(['alpha']);
        }
        if (prompt.includes('organizing a repository')) {
          return '{"categories":[{"name":"Apps","systems":["foo-system","bar-system"]}]}';
        }
        return '{}';
      };
      const r = await refreshIncremental(root, ['apps/foo/score.mjs'], { write: () => {}, runner });
      assert.equal(r.regenerated.length, 1);
      assert.equal(r.regenerated[0].status, 'active'); // recovered — NOT kept-prior
      const out = readFileSync(join(root, 'docs/systems/foo-system.md'), 'utf8');
      assert.match(out, /## Subflow: alpha/);
      assert.match(out, /## Subflow: beta/); // the retry brought beta back
      assert.match(out, /REGEN foo/); // it's the regenerated body, not the restored prior
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('keeps the prior doc when even the retry still drops a subflow', async () => {
    const root = fixtureWithFooSubflows();
    const priorFoo = readFileSync(join(root, 'docs/systems/foo-system.md'), 'utf8');
    try {
      const runner = async (prompt) => {
        // Always drops beta, feedback or not → guard must keep the prior.
        if (prompt.includes('writing a complete system manifest')) return bodyWith(['alpha']);
        if (prompt.includes('organizing a repository')) {
          return '{"categories":[{"name":"Apps","systems":["foo-system","bar-system"]}]}';
        }
        return '{}';
      };
      const r = await refreshIncremental(root, ['apps/foo/score.mjs'], { write: () => {}, runner });
      assert.equal(r.regenerated[0].status, 'kept-prior');
      // Prior restored verbatim — no regression shipped.
      assert.equal(readFileSync(join(root, 'docs/systems/foo-system.md'), 'utf8'), priorFoo);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('subflow must-keep is sent on the FIRST pass, not only the retry', () => {
  function fixtureWithSubflows() {
    const root = makeFixture();
    writeFileSync(join(root, 'docs/systems/foo-system.md'),
      '---\nname: foo-system\nsummary: the foo\nglobs:\n  - apps/foo/**\nstatus: active\n---\n\n' +
      '# foo-system\n\n## The loop\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n' +
      '## Subflow: alpha\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n' +
      '## Subflow: beta\n\n```mermaid\nflowchart LR\n  A --> B\n```\n');
    return root;
  }
  const bodyWith = (subflows) =>
    '---\nname: foo-system\nsummary: REGEN foo\nglobs:\n  - apps/foo/**\nstatus: active\n---\n\n' +
    '# foo-system\n\n## What it does\nx\n\n## The loop\n```mermaid\nflowchart LR\n a-->b\n```\n\n' +
    subflows.map((n) => `## Subflow: ${n}\n\n\`\`\`mermaid\nflowchart LR\n  A --> B\n\`\`\`\n`).join('\n') +
    '\n## Anchors\n- `apps/foo/run.mjs` — x\n\n## Closing arrow\nstate\n\n## Invariants\n- x\n\n' +
    '## Failure modes\n- y\n\n## Where to start reading\n1. apps/foo/run.mjs\n';

  it('names the prior subflows in the first generate prompt', async () => {
    // The retry is a FULL second Sonnet 5 generation — measured at $0.19-$0.76
    // per system, so a regression doubles that system's bill. Telling the model
    // up front which subflows it must keep prevents the regression instead of
    // paying to detect and redo it.
    const root = fixtureWithSubflows();
    const prompts = [];
    try {
      const runner = async (prompt) => {
        if (prompt.includes('writing a complete system manifest')) {
          prompts.push(prompt);
          return bodyWith(['alpha', 'beta']);
        }
        if (prompt.includes('organizing a repository')) {
          return '{"categories":[{"name":"Apps","systems":["foo-system"]}]}';
        }
        return '{}';
      };
      await refreshIncremental(root, ['apps/foo/score.mjs'], { write: () => {}, runner });
      assert.equal(prompts.length, 1, 'exactly ONE generation — no retry needed');
      // NOT just the names: the prior manifest is embedded in the prompt, so
      // matching /alpha/ passes even with no must-keep guidance at all. Assert
      // the INSTRUCTION, which only the must-keep feedback emits.
      assert.match(
        prompts[0],
        /must be kept|never drop/i,
        'first prompt must carry the must-keep instruction, not just mention subflows',
      );
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('still costs only one generation when the model complies', async () => {
    const root = fixtureWithSubflows();
    let generations = 0;
    try {
      const runner = async (prompt) => {
        if (prompt.includes('writing a complete system manifest')) {
          generations++;
          return bodyWith(['alpha', 'beta']);
        }
        if (prompt.includes('organizing a repository')) {
          return '{"categories":[{"name":"Apps","systems":["foo-system"]}]}';
        }
        return '{}';
      };
      await refreshIncremental(root, ['apps/foo/score.mjs'], { write: () => {}, runner });
      assert.equal(generations, 1, 'no second full-price generation');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
