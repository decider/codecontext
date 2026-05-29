import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  gatherOrganizeInputs,
  buildOrganizePrompt,
  reconcile,
  runOrganize,
  loadCategories,
  _internal,
} from './organize.mjs';

function makeFixture(systems) {
  const root = mkdtempSync(join(tmpdir(), 'sr-org-'));
  mkdirSync(join(root, 'docs/systems'), { recursive: true });
  for (const s of systems) {
    writeFileSync(join(root, 'docs/systems', s.name + '.md'),
      `---\nname: ${s.name}\nsummary: ${s.summary}\nglobs:\n  - x/**\nstatus: active\n---\n\n# ${s.name}\n\n## Closing arrow\n\n${s.closing || 'closes somehow'}\n`);
  }
  return root;
}

describe('summarizeManifest', () => {
  it('extracts name, summary, closing arrow', () => {
    const text = '---\nname: foo\nsummary: does foo\nglobs:\n  - x/**\n---\n\n# foo\n\n## Closing arrow\n\nwrites to disk each tick\n';
    const s = _internal.summarizeManifest(text);
    assert.equal(s.name, 'foo');
    assert.equal(s.summary, 'does foo');
    assert.match(s.closing, /writes to disk/);
  });
});

describe('gatherOrganizeInputs', () => {
  it('collects all non-README non-underscore manifests', () => {
    const root = makeFixture([
      { name: 'alpha', summary: 'first' },
      { name: 'beta', summary: 'second' },
    ]);
    try {
      const inputs = gatherOrganizeInputs(root);
      assert.equal(inputs.systems.length, 2);
      assert.equal(inputs.priorCategories, null);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('reads prior _categories.json for re-anchoring', () => {
    const root = makeFixture([{ name: 'alpha', summary: 'first' }]);
    writeFileSync(join(root, 'docs/systems/_categories.json'),
      JSON.stringify({ categories: [{ name: 'Core', systems: ['alpha'] }] }));
    try {
      const inputs = gatherOrganizeInputs(root);
      assert.ok(inputs.priorCategories);
      assert.equal(inputs.priorCategories.categories[0].name, 'Core');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('buildOrganizePrompt', () => {
  it('includes systems + prior categories when present', () => {
    const prompt = buildOrganizePrompt({
      systems: [{ name: 'alpha', summary: 'does alpha', closing: 'via disk' }],
      priorCategories: { categories: [{ name: 'Core', systems: ['alpha'] }] },
    });
    assert.match(prompt, /alpha: does alpha/);
    assert.match(prompt, /closes via: via disk/);
    assert.match(prompt, /Current categorization/);
    assert.match(prompt, /Reduce drift/);
  });

  it('omits prior-categorization section when none', () => {
    const prompt = buildOrganizePrompt({
      systems: [{ name: 'alpha', summary: 'x' }],
      priorCategories: null,
    });
    assert.doesNotMatch(prompt, /Current categorization/);
  });
});

describe('reconcile', () => {
  it('drops unknown systems + dedups', () => {
    const systems = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
    const parsed = { categories: [
      { name: 'X', systems: ['a', 'b', 'ghost'] },
      { name: 'Y', systems: ['b', 'c'] },  // b is dup, should only land in X
    ]};
    const r = reconcile(systems, parsed);
    assert.deepEqual(r.categories[0], { name: 'X', systems: ['a', 'b'] });
    assert.deepEqual(r.categories[1], { name: 'Y', systems: ['c'] });
  });

  it('puts dropped systems into Uncategorized so none are lost', () => {
    const systems = [{ name: 'a' }, { name: 'b' }];
    const parsed = { categories: [{ name: 'X', systems: ['a'] }] };
    const r = reconcile(systems, parsed);
    const uncat = r.categories.find(c => c.name === 'Uncategorized');
    assert.ok(uncat);
    assert.deepEqual(uncat.systems, ['b']);
  });
});

describe('runOrganize with mocked runner', () => {
  it('writes _categories.json with reconciled categories', async () => {
    const root = makeFixture([
      { name: 'request-pipeline', summary: 'runtime pipeline' },
      { name: 'parser', summary: 'research parser' },
    ]);
    try {
      const runner = async () => JSON.stringify({
        categories: [
          { name: 'Runtime', systems: ['request-pipeline'] },
          { name: 'Research', systems: ['parser'] },
        ],
      });
      const r = await runOrganize(root, { runner });
      assert.ok(existsSync(r.outPath));
      const written = JSON.parse(readFileSync(r.outPath, 'utf8'));
      assert.equal(written.categories.length, 2);
      assert.ok(written.generatedAt);
      // loadCategories round-trips
      const loaded = loadCategories(root);
      assert.equal(loaded.categories.length, 2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('reconciles a dropped system into Uncategorized', async () => {
    const root = makeFixture([
      { name: 'a', summary: 'x' },
      { name: 'b', summary: 'y' },
    ]);
    try {
      const runner = async () => JSON.stringify({ categories: [{ name: 'Core', systems: ['a'] }] });
      const r = await runOrganize(root, { runner });
      const uncat = r.categories.find(c => c.name === 'Uncategorized');
      assert.ok(uncat && uncat.systems.includes('b'));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
