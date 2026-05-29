#!/usr/bin/env node
// systems-registry — Pass 2.5: vet.
// Validates a Pass 2 manifest body against reality. Two phases:
//
// (1) Cheap deterministic checks (no LLM):
//     - Front-matter parses
//     - Every glob pattern matches >=1 real file
//     - Every backticked file path mentioned in the body exists on disk
//     - Markdown sections present
//     - Mermaid block present + minimally syntactically valid
//
// (2) LLM check (one call per system):
//     - Hallucinated symbols, invariant contradictions, wrong closing arrow

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

import { parseFrontMatter, globToRegex } from './registry.mjs';

const REQUIRED_SECTIONS = [
  'What it does', 'The loop', 'Anchors',
  'Invariants', 'Failure modes', 'Where to start reading',
];

// One-shot kinds that legitimately do NOT loop — they don't need a
// `## Closing arrow` section. A `kind: installer` or `kind: gate` system
// passes vet without one; everything else still requires it.
const KINDS_WITHOUT_CLOSING_ARROW = new Set(['installer', 'gate']);

function walkAllFiles(dir, repoRoot, out) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (['node_modules', '.git', 'dist', 'build', '.tooling'].includes(ent.name)) continue;
      walkAllFiles(full, repoRoot, out);
    } else if (ent.isFile()) out.push(resolve(full));
  }
}

function findUnmatchedGlobs(repoRoot, globs) {
  if (!globs || globs.length === 0) return [];
  const all = [];
  walkAllFiles(repoRoot, repoRoot, all);
  const relAll = all.map(p => p.replace(resolve(repoRoot) + '/', ''));
  const unmatched = [];
  for (const g of globs) {
    const re = globToRegex(g);
    if (!relAll.some(p => re.test(p))) unmatched.push(g);
  }
  return unmatched;
}

// Source-file extensions only: if a manifest references a runtime artifact
// like REPORT.md or state.json that doesn't exist on disk, that's expected
// (the system produces it at runtime). We only flag hallucinated SOURCE
// files — those should be in the repo or be flagged.
const SOURCE_EXTENSIONS = new Set(['ts', 'tsx', 'mjs', 'js', 'jsx', 'py', 'sh', 'rs', 'go']);

function findBadFilePaths(repoRoot, body) {
  const out = [];
  const re = /`([^`\s]+\/[^`\s]+\.([a-zA-Z]{1,4}))`/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const path = m[1];
    const ext = m[2].toLowerCase();
    if (path.startsWith('http')) continue;
    if (path.startsWith('@')) continue;        // npm scoped package (e.g. @acme/sdk)
    if (/[<>]/.test(path)) continue;          // template placeholders
    if (/\*/.test(path)) continue;            // glob patterns in prose
    if (path.startsWith('/') || path.startsWith('~')) continue;  // runtime paths
    if (!SOURCE_EXTENSIONS.has(ext)) continue;  // runtime artifacts (json, md, etc) are fine
    if (!existsSync(resolve(repoRoot, path))) out.push(path);
  }
  return out;
}

function findMissingSections(body, frontMatter) {
  const missing = [];
  for (const s of REQUIRED_SECTIONS) {
    const re = new RegExp('^##\\s+' + s + '\\b', 'm');
    if (!re.test(body)) missing.push(s);
  }
  // Closing arrow is required UNLESS `kind:` says the system doesn't loop.
  // Forcing a closing arrow on one-shots strains the framing and tanks
  // scores; the Pass 2 prompt now tells the LLM to omit it for these kinds.
  const kind = (frontMatter?.kind || '').toLowerCase();
  if (!KINDS_WITHOUT_CLOSING_ARROW.has(kind)) {
    if (!/^##\s+Closing arrow\b/m.test(body)) missing.push('Closing arrow');
  }
  return missing;
}

/**
 * Extract subflow names from a body. A subflow is declared by a heading
 * line matching `## Subflow: <name>` (case-sensitive, exactly one space
 * after the colon). Returns an array of {name, hasMermaid} for each
 * subflow detected, in document order. Used both by the splitting-
 * candidate check below and by the static-site renderer.
 */
export function findSubflows(body) {
  const lines = body.split('\n');
  const out = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const m = ln.match(/^##\s+Subflow:\s+(.+?)\s*$/);
    if (m) {
      if (cur) out.push(cur);
      cur = { name: m[1].trim(), hasMermaid: false, startLine: i };
      continue;
    }
    if (cur && /^##\s+\S/.test(ln) && !/^##\s+Subflow:/.test(ln)) {
      // a sibling H2 ends the current subflow's scope
      out.push(cur); cur = null;
    }
    if (cur && /^```mermaid\b/.test(ln)) cur.hasMermaid = true;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Anti-regression check for incremental refresh: a regen must not silently
 * DROP `## Subflow:` sections (each with its own Mermaid diagram) that the
 * prior, previously-shipped manifest had. Returns one `subflow-regression`
 * problem naming the dropped subflows, or `[]` when nothing was lost.
 *
 * Only mermaid-bearing subflows count on both sides — a stub heading with no
 * diagram isn't richness worth protecting. Comparison is case-insensitive on
 * the subflow name. Adding/renaming subflows is fine; only net losses flag.
 */
export function checkSubflowRegression(priorBody, currentBody) {
  if (!priorBody || !currentBody) return [];
  const real = (body) => new Set(
    findSubflows(body).filter(s => s.hasMermaid).map(s => s.name.toLowerCase())
  );
  const before = real(priorBody);
  const after = real(currentBody);
  const dropped = [...before].filter(name => !after.has(name));
  if (dropped.length === 0) return [];
  return [{
    kind: 'subflow-regression',
    detail: `regen dropped ${dropped.length} mermaid subflow(s) the prior manifest had: ${dropped.join(', ')}`,
  }];
}

// Thresholds for the `splitting-candidate` flag. These are intentionally
// generous — the flag exists to surface oversize systems for HUMAN
// review, not to gate the build. Anything beyond these limits is
// suspicious; well-named subsystems usually weigh in below.
const MAX_SUBFLOWS_BEFORE_SPLIT = 6;
const MAX_BODY_BYTES_BEFORE_SPLIT = 12 * 1024;

/**
 * Returns 1 problem of kind `splitting-candidate` when the body has too
 * many subflows or is too large; else empty. Non-fatal — the revise
 * loop ignores this kind (see FIXABLE_KINDS in run-pipeline.mjs); the
 * page ships `active`, the maintainer sees the flag in the Notes /
 * vet output and decides whether to actually split.
 */
export function checkSplittingCandidate(body) {
  const subflows = findSubflows(body);
  const bytes = Buffer.byteLength(body, 'utf8');
  const reasons = [];
  if (subflows.length > MAX_SUBFLOWS_BEFORE_SPLIT) {
    reasons.push(`${subflows.length} subflows (> ${MAX_SUBFLOWS_BEFORE_SPLIT})`);
  }
  if (bytes > MAX_BODY_BYTES_BEFORE_SPLIT) {
    reasons.push(`body ${Math.round(bytes / 1024)} KB (> ${MAX_BODY_BYTES_BEFORE_SPLIT / 1024} KB)`);
  }
  if (reasons.length === 0) return [];
  return [{
    kind: 'splitting-candidate',
    detail: `${reasons.join(' + ')}. Consider promoting some subflows to their own system pages.`,
  }];
}

// Thresholds for the `merging-candidate` flag — the mirror of
// `checkSplittingCandidate` for systems Pass 1 split too THIN to fill a
// real manifest. Like its sibling these are conservative and the flag is
// advisory (non-fatal, non-fixable): it surfaces "this probably should be
// folded into its parent" for the maintainer, it does NOT gate the build.
//
// Anchors use < 2 (not < 3) deliberately: a complete-but-small system can
// legitimately have only 2 anchor bullets, and we never want a real system
// tripped on a single signal. The junk systems this guards against had ZERO
// anchors and ZERO mermaid nodes, which trip TWO signals together — exactly
// what the two-of-three rule below requires before flagging.
const MIN_ANCHORS_BEFORE_MERGE = 2;
const MIN_LOOP_NODES_BEFORE_MERGE = 3;
const MIN_BODY_BYTES_BEFORE_MERGE = 1.5 * 1024;

/** Count the `- \`path\` — desc` bullets under the `## Anchors` heading. */
function countAnchorBullets(body) {
  const lines = body.split('\n');
  let inAnchors = false;
  let count = 0;
  for (const ln of lines) {
    if (/^##\s+Anchors\b/.test(ln)) { inAnchors = true; continue; }
    if (inAnchors && /^##\s+\S/.test(ln)) break;   // next H2 ends the section
    if (inAnchors && /^\s*-\s+`[^`]+`/.test(ln)) count++;
  }
  return count;
}

/**
 * Count distinct node ids in the PRIMARY `## The loop` mermaid block.
 * Returns 0 when the section or its mermaid block is missing. A node id is
 * any identifier immediately followed by a shape opener (`[`, `(`, `{`, `>`).
 */
function countPrimaryLoopNodes(body) {
  const headingMatch = body.match(/^##\s+The loop\b/m);
  if (!headingMatch) return 0;
  // Scope from the heading to the next H2 (or end of body). We can't use a
  // multiline `$` terminator here — it matches every line end and would
  // truncate the section before the mermaid block.
  const after = body.slice(headingMatch.index + headingMatch[0].length);
  const nextH2 = after.search(/^##\s+\S/m);
  const section = nextH2 === -1 ? after : after.slice(0, nextH2);
  const mm = section.match(/```mermaid\n([\s\S]*?)\n```/);
  if (!mm) return 0;
  const code = mm[1];
  const ids = new Set();
  const re = /\b([A-Za-z][\w]*)\s*[[({>]/g;
  const keywords = new Set([
    'flowchart', 'graph', 'subgraph', 'sequenceDiagram', 'classDiagram',
    'stateDiagram', 'erDiagram', 'end', 'style', 'class', 'direction',
  ]);
  let m;
  while ((m = re.exec(code)) !== null) {
    if (!keywords.has(m[1])) ids.add(m[1]);
  }
  return ids.size;
}

/**
 * Returns 1 problem of kind `merging-candidate` when a manifest is too thin
 * to stand alone — the mirror of checkSplittingCandidate. Three signals:
 * too few anchors, a too-small/missing primary loop diagram, and a tiny
 * body. Requires at least TWO to fire together so a small-but-complete
 * system isn't flagged on a single signal. Non-fatal and non-fixable — the
 * revise loop ignores this kind (see FIXABLE_KINDS in run-pipeline.mjs); the
 * maintainer (or a future Pass 1 stickiness change) decides whether to fold
 * the system into its parent.
 */
export function checkMergingCandidate(body) {
  const anchors = countAnchorBullets(body);
  const nodes = countPrimaryLoopNodes(body);
  const bytes = Buffer.byteLength(body, 'utf8');
  let fired = 0;
  if (anchors < MIN_ANCHORS_BEFORE_MERGE) fired++;
  if (nodes < MIN_LOOP_NODES_BEFORE_MERGE) fired++;
  if (bytes < MIN_BODY_BYTES_BEFORE_MERGE) fired++;
  if (fired < 2) return [];
  return [{
    kind: 'merging-candidate',
    detail: `thin manifest (${anchors} anchors, ${nodes} mermaid nodes, ${bytes} bytes) — consider folding into its parent system.`,
  }];
}

function checkMermaid(body) {
  // Validate EVERY mermaid block (primary loop + each subflow) — a broken
  // subflow diagram is still broken. Reports per-block errors with an
  // index so the maintainer can find which block needs fixing.
  const blocks = [...body.matchAll(/```mermaid\n([\s\S]*?)\n```/g)];
  if (blocks.length === 0) return ['no mermaid block'];
  const validStarts = ['flowchart', 'graph', 'sequenceDiagram', 'classDiagram', 'stateDiagram', 'erDiagram', 'gantt', 'pie', 'journey'];
  const errs = [];
  blocks.forEach((m, i) => {
    const code = m[1].trim();
    const label = blocks.length > 1 ? `block ${i + 1}/${blocks.length}` : 'block';
    if (code.length === 0) { errs.push(`mermaid ${label}: empty`); return; }
    const firstLine = code.split('\n', 1)[0].trim();
    if (!validStarts.some(s => firstLine.startsWith(s))) {
      errs.push(`mermaid ${label}: unrecognized diagram type ("${firstLine}")`);
      return;
    }
    if (!/-->|->>|---|==>|-\.->|-\.\.->/.test(code)) {
      errs.push(`mermaid ${label}: no edges / connections detected (generic stub?)`);
    }
  });
  return errs;
}

export function cheapVet(repoRoot, manifestPath) {
  if (!existsSync(manifestPath)) {
    return { problems: [{ kind: 'file-missing', detail: manifestPath }] };
  }
  const text = readFileSync(manifestPath, 'utf8');
  const { rest: body, frontMatter } = parseFrontMatter(text);
  const problems = [];
  if (!frontMatter) {
    problems.push({ kind: 'no-front-matter' });
    return { problems };
  }
  if (!frontMatter.name) problems.push({ kind: 'front-matter-missing-name' });
  if (!Array.isArray(frontMatter.globs)) problems.push({ kind: 'front-matter-missing-globs' });
  for (const g of findUnmatchedGlobs(repoRoot, frontMatter.globs)) {
    problems.push({ kind: 'glob-no-matches', detail: g });
  }
  for (const p of findBadFilePaths(repoRoot, body)) {
    problems.push({ kind: 'mentioned-path-not-on-disk', detail: p });
  }
  for (const s of findMissingSections(body, frontMatter)) {
    problems.push({ kind: 'missing-section', detail: s });
  }
  for (const m of checkMermaid(body)) {
    problems.push({ kind: 'mermaid-issue', detail: m });
  }
  // Splitting-candidate is a soft signal — non-fatal, non-fixable. Lives
  // in the same problems[] for surface parity, filtered out of the
  // revise loop by FIXABLE_KINDS in run-pipeline.mjs.
  for (const sc of checkSplittingCandidate(body)) {
    problems.push(sc);
  }
  // Merging-candidate is the mirror soft signal — non-fatal, non-fixable.
  // Same surface parity, same filtering out of the revise loop.
  for (const mc of checkMergingCandidate(body)) {
    problems.push(mc);
  }
  return { problems, frontMatter, body };
}

function callClaude(prompt, { model = 'claude-haiku-4-5-20251001', timeoutMs = 12 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--model', model, '--output-format', 'text'];
    const ch = spawn('claude', args);
    const chunks = []; const errs = [];
    const timer = setTimeout(() => { ch.kill('SIGKILL'); reject(new Error('claude -p timeout')); }, timeoutMs);
    ch.stdout.on('data', c => chunks.push(c));
    ch.stderr.on('data', c => errs.push(c));
    ch.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks).toString('utf8'));
      else reject(new Error('claude -p exited ' + code + ': ' + Buffer.concat(errs).toString('utf8').slice(0, 500)));
    });
    ch.on('error', e => { clearTimeout(timer); reject(e); });
    ch.stdin.end(prompt);
  });
}

function readAnchorsForLLM(repoRoot, globs) {
  const all = [];
  walkAllFiles(repoRoot, repoRoot, all);
  const relAll = all.map(p => p.replace(resolve(repoRoot) + '/', ''));
  const matched = new Set();
  for (const g of globs || []) {
    const re = globToRegex(g);
    for (const p of relAll) if (re.test(p)) matched.add(p);
  }
  return [...matched].slice(0, 5).map(p => {
    try {
      return { path: p, content: readFileSync(resolve(repoRoot, p), 'utf8').slice(0, 4096) };
    } catch {
      return { path: p, content: '' };
    }
  });
}

export function buildLLMVetPrompt({ frontMatter, body, anchorSamples }) {
  return [
    'You are validating a system manifest against the actual code it describes.',
    '',
    '## System: ' + frontMatter.name,
    'Summary: ' + (frontMatter.summary || ''),
    'Globs: ' + JSON.stringify(frontMatter.globs),
    '',
    '## Manifest body',
    '```markdown',
    body.slice(0, 5000),
    '```',
    '',
    '## Anchor file content (samples)',
    ...anchorSamples.map(a => '### ' + a.path + '\n```\n' + a.content + '\n```'),
    '',
    'Output JSON only. Identify:',
    '- "hallucinatedSymbols": symbols/functions in the body that DO NOT appear in the anchor code',
    '- "invariantContradictions": invariants stated in the body that the code clearly violates',
    '- "wrongClosingArrow": true/false',
    '',
    'Schema: { "hallucinatedSymbols": ["..."], "invariantContradictions": ["..."], "wrongClosingArrow": false, "rationale": "1 sentence" }',
    '',
    'Output JSON now:',
  ].join('\n');
}

function parseJSON(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (inStr) { if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
    }}
  }
  return null;
}

export async function vetSystem(repoRoot, manifestPath, { llm = true, runner } = {}) {
  const cheap = cheapVet(repoRoot, manifestPath);
  if (cheap.problems.some(p => p.kind === 'file-missing' || p.kind === 'no-front-matter')) {
    return { manifestPath, status: 'issues', problems: cheap.problems, llmFindings: null };
  }
  let llmFindings = null;
  if (llm && cheap.frontMatter) {
    const anchorSamples = readAnchorsForLLM(repoRoot, cheap.frontMatter.globs);
    const prompt = buildLLMVetPrompt({ frontMatter: cheap.frontMatter, body: cheap.body, anchorSamples });
    const response = runner ? await runner(prompt) : await callClaude(prompt);
    llmFindings = parseJSON(response) || { rationale: 'unparseable', _raw: response.slice(0, 500) };
    if (Array.isArray(llmFindings.hallucinatedSymbols)) {
      for (const s of llmFindings.hallucinatedSymbols) cheap.problems.push({ kind: 'hallucinated-symbol', detail: s });
    }
    if (Array.isArray(llmFindings.invariantContradictions)) {
      for (const s of llmFindings.invariantContradictions) cheap.problems.push({ kind: 'invariant-contradiction', detail: s });
    }
    if (llmFindings.wrongClosingArrow === true) {
      cheap.problems.push({ kind: 'wrong-closing-arrow', detail: llmFindings.rationale || '' });
    }
  }
  return {
    manifestPath,
    status: cheap.problems.length === 0 ? 'ok' : 'issues',
    problems: cheap.problems,
    llmFindings,
  };
}

export const _internal = {
  findUnmatchedGlobs, findBadFilePaths, findMissingSections, checkMermaid,
  findSubflows, checkSplittingCandidate, checkMergingCandidate, REQUIRED_SECTIONS,
  MAX_SUBFLOWS_BEFORE_SPLIT, MAX_BODY_BYTES_BEFORE_SPLIT,
  MIN_ANCHORS_BEFORE_MERGE, MIN_LOOP_NODES_BEFORE_MERGE, MIN_BODY_BYTES_BEFORE_MERGE,
};
