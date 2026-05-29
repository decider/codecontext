/**
 * Hermetic tests for the four reality-signal collectors added to pass1.mjs
 * (deployedServices / topLevelApps / dbTables / httpSurface) and for the
 * prompt-builder enrichments that consume them. Same fixture pattern as
 * other tests in this dir — mkdtempSync → write files → assert → rmSync.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { gatherInputs, buildPrompt, parseRenderYaml } from './pass1.mjs';

function fixture(setup) {
  const root = mkdtempSync(join(tmpdir(), 'sr-reality-'));
  setup(root);
  return root;
}
const cleanup = root => { try { rmSync(root, { recursive: true, force: true }); } catch { /* */ } };

describe('parseRenderYaml', () => {
  it('extracts services that start with `- type: <kind>`', () => {
    const yaml = `services:
  - type: web
    name: api
  - type: cron
    name: nightly
    schedule: "0 0 * * *"
`;
    const out = parseRenderYaml(yaml);
    assert.equal(out.length, 2);
    assert.equal(out[0].name, 'api');
    assert.equal(out[0].type, 'web');
    assert.equal(out[1].schedule, '0 0 * * *');
  });

  it('ignores non-service entries (envVarGroups, env vars, header blocks)', () => {
    const yaml = `services:
  - type: web
    name: front
    headers:
      - path: /*
        name: X-Frame-Options
        value: DENY
    envVars:
      - key: NODE_VERSION
        value: 20
envVarGroups:
  - name: shared-env
    envVars:
      - key: FOO
        value: bar
`;
    const out = parseRenderYaml(yaml);
    assert.equal(out.length, 1);
    assert.equal(out[0].name, 'front');
    // No phantom services from nested name:/key: pairs.
    assert.ok(!out.some(s => s.name === 'shared-env'));
    assert.ok(!out.some(s => s.name === 'X-Frame-Options'));
  });

  it('returns [] for an empty or non-services file', () => {
    assert.deepEqual(parseRenderYaml('# just a comment\nfoo: bar\n'), []);
  });
});

describe('gatherInputs reality signals', () => {
  it('surfaces single-file apps the detector would never score (apps/<x>/index.ts only)', () => {
    const root = fixture(r => {
      mkdirSync(join(r, 'apps/tiny-cron'), { recursive: true });
      writeFileSync(join(r, 'apps/tiny-cron/index.ts'), 'console.log("hi");');
      writeFileSync(join(r, 'apps/tiny-cron/README.md'), '# tiny-cron\n\nA cron that does one thing.\n');
    });
    try {
      const inputs = gatherInputs(root);
      const found = inputs.topLevelApps.find(a => a.dir === 'apps/tiny-cron');
      assert.ok(found, 'topLevelApps should include single-file apps');
      assert.match(found.desc, /cron that does one thing/);
    } finally { cleanup(root); }
  });

  it('extracts deployed services from render.yaml across nested manifests', () => {
    const root = fixture(r => {
      mkdirSync(join(r, 'apps/server'), { recursive: true });
      writeFileSync(join(r, 'render.yaml'), `services:
  - type: cron
    name: nightly-job
    schedule: "0 4 * * *"
`);
      writeFileSync(join(r, 'apps/server/render.yaml'), `services:
  - type: web
    name: longlived-server
`);
    });
    try {
      const inputs = gatherInputs(root);
      const names = inputs.deployedServices.map(s => s.name).sort();
      assert.deepEqual(names, ['longlived-server', 'nightly-job']);
      assert.equal(inputs.deployedServices.find(s => s.name === 'nightly-job').schedule, '0 4 * * *');
    } finally { cleanup(root); }
  });

  it('handles fly.toml manifests too (platform-agnostic deployment discovery)', () => {
    const root = fixture(r => {
      writeFileSync(join(r, 'fly.toml'), `app = "my-fly-app"\n[http_service]\ninternal_port = 8080\n`);
    });
    try {
      const inputs = gatherInputs(root);
      const fly = inputs.deployedServices.find(s => s.platform === 'fly');
      assert.ok(fly, 'fly.toml should be parsed');
      assert.equal(fly.name, 'my-fly-app');
    } finally { cleanup(root); }
  });

  it('extracts DB tables from SQL migrations (the data spine of cross-cutting systems)', () => {
    const root = fixture(r => {
      mkdirSync(join(r, 'apps/api/migrations'), { recursive: true });
      writeFileSync(join(r, 'apps/api/migrations/001_init.sql'),
        'CREATE TABLE IF NOT EXISTS users (id int);\nCREATE TABLE sessions (data text);\n');
      writeFileSync(join(r, 'apps/api/migrations/002_more.sql'),
        'CREATE TABLE "events" (kind text);\n-- noise\nCREATE INDEX foo ON users(id);\n');
    });
    try {
      const inputs = gatherInputs(root);
      assert.ok(inputs.dbTables.includes('users'));
      assert.ok(inputs.dbTables.includes('sessions'));
      assert.ok(inputs.dbTables.includes('events'));
    } finally { cleanup(root); }
  });

  it('discovers HTTP surface from routes/ and handlers/ dirs, dropping noise', () => {
    const root = fixture(r => {
      mkdirSync(join(r, 'apps/api/src/routes'), { recursive: true });
      writeFileSync(join(r, 'apps/api/src/routes/userRoutes.ts'), '// ...');
      writeFileSync(join(r, 'apps/api/src/routes/billing.ts'), '// ...');  // no naming-suggestive, kept since immediate parent is `routes`
      writeFileSync(join(r, 'apps/api/src/routes/jest.config.ts'), '// ...'); // noise, skipped
      writeFileSync(join(r, 'apps/api/src/routes/userRoutes.test.ts'), '// ...'); // tests skipped
      mkdirSync(join(r, 'apps/api/src/handlers'), { recursive: true });
      writeFileSync(join(r, 'apps/api/src/handlers/authHandler.ts'), '// ...');
      mkdirSync(join(r, 'apps/api/src/services'), { recursive: true });
      writeFileSync(join(r, 'apps/api/src/services/userService.ts'), '// not a route');
    });
    try {
      const inputs = gatherInputs(root);
      assert.ok(inputs.httpSurface.includes('userRoutes'));
      assert.ok(inputs.httpSurface.includes('billing'));
      assert.ok(inputs.httpSurface.includes('authHandler'));
      assert.ok(!inputs.httpSurface.includes('jest.config'));
      assert.ok(!inputs.httpSurface.includes('userRoutes.test'));
      assert.ok(!inputs.httpSurface.includes('userService'));
    } finally { cleanup(root); }
  });
});

describe('buildPrompt with reality signals', () => {
  it('emits all four reality sections + the coverage-check directive when signals are present', () => {
    const inputs = {
      candidates: [],
      docgenSummaries: [],
      coordinatorSnippets: [],
      importGraph: [],
      gitLogs: [],
      deployedServices: [{ name: 'svc-x', type: 'cron', schedule: '* * * * *', file: 'render.yaml', platform: 'render' }],
      topLevelApps: [{ dir: 'apps/x', desc: 'tiny thing' }],
      dbTables: ['users', 'events'],
      httpSurface: ['userRoutes', 'authHandler'],
      priorHypothesis: null,
      priorSystems: [],
    };
    const p = buildPrompt(inputs);
    assert.match(p, /## Deployed services/);
    assert.match(p, /svc-x/);
    assert.match(p, /## Top-level inventory/);
    assert.match(p, /apps\/x.*tiny thing/);
    assert.match(p, /## DB tables/);
    assert.match(p, /users, events/);
    assert.match(p, /## HTTP routes \/ handlers/);
    assert.match(p, /userRoutes, authHandler/);
    assert.match(p, /Coverage check/);
  });

  it('omits a reality section when the signal is empty (no clutter)', () => {
    const inputs = {
      candidates: [], docgenSummaries: [], coordinatorSnippets: [], importGraph: [], gitLogs: [],
      deployedServices: [], topLevelApps: [], dbTables: [], httpSurface: [],
      priorHypothesis: null, priorSystems: [],
    };
    const p = buildPrompt(inputs);
    assert.ok(!p.includes('## Deployed services'));
    assert.ok(!p.includes('## Top-level inventory'));
    assert.ok(!p.includes('## DB tables'));
    assert.ok(!p.includes('## HTTP routes / handlers'));
    // But the task spec + coverage check still appear — they're the
    // load-bearing instruction, not gated on signals.
    assert.match(p, /Coverage check/);
  });
});

describe('per-repo context injection (docs/systems/_context.md)', () => {
  it('absent file → gatherInputs.repoContext is null, no prompt section', () => {
    const root = fixture(() => { /* no _context.md */ });
    try {
      const inputs = gatherInputs(root);
      assert.equal(inputs.repoContext, null);
      const p = buildPrompt(inputs);
      assert.ok(!p.includes('## Repo-specific context'),
        'should not emit the section when no context file is present');
    } finally { cleanup(root); }
  });

  it('present file → injected into the prompt with a high-priority framing', () => {
    const root = fixture(r => {
      mkdirSync(join(r, 'docs/systems'), { recursive: true });
      writeFileSync(join(r, 'docs/systems/_context.md'),
        '# Domain notes\n\n- Treat `legacy/` as out of scope.\n- The word "engine" means our matching engine, not a generic engine.\n');
    });
    try {
      const inputs = gatherInputs(root);
      assert.match(inputs.repoContext, /Domain notes/);
      const p = buildPrompt(inputs);
      assert.match(p, /## Repo-specific context/);
      assert.match(p, /TRUST THIS over inferences/);
      assert.match(p, /Treat `legacy\/` as out of scope/);
      assert.match(p, /matching engine, not a generic engine/);
      // Must appear BEFORE the candidate list so it primes the LLM's framing.
      assert.ok(p.indexOf('## Repo-specific context') < p.indexOf('## Heuristic candidates'),
        'context section must come before the candidate dump');
    } finally { cleanup(root); }
  });

  it('huge file is capped to bound prompt growth', () => {
    const root = fixture(r => {
      mkdirSync(join(r, 'docs/systems'), { recursive: true });
      writeFileSync(join(r, 'docs/systems/_context.md'), 'x'.repeat(100 * 1024));
    });
    try {
      const inputs = gatherInputs(root);
      assert.ok(inputs.repoContext.length <= 16 * 1024,
        'context should be capped at 16 KB');
    } finally { cleanup(root); }
  });
});
