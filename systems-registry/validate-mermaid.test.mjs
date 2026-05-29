import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractMermaidBlocks,
  validateMermaidBlock,
  validateMermaidInBody,
  spliceMermaidFixes,
  validateAndRepairBody,
  parseRepairReply,
} from './validate-mermaid.mjs';

const GOOD_FLOW = '```mermaid\nflowchart LR\n  A --> B\n```';

function makeBody({ main = GOOD_FLOW, subflows = [] } = {}) {
  const out = ['---', 'name: example', '---', '', '## The loop', '', main, ''];
  for (const s of subflows) {
    out.push(`## Subflow: ${s.name}`, '');
    if (s.mermaid !== null) out.push(s.mermaid, '');
  }
  out.push('## Anchors', '', '- foo');
  return out.join('\n');
}

// ── extractMermaidBlocks ──────────────────────────────────────────────

test('extractMermaidBlocks: detects main + each subflow with positions', () => {
  const body = makeBody({
    subflows: [
      { name: 'one', mermaid: '```mermaid\nflowchart LR\n  X --> Y\n```' },
      { name: 'two', mermaid: '```mermaid\nflowchart LR\n  M --> N\n```' },
    ],
  });
  const out = extractMermaidBlocks(body);
  assert.equal(out.length, 3);
  assert.equal(out[0].kind, 'main');
  assert.equal(out[1].kind, 'subflow');
  assert.equal(out[1].name, 'one');
  assert.equal(out[2].name, 'two');
});

test('extractMermaidBlocks: flags subflow heading with NO mermaid block', () => {
  const body = makeBody({
    subflows: [
      { name: 'one', mermaid: null },
      { name: 'two', mermaid: '```mermaid\nflowchart LR\n  M --> N\n```' },
    ],
  });
  const out = extractMermaidBlocks(body);
  const empty = out.find(b => b.kind === 'subflow' && b.mermaid === null);
  assert.ok(empty, 'should report an empty subflow');
  assert.equal(empty.name, 'one');
});

test('extractMermaidBlocks: handles trailing subflow at EOF with no mermaid', () => {
  const body = [
    '---', 'name: x', '---',
    '## The loop', '',
    '```mermaid', 'flowchart LR', '  A --> B', '```',
    '## Subflow: orphan',
  ].join('\n');
  const out = extractMermaidBlocks(body);
  const orphan = out.find(b => b.name === 'orphan');
  assert.ok(orphan);
  assert.equal(orphan.mermaid, null);
});

// ── validateMermaidBlock ──────────────────────────────────────────────

test('validateMermaidBlock: clean block → []', () => {
  const blocks = extractMermaidBlocks(makeBody({ main: '```mermaid\nflowchart LR\n  A --> B\n```' }));
  assert.deepEqual(validateMermaidBlock(blocks[0]), []);
});

test('validateMermaidBlock: empty subflow → empty-subflow issue', () => {
  const body = makeBody({ subflows: [{ name: 'broken', mermaid: null }] });
  const block = extractMermaidBlocks(body).find(b => b.name === 'broken');
  const issues = validateMermaidBlock(block);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].kind, 'empty-subflow');
});

test('validateMermaidBlock: no edges → no-edges issue', () => {
  const blocks = extractMermaidBlocks(makeBody({ main: '```mermaid\nflowchart LR\n  A["a"]\n  B["b"]\n```' }));
  const issues = validateMermaidBlock(blocks[0]);
  assert.ok(issues.some(i => i.kind === 'no-edges'));
});

test('validateMermaidBlock: bad diagram type → bad-diagram-type', () => {
  const blocks = extractMermaidBlocks(makeBody({ main: '```mermaid\nnotADiagram\n  A --> B\n```' }));
  const issues = validateMermaidBlock(blocks[0]);
  assert.ok(issues.some(i => i.kind === 'bad-diagram-type'));
});

test('validateMermaidBlock: <br/> with unicode operators → flagged', () => {
  const blocks = extractMermaidBlocks(makeBody({
    main: '```mermaid\nflowchart LR\n  A["foo<br/>n ≥ 5<br/>∧ win"] --> B\n```',
  }));
  const issues = validateMermaidBlock(blocks[0]);
  assert.ok(issues.some(i => i.kind === 'br-with-unicode-operators'));
});

// ── splice ───────────────────────────────────────────────────────────

test('spliceMermaidFixes: REMOVE-HEADING drops the heading line for empty subflows', () => {
  const body = makeBody({
    subflows: [
      { name: 'kill-me', mermaid: null },
      { name: 'keep-me', mermaid: '```mermaid\nflowchart LR\n  X --> Y\n```' },
    ],
  });
  const blocks = extractMermaidBlocks(body);
  const empty = blocks.find(b => b.name === 'kill-me');
  const out = spliceMermaidFixes(body, [{ block: empty, replacement: 'REMOVE-HEADING' }]);
  assert.ok(!out.includes('## Subflow: kill-me'));
  assert.ok(out.includes('## Subflow: keep-me'));
});

test('spliceMermaidFixes: replaces a broken block with the fixed mermaid', () => {
  const body = makeBody({
    main: '```mermaid\nflowchart LR\n  A["x<br/>≥y"] --> B\n```',
  });
  const blocks = extractMermaidBlocks(body);
  const fixed = '```mermaid\nflowchart LR\n  A["x y"] --> B\n```';
  const out = spliceMermaidFixes(body, [{ block: blocks[0], replacement: fixed }]);
  assert.ok(out.includes('A["x y"]'));
  assert.ok(!out.includes('≥'));
});

// ── parseRepairReply ─────────────────────────────────────────────────

test('parseRepairReply: accepts a fenced block', () => {
  const block = { mermaid: 'bad' };
  const got = parseRepairReply('```mermaid\nflowchart LR\n  A --> B\n```', block);
  assert.equal(got, '```mermaid\nflowchart LR\n  A --> B\n```');
});

test('parseRepairReply: wraps bare valid mermaid in a fence', () => {
  const got = parseRepairReply('flowchart LR\n  A --> B', { mermaid: 'bad' });
  assert.ok(got.startsWith('```mermaid\n') && got.endsWith('\n```'));
});

test('parseRepairReply: REMOVE-HEADING only valid for empty subflows', () => {
  assert.equal(parseRepairReply('REMOVE-HEADING', { mermaid: null }), 'REMOVE-HEADING');
  assert.equal(parseRepairReply('REMOVE-HEADING', { mermaid: 'something' }), null);
});

// ── validateAndRepairBody ────────────────────────────────────────────

test('validateAndRepairBody: clean body → unchanged, log says clean', async () => {
  const body = makeBody();
  const { body: out, log } = await validateAndRepairBody(body);
  assert.equal(out, body);
  assert.equal(log[0].kind, 'clean');
});

test('validateAndRepairBody: runner-fixed broken block returns repaired body', async () => {
  const broken = makeBody({
    main: '```mermaid\nflowchart LR\n  A["a<br/>≥5"] --> B\n```',
  });
  const runner = async () => '```mermaid\nflowchart LR\n  A["a >=5"] --> B\n```';
  const { body: out, log } = await validateAndRepairBody(broken, { runner });
  assert.ok(out.includes('>=5'), 'expected the >=5 ASCII replacement');
  assert.ok(!out.includes('≥'), 'unicode ≥ should be gone');
  assert.ok(log.some(l => l.kind === 'applied'));
});

test('validateAndRepairBody: when runner is null, body is returned as-is with skipped log', async () => {
  const broken = makeBody({ subflows: [{ name: 'orphan', mermaid: null }] });
  const { body: out, log } = await validateAndRepairBody(broken);
  assert.equal(out, broken);
  assert.ok(log.some(l => l.kind === 'skipped'));
});

test('validateAndRepairBody: gives up after maxRounds and passes body through', async () => {
  const broken = makeBody({ subflows: [{ name: 'still-bad', mermaid: null }] });
  // Runner that returns junk that won't parse — never produces a fix.
  const runner = async () => 'not mermaid at all';
  const { body: out, log } = await validateAndRepairBody(broken, { runner, maxRounds: 2 });
  assert.equal(out, broken); // unchanged
  // First round found issues, no fixes applied → log records it.
  assert.ok(log.some(l => l.kind === 'no-fixes-applied'));
});
