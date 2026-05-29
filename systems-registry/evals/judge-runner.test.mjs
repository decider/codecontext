/**
 * Smoke tests for the LLM-as-judge harness. Doesn't make real API calls —
 * just verifies prompt assembly + fixture loading work.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { loadJudgePrompt, loadFixture, buildJudgePromptPayload } from './judge-runner.mjs';

describe('judge-runner scaffolding', () => {
  it('loads pass1 judge prompt', () => {
    const p = loadJudgePrompt('1');
    assert.match(p, /Pass 1 hypothesis/);
  });

  it('loads pass2 judge prompt', () => {
    const p = loadJudgePrompt('2');
    assert.match(p, /Pass 2 system body/);
  });

  it('loads pass2.5 judge prompt', () => {
    const p = loadJudgePrompt('2.5');
    assert.match(p, /Pass 2\.5 vet/);
  });

  it('throws on unknown pass id', () => {
    assert.throws(() => loadJudgePrompt('99'), /unknown pass/);
  });

  it('loads tiny-clean fixture', () => {
    const f = loadFixture('tiny-clean');
    assert.ok(f.expected);
    assert.ok(Array.isArray(f.expected.expectedSystems));
    assert.equal(f.expected.expectedSystems.length, 2);
  });

  it('throws on unknown fixture', () => {
    assert.throws(() => loadFixture('does-not-exist'), /fixture not found/);
  });

  it('builds judge prompt payload with all expected sections', () => {
    const payload = buildJudgePromptPayload({
      passId: '1',
      fixture: 'tiny-clean',
      actualOutput: 'some hypothesis output here',
    });
    assert.match(payload, /Pass 1 hypothesis/);
    assert.match(payload, /Repository description/);
    assert.match(payload, /Ideal output/);
    assert.match(payload, /Actual output/);
    assert.match(payload, /some hypothesis output here/);
  });
});
