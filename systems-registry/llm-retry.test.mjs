import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry } from './llm-retry.mjs';

describe('withRetry', () => {
  it('returns on first success without retrying', async () => {
    let calls = 0;
    const r = await withRetry(async () => { calls++; return 'ok'; }, { retries: 2, baseDelayMs: 1 });
    assert.equal(r, 'ok'); assert.equal(calls, 1);
  });
  it('retries transient failures then succeeds', async () => {
    let calls = 0;
    const r = await withRetry(async () => { calls++; if (calls < 3) throw new Error('flake'); return 'ok'; },
      { retries: 3, baseDelayMs: 1 });
    assert.equal(r, 'ok'); assert.equal(calls, 3);
  });
  it('throws the last error after exhausting retries', async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(async () => { calls++; throw new Error(`boom${calls}`); }, { retries: 2, baseDelayMs: 1 }),
      /boom3/);
    assert.equal(calls, 3);   // initial + 2 retries
  });
});
