import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { injectionPlan } from './inject.mjs';

function makeSystem(name, globs, body = '## loop\n```mermaid\nflowchart LR\n a-->b\n```\n') {
  return {
    name,
    summary: `summary of ${name}`,
    globs,
    _body: body,
    _relPath: `docs/systems/${name}.md`,
    inject: { mermaid: true, page_link: true, cap_bytes: 4096 },
  };
}

describe('injectionPlan', () => {
  const repoRoot = '/repo';
  const systems = [
    makeSystem('docgen', ['tools/docgen/**', '.claude/settings.json']),
    makeSystem('orchestrator', ['services/api/**']),
    makeSystem('app-map', ['tests/app-map/**']),
  ];

  it('emits the matching system on a Read of an anchor file', () => {
    const payload = { tool_name: 'Read', tool_input: { file_path: 'tools/docgen/docgen.mjs' }, session_id: 's1' };
    const { lines } = injectionPlan({ payload, repoRoot, systems, dedupe: { systems: [] } });
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes('systems-registry: docgen'));
  });

  it('does not emit for unrelated paths', () => {
    const payload = { tool_name: 'Read', tool_input: { file_path: 'docs/README.md' }, session_id: 's1' };
    const { lines } = injectionPlan({ payload, repoRoot, systems, dedupe: { systems: [] } });
    assert.deepEqual(lines, []);
  });

  it('does not re-emit a system already in the session dedupe', () => {
    const payload = { tool_name: 'Read', tool_input: { file_path: 'tools/docgen/docgen.mjs' }, session_id: 's1' };
    const { lines, newDedupe } = injectionPlan({
      payload,
      repoRoot,
      systems,
      dedupe: { systems: ['docgen'] },
    });
    assert.deepEqual(lines, []);
    assert.deepEqual(newDedupe.systems, ['docgen']);
  });

  it('emits multiple systems when path matches multiple globs', () => {
    const sys2 = [
      makeSystem('a', ['tools/foo/**']),
      makeSystem('b', ['tools/**']),
    ];
    const payload = { tool_name: 'Read', tool_input: { file_path: 'tools/foo/bar.mjs' }, session_id: 's1' };
    const { lines } = injectionPlan({ payload, repoRoot, systems: sys2, dedupe: { systems: [] } });
    assert.equal(lines.length, 2);
  });

  it('ignores Bash and other non-path tools', () => {
    const payload = { tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: 's1' };
    const { lines } = injectionPlan({ payload, repoRoot, systems, dedupe: { systems: [] } });
    assert.deepEqual(lines, []);
  });

  it('skips when target IS a system page (avoid re-entry)', () => {
    const payload = { tool_name: 'Read', tool_input: { file_path: 'docs/systems/docgen.md' }, session_id: 's1' };
    const { lines } = injectionPlan({ payload, repoRoot, systems, dedupe: { systems: [] } });
    assert.deepEqual(lines, []);
  });

  it('updates dedupe with newly emitted system', () => {
    const payload = { tool_name: 'Edit', tool_input: { file_path: 'services/api/index.ts' }, session_id: 's1' };
    const { newDedupe } = injectionPlan({ payload, repoRoot, systems, dedupe: { systems: [] } });
    assert.deepEqual(newDedupe.systems, ['orchestrator']);
  });

  it('returns reason="injected" when a system was emitted', () => {
    const payload = { tool_name: 'Read', tool_input: { file_path: 'tools/docgen/docgen.mjs' }, session_id: 's1' };
    const { reason } = injectionPlan({ payload, repoRoot, systems, dedupe: { systems: [] } });
    assert.equal(reason, 'injected');
  });

  it('returns reason="deduped" when matched but already in dedupe set', () => {
    const payload = { tool_name: 'Read', tool_input: { file_path: 'tools/docgen/docgen.mjs' }, session_id: 's1' };
    const { reason } = injectionPlan({ payload, repoRoot, systems, dedupe: { systems: ['docgen'] } });
    assert.equal(reason, 'deduped');
  });

  it('returns reason="out-of-repo" for absolute paths outside repoRoot', () => {
    const payload = { tool_name: 'Read', tool_input: { file_path: '/Users/me/.claude/memory/foo.md' }, session_id: 's1' };
    const { reason } = injectionPlan({ payload, repoRoot, systems, dedupe: { systems: [] } });
    assert.equal(reason, 'out-of-repo');
  });

  it('returns reason="no-match" when path is in-repo but no globs hit', () => {
    const payload = { tool_name: 'Read', tool_input: { file_path: 'docs/README.md' }, session_id: 's1' };
    const { reason } = injectionPlan({ payload, repoRoot, systems, dedupe: { systems: [] } });
    assert.equal(reason, 'no-match');
  });

  it('returns reason="system-page" when target IS a system manifest', () => {
    const payload = { tool_name: 'Read', tool_input: { file_path: 'docs/systems/docgen.md' }, session_id: 's1' };
    const { reason } = injectionPlan({ payload, repoRoot, systems, dedupe: { systems: [] } });
    assert.equal(reason, 'system-page');
  });

  it('returns reason="tool-no-paths" for Bash and other non-file tools', () => {
    const payload = { tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: 's1' };
    const { reason } = injectionPlan({ payload, repoRoot, systems, dedupe: { systems: [] } });
    assert.equal(reason, 'tool-no-paths');
  });
});
