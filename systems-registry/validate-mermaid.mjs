// Deterministic post-generation validator + LLM repair for mermaid
// blocks inside a system manifest body.
//
// Why this exists: pass25-vet's checkMermaid catches structural
// problems (missing block, wrong diagram type, no edges) but not the
// finer syntax bugs that cause Mermaid 10/11 to throw
// "translate(undefined, NaN)" warnings at render time and leave a
// blank diagram on the page. Examples seen on real generated bodies:
//   - Empty `## Subflow:` sections with NO mermaid block.
//   - `<br/>` line breaks combined with unicode operators in labels.
//   - Unbalanced quotes inside double-quoted node labels.
//   - Backticks or pipes in labels without proper quoting.
//
// The contract:
//   validateMermaidInBody(body) → Array of per-block reports.
//   repairMermaidBlocks(body, reports, { runner }) → fixed body.
//
// Pure where possible; LLM calls go through the injected `runner`
// (same shape as pass2's claude runner) so tests can stub it.

const VALID_DIAGRAM_STARTS = ['flowchart', 'graph', 'sequenceDiagram', 'classDiagram', 'stateDiagram', 'erDiagram', 'gantt', 'pie', 'journey'];

// Pull every mermaid block + every subflow heading out of a body, in
// document order, with positions so we can splice fixed versions back
// in. A subflow heading WITHOUT a following mermaid block is reported
// as a special "empty-subflow" issue (the LLM gets a chance to either
// generate a real one or get the section removed entirely).
export function extractMermaidBlocks(body) {
  const lines = (body || '').split('\n');
  const blocks = [];
  let i = 0;
  let lastSubflow = null;
  let mainSeen = false;
  // Helper: flush a pending subflow that never produced a mermaid block.
  const flushEmptySubflow = () => {
    if (lastSubflow && lastSubflow.mermaidStartLine === null) {
      blocks.push({
        kind: 'subflow',
        name: lastSubflow.name,
        headingLine: lastSubflow.headingLine,
        mermaidStartLine: null,
        mermaidEndLine: null,
        mermaid: null,
      });
    }
    lastSubflow = null;
  };
  while (i < lines.length) {
    const sub = lines[i].match(/^##\s+Subflow:\s+(.+?)\s*$/);
    if (sub) {
      // A new subflow heading closes any pending empty subflow first.
      flushEmptySubflow();
      lastSubflow = { name: sub[1].trim(), headingLine: i, mermaidStartLine: null, mermaidEndLine: null, mermaid: null };
      i++;
      continue;
    }
    // Any other H2 closes the current subflow's window.
    if (/^##\s+\S/.test(lines[i])) {
      flushEmptySubflow();
    }
    if (lines[i].startsWith('```mermaid')) {
      const start = i;
      let j = i + 1;
      while (j < lines.length && !lines[j].startsWith('```')) j++;
      const code = lines.slice(i + 1, j).join('\n');
      const entry = {
        kind: lastSubflow ? 'subflow' : (mainSeen ? 'extra' : 'main'),
        name: lastSubflow ? lastSubflow.name : (mainSeen ? null : 'The loop'),
        headingLine: lastSubflow ? lastSubflow.headingLine : null,
        mermaidStartLine: start,
        mermaidEndLine: j,
        mermaid: code,
      };
      blocks.push(entry);
      if (lastSubflow) {
        lastSubflow.mermaidStartLine = start;
        lastSubflow.mermaidEndLine = j;
        lastSubflow.mermaid = code;
        lastSubflow = null;
      } else {
        mainSeen = true;
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  // Tail: a trailing subflow with no mermaid (file ended).
  flushEmptySubflow();
  return blocks;
}

// Per-block validation. Returns [] when the block is clean,
// otherwise a list of { kind, hint } pairs describing each issue.
// Designed to be precise enough that a small LLM can fix from the hints
// alone, without re-reading the whole body.
export function validateMermaidBlock(block) {
  const issues = [];
  if (block.mermaid === null) {
    issues.push({
      kind: 'empty-subflow',
      hint: `Subflow "${block.name}" has a heading but NO mermaid block. Either add a flowchart that captures the sub-loop, or remove the heading entirely.`,
    });
    return issues;
  }
  const code = (block.mermaid || '').trim();
  if (code.length === 0) {
    issues.push({ kind: 'empty', hint: 'Mermaid block is empty.' });
    return issues;
  }
  const firstLine = code.split('\n', 1)[0].trim();
  if (!VALID_DIAGRAM_STARTS.some(s => firstLine.startsWith(s))) {
    issues.push({
      kind: 'bad-diagram-type',
      hint: `First line "${firstLine}" is not a recognised Mermaid diagram type. Start with one of: ${VALID_DIAGRAM_STARTS.join(', ')}.`,
    });
  }
  // No edges at all → either a stub or the agent forgot connections.
  if (!/-->|->>|---|==>|-\.->|-\.\.->|<-|<--/.test(code)) {
    issues.push({
      kind: 'no-edges',
      hint: 'Diagram has nodes but zero edges/arrows. Either add the connections that close the loop or remove this block.',
    });
  }
  // Per-line label sanity. Specific to common LLM bugs we've seen.
  const lines = code.split('\n');
  lines.forEach((ln, idx) => {
    const trimmed = ln.trim();
    if (!trimmed) return;
    // (1) Multi-line label using `<br/>` combined with unicode math
    // operators is a known Mermaid 10 layout-fail trigger.
    if (/<br\s*\/?>/i.test(ln) && /[∧∨≥≤≠∈∉⊂⊃→←↑↓·×÷±−]/.test(ln)) {
      issues.push({
        kind: 'br-with-unicode-operators',
        hint: `line ${idx + 1}: a node label combines <br/> line breaks with unicode operators (≥, ∧, −, etc.). Replace operators with ASCII equivalents (>=, AND, -) or replace <br/> with spaces.`,
      });
    }
    // (2) Unbalanced double-quoted label, e.g. `["foo "bar"]` or
    // `["unterminated`.
    const labelMatches = [...ln.matchAll(/\[\s*"([^"]*)$|\{\s*"([^"]*)$|\(\s*"([^"]*)$/g)];
    if (labelMatches.length > 0) {
      issues.push({
        kind: 'unterminated-label',
        hint: `line ${idx + 1}: node label has an opening quote with no matching close before end of line. Add a closing " or move content onto one line.`,
      });
    }
    // (3) Backtick characters inside a node label break Mermaid's
    // tokenizer in 10.x.
    if (/[\[\{(]\s*"[^"]*`/.test(ln)) {
      issues.push({
        kind: 'backtick-in-label',
        hint: `line ${idx + 1}: backtick character inside a node label. Mermaid 10 tokeniser trips on these. Replace backticks with single quotes or remove.`,
      });
    }
    // (4) Edge with an empty label `-->| |` or `-->||`.
    if (/-->\s*\|\s*\|/.test(ln) || /-->\s*\|\s+\|/.test(ln)) {
      issues.push({
        kind: 'empty-edge-label',
        hint: `line ${idx + 1}: edge label is empty. Either give the label text or drop the | | entirely.`,
      });
    }
  });
  return issues;
}

// Validate every mermaid block in a manifest body. Returns
// `[{ block, issues }]`, omitting clean blocks.
export function validateMermaidInBody(body) {
  return extractMermaidBlocks(body)
    .map(block => ({ block, issues: validateMermaidBlock(block) }))
    .filter(r => r.issues.length > 0);
}

// Repair prompt for the small-model. Kept small and structural so a
// 7B-class model could plausibly do this; we use whatever runner the
// caller supplies (defaults to the same claude path pass2 uses).
function repairPrompt({ block, issues, surfacePurpose }) {
  const issueLines = issues.map((i, n) => `  ${n + 1}. [${i.kind}] ${i.hint}`).join('\n');
  if (block.mermaid === null) {
    return `A "## Subflow: ${block.name}" heading exists in a systems-registry manifest but has no mermaid diagram below it. Either:
  (a) emit ONLY a valid \`\`\`mermaid flowchart that captures the sub-loop for "${block.name}", OR
  (b) emit the literal string "REMOVE-HEADING" to signal the subflow heading should be deleted.

Surface purpose: ${surfacePurpose || '(not provided)'}
Issues:
${issueLines}

Respond with ONLY the \`\`\`mermaid block (no prose, no fences-around-fences) OR the literal string REMOVE-HEADING.`;
  }
  return `Fix the broken Mermaid block below. Preserve the same semantic meaning — same nodes, same connections — but produce VALID Mermaid 10 syntax.

Issues detected:
${issueLines}

Broken block:
\`\`\`mermaid
${block.mermaid}
\`\`\`

Respond with ONLY the fixed \`\`\`mermaid block (open fence + fixed content + close fence, nothing else).`;
}

// Splice fixed blocks back into the body. `fixes` is an array of
// `{ block, replacement }` where replacement is either a new mermaid
// code string OR the sentinel 'REMOVE-HEADING' (only valid for
// empty-subflow blocks — drops the `## Subflow: <name>` heading line).
export function spliceMermaidFixes(body, fixes) {
  if (!fixes.length) return body;
  const lines = body.split('\n');
  // Sort by mermaidEndLine descending so splicing doesn't shift earlier
  // indices. For empty-subflow REMOVE-HEADING, use headingLine.
  const sorted = [...fixes].sort((a, b) => {
    const ai = a.block.mermaidEndLine ?? a.block.headingLine ?? -1;
    const bi = b.block.mermaidEndLine ?? b.block.headingLine ?? -1;
    return bi - ai;
  });
  for (const { block, replacement } of sorted) {
    if (block.mermaid === null) {
      // Empty subflow: either insert mermaid after heading, or
      // delete the heading.
      if (replacement === 'REMOVE-HEADING') {
        // Drop the heading line + any immediately-following blank lines.
        let end = block.headingLine + 1;
        while (end < lines.length && lines[end].trim() === '') end++;
        lines.splice(block.headingLine, end - block.headingLine);
      } else {
        // Insert the fixed mermaid block right after the heading
        // (and any blank lines).
        let insertAt = block.headingLine + 1;
        while (insertAt < lines.length && lines[insertAt].trim() === '') insertAt++;
        lines.splice(insertAt, 0, '', replacement, '');
      }
    } else {
      // Replace the existing mermaid block (start fence through end fence).
      lines.splice(
        block.mermaidStartLine,
        block.mermaidEndLine - block.mermaidStartLine + 1,
        replacement,
      );
    }
  }
  return lines.join('\n');
}

// Orchestrator: validate → repair → re-validate up to maxRounds.
// `runner({ prompt })` is the same shape pass2's callClaude uses. The
// repair is BEST-EFFORT — blocks that still fail after maxRounds are
// passed through unchanged (and the caller's pass25-vet step will flag
// the manifest needs-review).
export async function validateAndRepairBody(body, { runner, surfacePurpose, maxRounds = 2 } = {}) {
  let current = body;
  const log = [];
  for (let round = 1; round <= maxRounds; round++) {
    const reports = validateMermaidInBody(current);
    if (reports.length === 0) {
      log.push({ round, kind: 'clean', message: 'no mermaid issues remain' });
      break;
    }
    log.push({ round, kind: 'found', count: reports.length, details: reports.map(r => ({ name: r.block.name, kind: r.block.kind, issues: r.issues })) });
    if (!runner) {
      log.push({ round, kind: 'skipped', message: 'no runner provided — validator-only mode, body returned as-is' });
      break;
    }
    const fixes = [];
    for (const { block, issues } of reports) {
      const prompt = repairPrompt({ block, issues, surfacePurpose });
      let replacement;
      try {
        const raw = await runner(prompt);
        replacement = parseRepairReply(raw, block);
      } catch (e) {
        log.push({ round, kind: 'runner-failed', name: block.name, error: e?.message || String(e) });
        continue;
      }
      if (replacement) fixes.push({ block, replacement });
    }
    if (fixes.length === 0) {
      log.push({ round, kind: 'no-fixes-applied', message: 'runner produced no usable replacements' });
      break;
    }
    current = spliceMermaidFixes(current, fixes);
    log.push({ round, kind: 'applied', count: fixes.length });
  }
  return { body: current, log };
}

// Extract the mermaid block from a small-model reply. Accepts:
//   - ```mermaid\n...\n``` (canonical)
//   - REMOVE-HEADING sentinel (only valid for empty-subflow blocks)
//   - bare mermaid code (no fence) — wraps it
export function parseRepairReply(raw, block) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === 'REMOVE-HEADING' && block.mermaid === null) return 'REMOVE-HEADING';
  const fenced = trimmed.match(/```mermaid\n([\s\S]*?)\n```/);
  if (fenced) return '```mermaid\n' + fenced[1] + '\n```';
  // Bare code that starts with a valid diagram type → wrap.
  const firstLine = trimmed.split('\n', 1)[0].trim();
  if (VALID_DIAGRAM_STARTS.some(s => firstLine.startsWith(s))) {
    return '```mermaid\n' + trimmed + '\n```';
  }
  return null;
}
