/**
 * Layer 2 — Pass 0 fixture-based integration tests.
 *
 * For each fixture under evals/fixtures/, run the heuristic detector and
 * verify the candidate list matches .expected.json. Fast, deterministic.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath as ftp } from 'node:url';

import { detect } from '../detect.mjs';

const __dirname = dirname(ftp(import.meta.url));
const FIXTURE_DIR = resolve(__dirname, 'fixtures');

function listFixtures() {
  return readdirSync(FIXTURE_DIR)
    .filter(name => {
      try { return statSync(join(FIXTURE_DIR, name)).isDirectory(); }
      catch { return false; }
    });
}

describe('Pass 0 fixture integration tests', () => {
  for (const fixture of listFixtures()) {
    const path = join(FIXTURE_DIR, fixture);
    const expectedPath = join(path, '.expected.json');
    let expected;
    try {
      expected = JSON.parse(readFileSync(expectedPath, 'utf8'));
    } catch {
      continue;  // skip fixtures without .expected.json
    }

    it(`fixture: ${fixture} — Pass 0 matches expectation`, () => {
      const candidates = detect(path);
      const candidateNames = new Set(candidates.map(c => c.name));

      // Each expectedSystem must appear with at least the listed signals
      for (const exp of expected.expectedSystems || []) {
        const found = candidates.find(c => c.name === exp.name);
        assert.ok(found,
          `Fixture ${fixture}: expected system "${exp.name}" not found.\n` +
          `  Got: ${[...candidateNames].join(', ') || '(none)'}\n` +
          `  Notes: ${expected.description}`);
        if (exp.minSignals) {
          for (const sig of exp.minSignals) {
            assert.ok(found.signals.includes(sig),
              `Fixture ${fixture}, system "${exp.name}": missing signal "${sig}".\n` +
              `  Got signals: ${found.signals.join(', ')}`);
          }
        }
      }

      // unexpectedSystems must NOT appear
      for (const exp of expected.unexpectedSystems || []) {
        assert.ok(!candidateNames.has(exp.name),
          `Fixture ${fixture}: unexpected system "${exp.name}" was detected.`);
      }
    });
  }
});
