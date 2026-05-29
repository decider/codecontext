#!/usr/bin/env node
/**
 * systems-registry — retry wrapper for flaky LLM CLI calls.
 *
 * A full sweep makes 30+ `claude -p` calls in a batch; in practice some
 * fail transiently (exit 1 with no stderr, timeouts, brief rate-limits).
 * Without a retry, ONE such failure in Pass 1 takes down the whole run
 * (Pass 1 is a single call → single point of failure). This wraps a
 * call-producing fn with bounded retries + linear backoff so transient
 * blips don't abort a long, expensive sweep.
 *
 * `fn` must be a factory returning a fresh Promise on each call (so each
 * attempt re-spawns). Throws the last error if all attempts fail.
 */
export async function withRetry(fn, { retries = 2, baseDelayMs = 8000, onRetry } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastErr = e;
      if (attempt === retries) break;
      const delay = baseDelayMs * (attempt + 1);   // 8s, 16s, …
      if (onRetry) onRetry(attempt + 1, e, delay);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
