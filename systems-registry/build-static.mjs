#!/usr/bin/env node
/**
 * systems-registry — static site builder for GitHub Pages.
 *
 * Generates a single self-contained HTML file at <out>/index.html.
 * All 12 systems' content + Mermaid diagrams are inlined at build
 * time as separate <section> elements; CSS `:target` (no client JS)
 * handles routing — clicking a sidebar link sets `location.hash`,
 * the matching section displays, others hide.
 *
 * Mermaid still needs JS to render the diagram blocks, but the JS
 * only iterates over `.mermaid` elements and replaces them with SVG
 * via the library's safe `render()` API — no innerHTML on user data.
 *
 * Usage:
 *   node tools/systems-registry/cli.mjs build [--out DIR]
 *
 * Default out: dist/systems
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

import { loadAll, extractMermaid } from './registry.mjs';
import { loadCategories } from './organize.mjs';
import { writeCompositeReadme } from './composite.mjs';
import { repoMeta } from './repo-meta.mjs';
import { _internal as vetInternal } from './pass25-vet.mjs';
const { findSubflows } = vetInternal;

function readSafe(p) {
  try { return readFileSync(p, 'utf8'); } catch { return ''; }
}

function repoRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    return process.cwd();
  }
}

function loadComposite(root) {
  const body = readSafe(join(root, 'docs', 'systems', 'README.md'));
  return extractMermaid(body);
}

function htmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function inlineMd(text) {
  let out = htmlEscape(text);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
  return out;
}

function renderMarkdown(md) {
  if (!md) return '';
  const lines = md.split('\n');
  const out = [];
  let inUl = false, inCode = false, codeBuf = [], paraBuf = [];
  const flushPara = () => {
    if (paraBuf.length) { out.push(`<p>${inlineMd(paraBuf.join(' '))}</p>`); paraBuf = []; }
  };
  const flushUl = () => { if (inUl) { out.push('</ul>'); inUl = false; } };
  for (const line of lines) {
    if (inCode) {
      if (line.startsWith('```')) {
        out.push(`<pre><code>${htmlEscape(codeBuf.join('\n'))}</code></pre>`);
        codeBuf = []; inCode = false;
      } else { codeBuf.push(line); }
      continue;
    }
    if (line.startsWith('```')) { flushPara(); flushUl(); inCode = true; continue; }
    if (line.match(/^## /)) { flushPara(); flushUl(); out.push(`<h2>${inlineMd(line.slice(3))}</h2>`); continue; }
    if (line.match(/^### /)) { flushPara(); flushUl(); out.push(`<h3>${inlineMd(line.slice(4))}</h3>`); continue; }
    if (line.match(/^- /) || line.match(/^\d+\. /)) {
      flushPara();
      if (!inUl) { out.push('<ul>'); inUl = true; }
      out.push(`<li>${inlineMd(line.replace(/^(- |\d+\. )/, ''))}</li>`);
      continue;
    }
    if (line.trim() === '') { flushPara(); flushUl(); continue; }
    paraBuf.push(line);
  }
  flushPara(); flushUl();
  return out.join('\n');
}

export function stripMermaidBlock(body) {
  return (body || '').replace(/```mermaid\n[\s\S]*?\n```/, '').trim();
}

/**
 * Strip every `## Subflow: <name>` section (heading + body + its own
 * mermaid block) from the main body so we don't render them twice. Each
 * subflow gets its own `<details>` block via extractSubflowSections().
 *
 * Implemented as a line-walker (mirroring extractSubflowSections below)
 * because the original regex used `\Z` which JavaScript treats as the
 * literal character `Z` — that caused the lazy lookahead to terminate
 * at the first `Z` in the subflow's own diagram (e.g. `Z["exit 0"]`),
 * leaking the rest of the mermaid syntax + subsequent subflows back
 * into the rendered body as raw text. The walker drops the whole
 * subflow span and everything between subflows up to the next non-
 * subflow `##` (or EOF).
 */
export function stripSubflowSections(body) {
  const lines = (body || '').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (/^##\s+Subflow:\s+/.test(lines[i])) {
      // Skip forward until the next sibling H2 that is NOT a subflow,
      // or end-of-input — whichever comes first.
      let j = i + 1;
      while (j < lines.length) {
        if (/^##\s+(?!Subflow:)\S/.test(lines[j])) break;
        j++;
      }
      i = j;
      continue;
    }
    out.push(lines[i]);
    i++;
  }
  return out.join('\n').trim();
}

/**
 * Drop noise that the body shouldn't render:
 *   - HTML comments (`<!-- ... -->`) — auto-generation marker, etc.
 *   - The top-level `# <name>` H1 — the renderer emits its own H2 from
 *     the system's name, so an in-body H1 is a duplicate.
 * Pure / idempotent.
 */
export function stripBodyNoise(body) {
  return (body || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^#\s+[^\n]+\n+/m, '')
    .trim();
}

/**
 * Pull each `## Subflow: <name>` section out as `{name, intro, mermaid,
 * trailing}`. Used to render subflows as collapsible `<details>` blocks
 * in document order under the primary Loop. Returns [] for pages with
 * no subflows (every existing page) so nothing changes for them.
 */
export function extractSubflowSections(body) {
  const out = [];
  // Walk via the literal `## Subflow: ` heading; for each, slice up to the
  // next sibling `## ` heading (or EOF). Same delimiter logic as
  // findSubflows() in pass25-vet so the two agree on what counts.
  const lines = (body || '').split('\n');
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(/^##\s+Subflow:\s+(.+?)\s*$/);
    if (!m) { i++; continue; }
    const name = m[1].trim();
    let j = i + 1;
    while (j < lines.length) {
      if (/^##\s+(?!Subflow:)\S/.test(lines[j])) break;   // next sibling H2
      if (/^##\s+Subflow:/.test(lines[j])) break;          // next subflow
      j++;
    }
    const section = lines.slice(i + 1, j).join('\n').trim();
    const mb = section.match(/```mermaid\n([\s\S]*?)\n```/);
    // Split prose around the mermaid block (intro before, trailing after).
    let intro = section, trailing = '';
    if (mb) {
      intro = section.slice(0, mb.index).trim();
      trailing = section.slice(mb.index + mb[0].length).trim();
    }
    out.push({ name, intro, mermaid: mb ? mb[1].trim() : '', trailing });
    i = j;
  }
  return out;
}

export function mermaidBodyOnly(block) {
  if (!block) return '';
  return block.replace(/^```mermaid\n/, '').replace(/\n```$/, '');
}

/**
 * Auto-quote Mermaid node/decision/subgraph labels so the renderer doesn't
 * choke on unquoted special characters (parens, ampersands, nested brackets,
 * angle-bracket entities, etc). This means manifest authors can write
 * `redact[redact inline to [REDACTED]]` and have it work — the sanitizer
 * upgrades it to `redact["redact inline to [REDACTED]"]` at build time.
 *
 * Mermaid accepts quoted labels for ALL plain-text content, so blanket
 * quoting is universally safe in flowcharts. Skips labels that already start
 * with a quote. Runs only on flowchart-style diagrams (no-op on sequenceDiagram
 * and other types since their node syntax is different).
 *
 * Also normalises sequenceDiagram bodies: strips `<br/>` from participant
 * aliases (which produces empty-SVG renders) and removes Unicode arrow chars
 * from message text.
 */
/**
 * Mermaid 10's parser silently breaks if any node identifier matches a
 * reserved keyword. The lexer thinks `graph` opens a legacy `graph LR`
 * declaration mid-diagram, etc. Auto-rename these IDs to safe variants
 * so authored manifests don't have to know the keyword list.
 */
const MERMAID_RESERVED_IDS = new Set([
  'graph', 'flowchart', 'sequenceDiagram', 'classDiagram', 'stateDiagram',
  'erDiagram', 'gantt', 'pie', 'journey', 'gitGraph', 'mindmap', 'timeline',
  'subgraph', 'end', 'class', 'classDef', 'style', 'linkStyle', 'direction',
  'click', 'note', 'state',
]);

function renameReservedIds(source) {
  // Match `<id>[`, `<id>{`, `<id>(`, `<id>:`, or `<id> -->` patterns where
  // <id> is a reserved keyword. Rename to `<id>_n`.
  let out = source;
  for (const kw of MERMAID_RESERVED_IDS) {
    // Only rename when the keyword appears at a NODE-ID position (followed by
    // a shape-opener `[`, `{`, `(`, `:`, or a whitespace+arrow). Not at the
    // start of a diagram declaration line.
    const safe = `${kw}_n`;
    // id followed by shape opener
    out = out.replace(new RegExp(`(^|\\s)${kw}([\\[\\{(])`, 'g'), `$1${safe}$2`);
    // id at start/end of an arrow edge
    out = out.replace(new RegExp(`(^|\\s)${kw}(\\s*-{1,2}[->])`, 'g'), `$1${safe}$2`);
    out = out.replace(new RegExp(`(-{1,2}>|\\.->)\\s*${kw}(\\s|$)`, 'g'), `$1 ${safe}$2`);
  }
  return out;
}

export function sanitizeMermaid(source) {
  if (!source) return source;
  // Reserved-keyword fix runs FIRST for both flowchart + sequence variants.
  source = renameReservedIds(source);
  // Default rendering orientation: top-down for every flowchart-family
  // diagram. LLM-generated bodies almost always pick LR which sprawls
  // horizontally and overflows the viewport on wide pages. TB stacks
  // vertically so subflows + composite stay readable at normal widths.
  // Covers:
  //   - flowchart {LR,RL,BT}        → flowchart TB
  //   - graph     {LR,RL,BT}        → graph TB
  //   - stateDiagram-v2 `direction LR/RL/BT` lines → `direction TB`
  source = source.replace(/^(flowchart|graph)\s+(LR|RL|BT)\b/m, '$1 TB');
  source = source.replace(/^(\s*direction\s+)(LR|RL|BT)\b/gm, '$1TB');
  const firstLine = source.split('\n', 1)[0].trim();
  const isSequence = /^sequenceDiagram\b/.test(firstLine);

  if (isSequence) {
    return source
      // `participant X as foo<br/>bar` → `participant X as foo bar`
      .replace(/^(\s*(?:participant|actor)\s+\w+\s+as\s+)([^\n]+)$/gm,
        (_m, p, rest) => p + rest.replace(/<br\s*\/?>/gi, ' '))
      // strip unicode arrows from message text
      .replace(/[→←↔]/g, '')
      // strip `"` from inside message bodies — mermaid 10's sequence parser
      // can't handle quoted segments mid-message
      .split('\n').map(line => {
        const msgMatch = line.match(/^(\s*)([A-Za-z_]\w*\s*-{1,2}>{1,2}>?\s*[A-Za-z_]\w*\s*:\s*)(.*)$/);
        if (!msgMatch) return line;
        return msgMatch[1] + msgMatch[2] + msgMatch[3].replace(/"/g, '');
      }).join('\n');
  }

  // Flowchart: clean up label content + quote-wrap.
  // Walks the source char-by-char (instead of regex) so nested brackets in
  // labels like `redact[redact inline<br/>to [REDACTED]]` are handled by
  // proper balanced-bracket scanning.
  return sanitizeFlowchart(source);
}

function cleanLabel(text) {
  return text
    // defuse nested brackets — replace `[X]` with `(X)` inside label text
    .replace(/\[/g, '(').replace(/\]/g, ')')
    // encode `&` so mermaid doesn't parse `P&L` as start of `&entity;`
    .replace(/&(?!(?:amp|lt|gt|quot|#\d+);)/g, '&amp;');
}

function sanitizeFlowchart(source) {
  // Subgraph: `subgraph foo[Title]` → `subgraph foo ["Title"]`. Mermaid
  // disambiguates the bracketed title from a node decl by the space; quoting
  // the title content is also required for special chars.
  source = source.replace(/\b(subgraph\s+[a-zA-Z_][\w-]*)\[([^\]"][^\]]*)\]/g,
    (_m, head, label) => `${head} ["${cleanLabel(label)}"]`);

  // Identifier characters (Mermaid node IDs).
  const isId = c => /[a-zA-Z0-9_-]/.test(c);
  // Find every occurrence of `<id><opener>` where opener is `[`, `{`, or `[(`.
  // Then scan forward with proper balance counting to find the matching close.
  let out = '';
  let i = 0;
  while (i < source.length) {
    // Find a candidate identifier start (preceded by space/start/newline/punct).
    let j = i;
    while (j < source.length && !isId(source[j])) { out += source[j]; j++; }
    // Read identifier
    let idStart = j;
    while (j < source.length && isId(source[j])) j++;
    const id = source.slice(idStart, j);
    if (id.length === 0) { i = j; continue; }
    // Look-ahead for opener
    const opener = source.slice(j, j + 2);
    let kind = null;
    if (opener === '[(') kind = 'cyl';
    else if (source[j] === '[' && source[j + 1] !== '(') kind = 'box';
    else if (source[j] === '{') kind = 'dec';
    if (!kind) { out += id; i = j; continue; }
    // Skip "subgraph" — the identifier is the next id, the bracket belongs to it
    // Actually subgraph is captured as the id; the next bracket belongs to its title.
    // Same handling: treat as a box.

    // Find matching close
    const open = kind === 'cyl' ? '[(' : (kind === 'box' ? '[' : '{');
    const close = kind === 'cyl' ? ')]' : (kind === 'box' ? ']' : '}');
    const openCh = kind === 'cyl' ? '[' : open;
    const closeCh = kind === 'cyl' ? ']' : close;
    let depth = 1;
    let k = j + open.length;
    while (k < source.length && depth > 0) {
      // Don't track depth inside quoted strings — Mermaid's quoted labels are atomic
      if (source[k] === '"') {
        k++;
        while (k < source.length && source[k] !== '"') k++;
        k++;
        continue;
      }
      if (source.slice(k, k + open.length) === open) { depth++; k += open.length; continue; }
      if (source.slice(k, k + close.length) === close) { depth--; k += close.length; continue; }
      if (kind === 'cyl' && source[k] === openCh) { depth++; k++; continue; }
      if (kind === 'cyl' && source[k] === closeCh) { /* part of close, handled above */ k++; continue; }
      if (source[k] === openCh && kind !== 'cyl') { depth++; k++; continue; }
      if (source[k] === closeCh && kind !== 'cyl') { depth--; k++; continue; }
      k++;
    }
    // k is now position after the close. Label is between j+open.length and k-close.length.
    const content = source.slice(j + open.length, k - close.length);
    const alreadyQuoted = content.startsWith('"') && content.endsWith('"');
    const cleaned = alreadyQuoted ? content : `"${cleanLabel(content)}"`;
    out += id + open + cleaned + close;
    i = k;
  }
  return out;
}

/**
 * Folder a system belongs to. Prefer the top-level dir of the first glob —
 * this maps to repo structure even when the system NAME is semantic
 * (e.g. `request-pipeline` with glob `services/api/workflow/**` → `services`).
 * Falls back to the name's first hyphen segment when no usable glob exists.
 */
function folderOf(s) {
  if (Array.isArray(s.globs)) {
    for (const g of s.globs) {
      const seg = String(g).split('/')[0];
      if (seg && !seg.includes('*') && !seg.startsWith('.')) return seg;
    }
  }
  const dash = s.name.indexOf('-');
  return dash > 0 ? s.name.slice(0, dash) : s.name;
}

/**
 * Group systems for the sidebar. If a `categories` object is provided
 * (from the LLM organize step's _categories.json), use those semantic
 * folders. Otherwise fall back to glob-dir grouping (first glob's
 * top-level segment).
 *
 * @param systems  array of loaded manifests (need .name, optionally .globs)
 * @param categories  optional { categories: [{name, systems: [name,...]}] }
 */
export function groupSystems(systems, categories = null) {
  const byName = new Map(systems.map(s => [s.name, s]));

  if (categories && Array.isArray(categories.categories)) {
    const groups = [];
    const placed = new Set();
    for (const cat of categories.categories) {
      const items = (cat.systems || [])
        .map(n => byName.get(n))
        .filter(Boolean);
      items.forEach(s => placed.add(s.name));
      if (items.length > 0) {
        groups.push({ folder: cat.name, items: items.slice().sort((a, b) => a.name.localeCompare(b.name)), semantic: true });
      }
    }
    // Any system not in a category → glob-dir fallback bucket so none are lost.
    const orphans = systems.filter(s => !placed.has(s.name));
    if (orphans.length > 0) {
      groups.push({ folder: 'Other', items: orphans.slice().sort((a, b) => a.name.localeCompare(b.name)), semantic: true });
    }
    return groups;
  }

  // Glob-dir grouping (no categories available)
  const groups = new Map();
  for (const s of systems) {
    const folder = folderOf(s);
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push(s);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([folder, items]) => ({
      folder,
      items: items.slice().sort((a, b) => a.name.localeCompare(b.name)),
      semantic: false,
    }));
}

function renderNav(systems, categories = null) {
  const groups = groupSystems(systems, categories);
  const scoreSpan = (s) => s.detector_score != null ? `<span class="score">${s.detector_score}</span>` : '';
  const out = [];
  for (const { folder, items, semantic } of groups) {
    // Glob-dir singletons render flat at root. Semantic categories ALWAYS
    // show a header (even a 1-system category — the category is the point).
    if (items.length === 1 && !semantic) {
      const s = items[0];
      out.push(`<a href="#${htmlEscape(s.name)}">${htmlEscape(s.name)}${scoreSpan(s)}</a>`);
      continue;
    }
    // Semantic folders use the LLM category name as-is; glob folders get a `/`.
    const header = semantic ? htmlEscape(folder) : `${htmlEscape(folder)}/`;
    out.push(`<h3 class="nav-folder">${header}</h3>`);
    for (const s of items) {
      // Strip the folder prefix only for path-slug folders. Semantic names show in full.
      const leaf = (!semantic && s.name.startsWith(folder + '-')) ? s.name.slice(folder.length + 1) : s.name;
      out.push(`<a class="nested" href="#${htmlEscape(s.name)}">${htmlEscape(leaf)}${scoreSpan(s)}</a>`);
    }
  }
  return out.join('\n      ');
}

function renderSystemSection(s, repoUrl = '') {
  const signalsHtml = (Array.isArray(s.detector_signals) ? s.detector_signals : [])
    .map(sig => `<span>${htmlEscape(sig)}</span>`).join('');
  const globsHtml = (Array.isArray(s.globs) ? s.globs : [])
    .map(g => `<code>${htmlEscape(g)}</code>`).join(' ');
  const mermaidBlock = extractMermaid(s._body || '');
  const mermaidDiv = mermaidBlock
    ? `<div class="diagram"><h3>Loop</h3><pre class="mermaid">${htmlEscape(sanitizeMermaid(mermaidBodyOnly(mermaidBlock)))}</pre></div>`
    : '';
  // Subflows render as collapsible <details> in document order beneath the
  // primary Loop. Each gets its own Mermaid block + intro/trailing prose.
  // For pages with no `## Subflow:` headings extractSubflowSections returns
  // [], so nothing changes for existing pages.
  const subflows = extractSubflowSections(s._body || '');
  const subflowsHtml = subflows.map((sf, i) => {
    const safeName = htmlEscape(sf.name);
    const slug = (sf.name || `subflow-${i}`).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const anchor = `${s.name}--${slug}`;
    const introHtml = sf.intro ? `<div class="subflow-intro">${renderMarkdown(sf.intro)}</div>` : '';
    const trailingHtml = sf.trailing ? `<div class="subflow-trailing">${renderMarkdown(sf.trailing)}</div>` : '';
    const diagram = sf.mermaid
      ? `<pre class="mermaid">${htmlEscape(sanitizeMermaid(sf.mermaid))}</pre>`
      : '<p class="subflow-empty"><em>no diagram</em></p>';
    return `
    <details class="subflow" id="${htmlEscape(anchor)}" open>
      <summary><strong>Subflow:</strong> ${safeName}</summary>
      ${introHtml}
      ${diagram}
      ${trailingHtml}
    </details>`;
  }).join('\n');
  // Strip BOTH the primary mermaid AND every subflow section from the prose
  // body so they only render once (in their dedicated render slots above).
  const bodyHtml = renderMarkdown(stripBodyNoise(stripSubflowSections(stripMermaidBlock(s._body || ''))));
  // Source-file link only rendered if we know the repo URL (i.e., we're in a
  // checkout with a `origin` remote). Without it, just skip the link.
  const sourceLink = (repoUrl && s._relPath) ? `${repoUrl}/blob/main/${s._relPath}` : '';
  return `
  <section id="${htmlEscape(s.name)}" class="system-page">
    <h1>${htmlEscape(s.name)}</h1>
    <p class="summary">${htmlEscape(s.summary || '')}</p>
    <div class="meta">
      <span>score ${s.detector_score ?? '?'}</span>${signalsHtml}${
        s.quality_score != null
          ? `<span class="quality ${Number(s.quality_score) >= 7 ? 'q-good' : 'q-low'}">quality ${s.quality_score}/10</span>`
          : ''}
    </div>
    <div class="globs"><strong>Globs:</strong> ${globsHtml}</div>
    ${mermaidDiv}
    ${subflows.length > 0 ? `<div class="subflows"><h3>Subflows (${subflows.length})</h3>${subflowsHtml}</div>` : ''}
    <div class="body">${bodyHtml}</div>
    ${sourceLink ? `<p class="source"><a href="${sourceLink}" target="_blank">view source: ${htmlEscape(s._relPath)}</a></p>` : ''}
  </section>`;
}

export function buildSite({ root = repoRoot(), out = 'dist/systems' } = {}) {
  // Auto-refresh docs/systems/README.md (the composite cross-system view) from
  // the on-disk hypothesis + manifests, so the diagram + table can never drift
  // out of sync with the regenerated system set. Best-effort: a missing
  // _hypothesis.md just leaves whatever README.md was committed last.
  try { writeCompositeReadme(root); } catch { /* hypothesis absent — keep prior README */ }
  const systems = loadAll(root);
  const composite = loadComposite(root);
  const compositeBody = composite ? sanitizeMermaid(mermaidBodyOnly(composite)) : null;
  // Semantic LLM categories if the organize step produced them; else glob-dir.
  const categories = loadCategories(root);

  // Derive repo identity from `git remote get-url origin` so the rendered
  // HTML's title / meta / source-file links carry the consumer repo's name,
  // not whatever was baked in at build time. Tool is canonical-to-one-repo;
  // every other consumer should still produce a correctly-titled site.
  const repo = repoMeta(root);
  const repoName = repo.name || 'this repository';

  const navHtml = renderNav(systems, categories);
  const sectionsHtml = systems.map(s => renderSystemSection(s, repo.url)).join('\n');

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Systems Registry — ${htmlEscape(repoName)}</title>
<meta name="description" content="Auto-detected complex systems in ${htmlEscape(repoName)}. Loop diagrams, anchors, invariants — generated by systems-registry.">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #0d1117; color: #c9d1d9; }
  .top-banner { background: #161b22; border-bottom: 1px solid #30363d;
    padding: 12px 24px; font-size: 13px; color: #7d8590; }
  .top-banner a { color: #58a6ff; text-decoration: none; }
  .top-banner a:hover { text-decoration: underline; }
  .layout { display: grid; grid-template-columns: 260px 1fr; min-height: calc(100vh - 45px); }
  nav { background: #161b22; border-right: 1px solid #30363d; padding: 16px 0;
    position: sticky; top: 0; height: 100vh; overflow-y: auto; }
  nav h2 { font-size: 11px; text-transform: uppercase; color: #7d8590;
    padding: 0 16px 8px; letter-spacing: 0.6px; margin: 0; }
  nav h2.repo { color: #58a6ff; padding-top: 12px; font-size: 12px;
    border-top: 1px solid #30363d; margin-top: 12px; }
  nav h3.nav-folder { font-size: 10px; text-transform: uppercase; color: #7d8590;
    letter-spacing: 0.5px; padding: 14px 16px 4px; margin: 0; font-weight: 600; }
  nav a { display: flex; justify-content: space-between; align-items: center;
    padding: 6px 16px; color: #c9d1d9; text-decoration: none;
    border-left: 3px solid transparent; }
  nav a.nested { padding-left: 28px; font-size: 13px; }
  nav a:hover { background: #21262d; }
  nav .score { font-size: 10px; color: #7d8590; background: #21262d;
    border-radius: 4px; padding: 1px 6px; }
  main { padding: 24px 32px 80px; max-width: 980px; }
  h1 { font-size: 24px; margin: 0 0 4px; color: #f0f6fc; }
  .summary { color: #8b949e; max-width: 720px; margin: 0 0 24px; line-height: 1.5; }
  .diagram { background: #161b22; border: 1px solid #30363d; border-radius: 6px;
    padding: 20px; margin-bottom: 32px; overflow-x: auto; }
  .diagram h3 { font-size: 11px; text-transform: uppercase; color: #7d8590;
    letter-spacing: 0.6px; margin: 0 0 12px; }
  .composite { border-color: #1f6feb55; }
  .subflows { max-width: 820px; margin: 0 0 32px; }
  .subflows > h3 { font-size: 11px; text-transform: uppercase; color: #7d8590;
    letter-spacing: 0.6px; margin: 0 0 12px; }
  .subflow { background: #0f141b; border: 1px solid #30363d; border-radius: 6px;
    padding: 0 16px; margin: 0 0 8px; }
  .subflow summary { cursor: pointer; padding: 12px 0; color: #c9d1d9;
    font-size: 13.5px; user-select: none; }
  .subflow summary:hover { color: #f0f6fc; }
  .subflow summary strong { color: #7d8590; font-weight: 500; font-size: 11px;
    text-transform: uppercase; letter-spacing: 0.6px; margin-right: 8px; }
  .subflow[open] { padding-bottom: 16px; }
  .subflow .subflow-intro,
  .subflow .subflow-trailing { color: #b1bac4; font-size: 13px; margin: 4px 0 12px; }
  .subflow pre.mermaid { background: #0d1117; border: 1px solid #21262d;
    border-radius: 4px; padding: 12px; overflow-x: auto; }
  .body { max-width: 820px; }
  .body h2 { font-size: 16px; color: #f0f6fc; border-bottom: 1px solid #30363d;
    padding-bottom: 6px; margin-top: 28px; }
  .body h3 { font-size: 14px; color: #f0f6fc; margin-top: 20px; }
  .body code { background: #161b22; padding: 2px 5px; border-radius: 3px; font-size: 12.5px; }
  .body pre { background: #161b22; padding: 12px; border-radius: 6px;
    border: 1px solid #30363d; overflow-x: auto; }
  .body pre code { background: none; padding: 0; }
  .body ul { padding-left: 22px; }
  .body li { margin: 4px 0; }
  .meta { display: flex; gap: 8px; font-size: 11px; color: #7d8590;
    margin-bottom: 16px; flex-wrap: wrap; }
  .meta span { background: #161b22; padding: 3px 8px; border-radius: 4px; }
  .meta .quality { font-weight: 600; }
  .meta .q-good { background: #1a3326; color: #3fb950; }
  .meta .q-low { background: #3a2a1a; color: #d29922; }
  .globs { font-size: 12px; color: #7d8590; margin-bottom: 24px; }
  .globs code { background: #161b22; padding: 2px 6px; border-radius: 3px;
    margin-right: 6px; }
  .source { font-size: 12px; margin-top: 40px; }
  .source a { color: #58a6ff; text-decoration: none; }

  /* CSS :target routing. All system pages start hidden; the one matching
     #hash becomes visible. The "no hash" case (default landing) shows
     #__composite__. */
  .system-page, #__composite__ { display: none; }
  .system-page:target { display: block; }
  #__composite__:target { display: block; }
  /* Default landing — no :target match means show composite. */
  body:not(:has(:target)) #__composite__ { display: block; }

  /* Highlight active nav link */
  nav a:target { background: #1f6feb22; border-left-color: #1f6feb; color: #58a6ff; }
</style>
</head>
<body>
<div class="top-banner">
  Systems Registry · auto-generated from
  ${repo.url
    ? `<a href="${htmlEscape(repo.url)}/tree/main/docs/systems">docs/systems/</a>`
    : '<code>docs/systems/</code>'}
  · ${systems.length} systems
</div>
<div class="layout">
  <nav>
    <h2>Overview</h2>
    <a href="#__composite__">cross-system map</a>
    <h2 class="repo">Systems</h2>
      ${navHtml}
  </nav>
  <main>
    <section id="__composite__" class="composite-page">
      <h1>How the systems feed each other</h1>
      <p class="summary">${systems.length} auto-detected systems and how their loops close into each other. Click any system in the sidebar for its loop diagram, anchors, invariants, and failure modes.</p>
      ${compositeBody ? `<div class="diagram composite"><h3>Composite</h3><pre class="mermaid">${htmlEscape(compositeBody)}</pre></div>` : ''}
    </section>
${sectionsHtml}
  </main>
</div>
<script type="module">
  import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs';
  // startOnLoad:true does the initial render with per-diagram error
  // isolation (a malformed subflow doesn't take down its siblings).
  // We add a hashchange nudge to re-render the newly-visible section's
  // diagrams when the user clicks a different system in the sidebar.
  mermaid.initialize({ startOnLoad: true, theme: 'dark', securityLevel: 'loose' });

  async function renderTargetSection() {
    const sel =
      '.system-page:target pre.mermaid:not([data-processed]), '
      + '#__composite__:target pre.mermaid:not([data-processed]), '
      + '.system-page:target details.subflow[open] pre.mermaid:not([data-processed])';
    const nodes = [...document.querySelectorAll(sel)];
    // Per-node so one malformed diagram doesn't bail out the rest.
    for (const n of nodes) {
      try { await mermaid.run({ nodes: [n] }); }
      catch { /* ignore single-diagram render failures */ }
    }
  }

  window.addEventListener('hashchange', () => setTimeout(renderTargetSection, 0));
  document.addEventListener('toggle', (e) => {
    if (e.target.matches('details.subflow')) renderTargetSection();
  }, true);
</script>
</body>
</html>`;

  // Two output modes:
  //  - `out` ends in `.html` → write that exact file as a single self-contained
  //    HTML (perfect for committing into the repo so anyone can open it via
  //    file:// without running a server).
  //  - otherwise → write `out/index.html` + `out/.nojekyll` (the GitHub
  //    Pages-friendly dir layout).
  const outAbs = resolve(root, out);
  const singleFile = out.endsWith('.html');
  let outFile;
  if (singleFile) {
    mkdirSync(dirname(outAbs), { recursive: true });
    outFile = outAbs;
    writeFileSync(outFile, html);
  } else {
    mkdirSync(outAbs, { recursive: true });
    outFile = join(outAbs, 'index.html');
    writeFileSync(outFile, html);
    writeFileSync(join(outAbs, '.nojekyll'), '');
  }

  return { outFile, systems: systems.length, composite: !!composite, mode: singleFile ? 'single-file' : 'dir' };
}

export const _internal = { renderMarkdown, renderSystemSection, htmlEscape };
