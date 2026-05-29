#!/usr/bin/env node
/**
 * systems-registry — local browser viewer for the registry.
 *
 * Spins up a tiny Node http server, opens a browser, and renders all
 * registered systems' Mermaid diagrams on one scrollable page with a
 * sidebar nav. Files are read from disk on every request so edits
 * show up on reload — no watch/build step.
 *
 * Usage: node tools/systems-registry/cli.mjs view [--port N] [--no-open]
 */

import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

import { loadAll, extractMermaid } from './registry.mjs';
import {
  groupSystems,
  extractSubflowSections,
  sanitizeMermaid,
  mermaidBodyOnly,
  stripMermaidBlock,
  stripSubflowSections,
  stripBodyNoise,
} from './build-static.mjs';
import { loadCategories } from './organize.mjs';
import { readRunReport } from './run-pipeline.mjs';

// Slugify a subflow name for in-page anchors (matches build-static's
// approach: lowercase, non-alnum → -). Used by both the body anchor and
// the sidebar link.
function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function htmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function readSafe(p) {
  try { return readFileSync(p, 'utf8'); } catch { return ''; }
}

function loadComposite(repoRoot) {
  const overviewPath = join(repoRoot, 'docs', 'systems', 'README.md');
  const body = readSafe(overviewPath);
  return extractMermaid(body);
}

// Color band for a quality score. Mirrors run-pipeline's minScore default (7):
// <minScore: red, [minScore, minScore+1.5): yellow, >=minScore+1.5: green.
// Returns CSS color tokens used by the sidebar badge and the quality panel.
function scoreBand(score, minScore = 7) {
  if (score == null || Number.isNaN(score)) return { tier: 'unscored', bg: '#21262d', fg: '#7d8590' };
  if (score < minScore) return { tier: 'red', bg: '#5a1d1d', fg: '#ff8a8a' };
  if (score < minScore + 1.5) return { tier: 'yellow', bg: '#5a4a1d', fg: '#ffd66f' };
  return { tier: 'green', bg: '#1d5a2e', fg: '#7ee787' };
}

function renderPage(repoRoot, selected) {
  const systems = loadAll(repoRoot);
  const composite = loadComposite(repoRoot);
  const runReport = readRunReport(repoRoot);
  const reportByName = new Map();
  if (runReport?.systems) for (const s of runReport.systems) reportByName.set(s.name, s);
  const minScore = runReport?.minScore ?? 7;
  // No ?system= → landing (overview only). A system is shown only when
  // explicitly selected, so the cross-system map isn't stamped on every page.
  const active = selected ? systems.find(s => s.name === selected) : null;
  // Mirror build-static: use LLM-organized semantic categories when present
  // (docs/systems/_categories.json), else fall back to glob-dir grouping.
  let categories = null;
  try { categories = loadCategories(repoRoot); } catch { /* ignore */ }

  // For each system, peek at its subflows so the sidebar can expand the
  // active system to show jumplinks. Cheap (regex on body) and only the
  // active system's list is rendered, but pre-computing the per-system
  // count lets us show an "n flows" affordance on every entry.
  const subflowsByName = new Map();
  for (const s of systems) {
    subflowsByName.set(s.name, extractSubflowSections(s._body || ''));
  }

  function renderSystemLink(s, { nested } = {}) {
    const subs = subflowsByName.get(s.name) || [];
    const isActive = s.name === active?.name;
    const cls = `${nested ? 'nested ' : ''}${isActive ? 'active' : ''}`.trim();
    const leaf = nested && s.name.startsWith((nested.folder || '') + '-')
      ? s.name.slice(nested.folder.length + 1) : s.name;
    // Prefer the run-report's quality score (red/yellow/green) over the
    // detector score — readers care about "is this manifest passing?", not
    // "how strongly did the detector think this was a system?". Fall back
    // to subflow-count badge when there's no quality data, then detector.
    const qScore = s.quality_score ?? reportByName.get(s.name)?.qualityScore;
    let hint;
    if (qScore != null) {
      const band = scoreBand(qScore, minScore);
      hint = `<span class="qbadge" style="background:${band.bg};color:${band.fg}" title="quality score ${qScore}/10 (band: ${band.tier})">${qScore}</span>`;
    } else if (subs.length > 0) {
      hint = `<span class="subflow-count">${subs.length}▸</span>`;
    } else {
      hint = `<span class="score">${s.detector_score ?? ''}</span>`;
    }
    const linkHtml = `<a${cls ? ` class="${cls}"` : ''} href="/?system=${encodeURIComponent(s.name)}">${htmlEscape(leaf)} ${hint}</a>`;
    if (!isActive || subs.length === 0) return linkHtml;
    // Active + has subflows: render expanded jumplinks under the entry.
    const items = subs.map(sf =>
      `<a class="subflow-link" href="/?system=${encodeURIComponent(s.name)}#subflow-${slugify(sf.name)}">${htmlEscape(sf.name)}</a>`
    ).join('\n');
    return `${linkHtml}\n<div class="subflow-list">${items}</div>`;
  }

  const navParts = [];
  navParts.push(`<a href="/"${!active ? ' class="active"' : ''}>Overview</a>`);
  for (const { folder, items, semantic } of groupSystems(systems, categories)) {
    if (items.length === 1 && !semantic) {
      navParts.push(renderSystemLink(items[0]));
    } else {
      const header = semantic ? htmlEscape(folder) : `${htmlEscape(folder)}/`;
      navParts.push(`<h3 class="nav-folder">${header}</h3>`);
      for (const s of items) {
        navParts.push(renderSystemLink(s, { nested: { folder: semantic ? '' : folder } }));
      }
    }
  }
  const navHtml = navParts.join('\n');

  const mermaid = active ? extractMermaid(active._body || '') : null;
  const body = active?._body || '';
  const subflows = active ? subflowsByName.get(active.name) || [] : [];
  const activeReport = active ? reportByName.get(active.name) : null;

  // Use the same strip pipeline as build-static so the live viewer and
  // the static build agree: drop the primary mermaid block + every
  // subflow section + body noise (HTML comments, duplicate `# name` H1).
  // Previously this used a one-off subflow regex that bled mermaid
  // syntax into the body when the regex anchor failed.
  const bodyWithoutMermaid = stripBodyNoise(stripSubflowSections(stripMermaidBlock(body)));

  // Build the subflow blocks (mermaid + intro/trailing prose).
  const subflowHtml = subflows.length === 0 ? '' : subflows.map(sf => `
    <details class="subflow" open>
      <summary id="subflow-${slugify(sf.name)}">Subflow: ${htmlEscape(sf.name)}</summary>
      ${sf.intro ? `<div class="subflow-prose">${renderMarkdown(sf.intro)}</div>` : ''}
      ${sf.mermaid ? `<pre class="mermaid">${htmlEscape(sanitizeMermaid(sf.mermaid))}</pre>` : ''}
      ${sf.trailing ? `<div class="subflow-prose">${renderMarkdown(sf.trailing)}</div>` : ''}
    </details>
  `).join('\n');

  // Build the Overview "Last run" summary. Only renders when a run report
  // exists — fresh repos before the first pipeline run just show the diagram.
  function renderLastRun() {
    if (!runReport) return '';
    const s = runReport.summary || {};
    const when = runReport.finishedAt ? new Date(runReport.finishedAt).toLocaleString() : '';
    const belowBar = (s.belowBar || []);
    const errored = s.errored || 0;
    const errClass = errored > 0 ? ' warn' : '';
    const reviewClass = (s.needsReview || 0) > 0 ? ' warn' : '';
    const avgClass = s.avgQualityScore != null && s.avgQualityScore >= minScore + 1 ? ' good' : '';
    return `
    <div class="lastrun">
      <div class="lastrun-title">Last pipeline run</div>
      <div class="lastrun-row">
        <span class="stat"><b>${s.total ?? 0}</b> systems</span>
        <span class="stat"><b>${s.active ?? 0}</b> active</span>
        <span class="stat${reviewClass}"><b>${s.needsReview ?? 0}</b> needs-review</span>
        <span class="stat${errClass}"><b>${errored}</b> errored</span>
        ${s.avgQualityScore != null ? `<span class="stat${avgClass}">avg score <b>${s.avgQualityScore}</b>/10</span>` : ''}
        ${typeof s.tokensEst === 'number' ? `<span class="stat">tokens <b>${s.tokensEst.toLocaleString()}</b></span>` : ''}
        ${when ? `<span class="when">${htmlEscape(when)}</span>` : ''}
      </div>
      ${belowBar.length ? `<div class="lastrun-belowbar">below bar (<${minScore}): ${
        belowBar.map(s => {
          const m = String(s).match(/^([\w-]+)\s*\(([\d.]+)\)/);
          if (!m) return htmlEscape(String(s));
          return `<a href="/?system=${encodeURIComponent(m[1])}">${htmlEscape(m[1])}</a>(${m[2]})`;
        }).join(' ')
      }</div>` : ''}
    </div>`;
  }

  // Build the per-system "Quality & vet" panel.
  function renderQualityPanel() {
    if (!active) return '';
    if (!activeReport) return '';
    const score = activeReport.qualityScore;
    const band = scoreBand(score, minScore);
    const verdict = activeReport.qualityVerdict;
    // Order: final problems (still wrong) come first in red, then initial-
    // only problems (what revise fixed) in yellow so the reader sees what's
    // outstanding vs. what the pipeline already cleaned up.
    const finalKinds = new Set((activeReport.finalProblems || []).map(p => p.kind + '|' + (p.detail || '')));
    const finalProbs = activeReport.finalProblems || [];
    const initialProbs = activeReport.initialProblems || [];
    const fixedProbs = initialProbs.filter(p => !finalKinds.has(p.kind + '|' + (p.detail || '')));
    const llm = activeReport.llmFindings;
    function probLi(p, softer) {
      const detail = p.detail ? `: ${htmlEscape(String(p.detail))}` : '';
      return `<li><span class="pkind${softer ? ' softer' : ''}">${htmlEscape(p.kind)}</span>${detail}</li>`;
    }
    const finalHtml = finalProbs.length
      ? `<div><b style="font-size:12px">Still flagged after ${activeReport.reviseAttempts || 0} retries</b><ul class="problems">${finalProbs.map(p => probLi(p, false)).join('')}</ul></div>`
      : `<div class="empty">No outstanding vet issues.</div>`;
    const fixedHtml = fixedProbs.length
      ? `<div style="margin-top:10px"><b style="font-size:12px;color:#7d8590">Caught + fixed by revise</b><ul class="problems">${fixedProbs.map(p => probLi(p, true)).join('')}</ul></div>`
      : '';
    const llmHtml = llm && (llm.rationale || llm._raw)
      ? `<div style="margin-top:12px;font-size:12px;color:#8b949e"><b style="color:#c9d1d9">Judge rationale:</b> ${htmlEscape(llm.rationale || String(llm._raw).slice(0, 200))}</div>`
      : '';
    return `
    <div class="qpanel">
      <h3>Quality &amp; vet
        ${score != null ? `<span class="qbadge-lg" style="background:${band.bg};color:${band.fg}">${score}/10</span>` : '<span class="qbadge-lg" style="background:#21262d;color:#7d8590">unscored</span>'}
        ${verdict ? `<span style="font-size:11px;color:#8b949e;text-transform:uppercase;letter-spacing:0.6px">${htmlEscape(verdict)}</span>` : ''}
      </h3>
      <div class="qpanel-meta">
        <span>status: ${htmlEscape(activeReport.status || '?')}</span>
        <span>revise attempts: ${activeReport.reviseAttempts ?? 0}</span>
        <span>refine rounds: ${activeReport.refineRounds ?? 0}</span>
        ${activeReport.skipReason ? `<span>skipped: ${htmlEscape(activeReport.skipReason)}</span>` : ''}
        ${activeReport.elapsedMs ? `<span>${Math.round(activeReport.elapsedMs / 1000)}s</span>` : ''}
      </div>
      ${finalHtml}
      ${fixedHtml}
      ${llmHtml}
    </div>`;
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Systems Registry</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #0d1117; color: #c9d1d9; }
  .layout { display: grid; grid-template-columns: 240px 1fr; height: 100vh; }
  nav { background: #161b22; border-right: 1px solid #30363d; overflow-y: auto; padding: 16px 0; }
  nav h2 { font-size: 11px; text-transform: uppercase; color: #7d8590; padding: 0 16px 8px;
    letter-spacing: 0.6px; margin: 0; }
  nav h3.nav-folder { font-size: 10px; text-transform: uppercase; color: #7d8590;
    letter-spacing: 0.5px; padding: 14px 16px 4px; margin: 0; font-weight: 600; }
  nav a { display: flex; justify-content: space-between; align-items: center;
    padding: 6px 16px; color: #c9d1d9; text-decoration: none; border-left: 3px solid transparent; }
  nav a.nested { padding-left: 28px; font-size: 13px; }
  nav a:hover { background: #21262d; }
  nav a.active { background: #1f6feb22; border-left-color: #1f6feb; color: #58a6ff; }
  nav .score { font-size: 10px; color: #7d8590; background: #21262d; border-radius: 4px;
    padding: 1px 6px; }
  main { overflow-y: auto; padding: 24px 32px 80px; }
  h1 { font-size: 22px; margin: 0 0 4px; color: #f0f6fc; }
  .summary { color: #8b949e; max-width: 720px; margin: 0 0 24px; }
  .diagram { background: #161b22; border: 1px solid #30363d; border-radius: 6px;
    padding: 16px; margin-bottom: 32px; }
  .diagram h3 { font-size: 12px; text-transform: uppercase; color: #7d8590;
    letter-spacing: 0.6px; margin: 0 0 12px; }
  .body { max-width: 820px; }
  .body h2 { font-size: 16px; color: #f0f6fc; border-bottom: 1px solid #30363d;
    padding-bottom: 6px; margin-top: 28px; }
  .body h3 { font-size: 14px; color: #f0f6fc; margin-top: 20px; }
  .body code { background: #161b22; padding: 2px 5px; border-radius: 3px; font-size: 12.5px; }
  .body pre { background: #161b22; padding: 12px; border-radius: 6px; overflow-x: auto;
    border: 1px solid #30363d; }
  .body pre code { background: none; padding: 0; }
  .body ul { padding-left: 22px; }
  .body li { margin: 4px 0; }
  .composite { border-color: #1f6feb55; }
  .meta { display: flex; gap: 16px; font-size: 12px; color: #7d8590; margin-bottom: 20px; }
  .meta span { background: #161b22; padding: 3px 8px; border-radius: 4px; }
  /* Subflows: progressive disclosure under the primary Loop diagram. */
  .subflows { margin-bottom: 32px; }
  .subflow { background: #161b22; border: 1px solid #30363d; border-radius: 6px;
    margin-bottom: 12px; }
  .subflow > summary { cursor: pointer; padding: 12px 16px; font-size: 12px;
    text-transform: uppercase; color: #58a6ff; letter-spacing: 0.6px;
    border-bottom: 1px solid transparent; outline: none; }
  .subflow[open] > summary { border-bottom-color: #30363d; }
  .subflow > pre.mermaid { background: #0d1117; margin: 12px 16px; padding: 12px;
    border: 1px solid #21262d; border-radius: 4px; }
  .subflow-prose { padding: 8px 16px 0; color: #c9d1d9; font-size: 13px; }
  .subflow-prose p { margin: 8px 0; }
  /* Sidebar subflow expand */
  nav .subflow-count { font-size: 10px; color: #58a6ff; background: #1f6feb22;
    border-radius: 4px; padding: 1px 6px; }
  nav .subflow-list { padding: 2px 0 8px; }
  nav a.subflow-link { font-size: 12px; padding: 3px 16px 3px 36px;
    color: #8b949e; border-left: 3px solid transparent; }
  nav a.subflow-link:hover { color: #c9d1d9; background: #21262d; }
  /* Quality badge in the sidebar — color-coded by score band. */
  nav .qbadge { font-size: 10px; border-radius: 4px; padding: 1px 6px;
    font-variant-numeric: tabular-nums; font-weight: 600; }
  /* Quality & Vet panel on a system page. */
  .qpanel { background: #161b22; border: 1px solid #30363d; border-radius: 6px;
    padding: 16px; margin-bottom: 32px; }
  .qpanel h3 { font-size: 12px; text-transform: uppercase; color: #7d8590;
    letter-spacing: 0.6px; margin: 0 0 12px; display: flex; align-items: center;
    gap: 12px; }
  .qpanel .qbadge-lg { font-size: 13px; padding: 2px 10px; border-radius: 4px;
    font-variant-numeric: tabular-nums; font-weight: 600; }
  .qpanel .qpanel-meta { display: flex; gap: 16px; font-size: 12px; color: #8b949e;
    margin-bottom: 12px; flex-wrap: wrap; }
  .qpanel .qpanel-meta span { background: #0d1117; padding: 3px 8px; border-radius: 4px;
    border: 1px solid #21262d; }
  .qpanel ul.problems { padding-left: 20px; margin: 8px 0 0; font-size: 13px; }
  .qpanel ul.problems li { margin: 3px 0; color: #c9d1d9; }
  .qpanel .pkind { display: inline-block; font-size: 10px; text-transform: uppercase;
    background: #5a1d1d; color: #ff8a8a; border-radius: 3px; padding: 0 5px;
    margin-right: 6px; font-weight: 600; letter-spacing: 0.4px; }
  .qpanel .pkind.softer { background: #5a4a1d; color: #ffd66f; }
  .qpanel .empty { color: #7d8590; font-style: italic; font-size: 13px; }
  /* Last-run summary on the Overview page. */
  .lastrun { background: #161b22; border: 1px solid #30363d; border-radius: 6px;
    padding: 14px 18px; margin-bottom: 24px; }
  .lastrun-title { font-size: 11px; text-transform: uppercase; color: #7d8590;
    letter-spacing: 0.6px; margin: 0 0 10px; }
  .lastrun-row { display: flex; gap: 18px; flex-wrap: wrap; font-size: 13px;
    align-items: center; }
  .lastrun-row .stat { color: #c9d1d9; }
  .lastrun-row .stat b { color: #f0f6fc; font-variant-numeric: tabular-nums; }
  .lastrun-row .stat.warn b { color: #ff8a8a; }
  .lastrun-row .stat.good b { color: #7ee787; }
  .lastrun-row .when { color: #7d8590; margin-left: auto; font-size: 12px; }
  .lastrun-belowbar { margin-top: 10px; font-size: 12px; color: #ffd66f; }
  .lastrun-belowbar a { color: #ffd66f; text-decoration: underline; margin-right: 8px; }
</style>
</head>
<body>
<div class="layout">
  <nav>
    <h2>Systems (${systems.length})</h2>
    ${navHtml}
  </nav>
  <main>
    ${!active ? `
    <h1>How the systems feed each other</h1>
    <p class="summary">${systems.length} system${systems.length === 1 ? '' : 's'} and how their loops close into each other. Pick one from the sidebar for its diagram, anchors, invariants, and failure modes.</p>
    ${renderLastRun()}
    ${composite ? `
    <div class="diagram composite">
      <pre class="mermaid">${htmlEscape(sanitizeMermaid(composite.replace(/```mermaid\n/, '').replace(/\n```$/, '')))}</pre>
    </div>` : (systems.length ? '' : '<p>No systems registered.</p>')}
    ` : `
    <h1>${htmlEscape(active.name)}</h1>
    <p class="summary">${htmlEscape(active.summary || '')}</p>
    <div class="meta">
      <span>score ${active.detector_score ?? '?'}</span>
      <span>${Array.isArray(active.detector_signals) ? active.detector_signals.length : 0} signals</span>
      <span>${Array.isArray(active.globs) ? active.globs.length : 0} globs</span>
    </div>
    ${mermaid ? `
    <div class="diagram">
      <h3>Loop</h3>
      <pre class="mermaid">${htmlEscape(sanitizeMermaid(mermaidBodyOnly(mermaid)))}</pre>
    </div>` : ''}
    ${renderQualityPanel()}
    ${subflowHtml ? `<div class="subflows">${subflowHtml}</div>` : ''}
    <div class="body">${renderMarkdown(bodyWithoutMermaid)}</div>
    `}
  </main>
</div>

<script type="module">
  import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs';
  mermaid.initialize({ startOnLoad: true, theme: 'dark', securityLevel: 'loose' });
</script>
</body>
</html>`;
}

/** Minimal markdown → HTML: enough for headings, lists, code, paragraphs.
 *  Doesn't try to be CommonMark-complete. */
function renderMarkdown(md) {
  if (!md) return '';
  const lines = md.split('\n');
  const out = [];
  let inUl = false;
  let inCode = false;
  let codeLang = '';
  let codeBuf = [];
  let paraBuf = [];

  function flushPara() {
    if (paraBuf.length) {
      const txt = paraBuf.join(' ');
      out.push(`<p>${inlineMd(txt)}</p>`);
      paraBuf = [];
    }
  }
  function flushUl() { if (inUl) { out.push('</ul>'); inUl = false; } }

  for (const raw of lines) {
    const line = raw;
    if (inCode) {
      if (line.startsWith('```')) {
        out.push(`<pre><code>${htmlEscape(codeBuf.join('\n'))}</code></pre>`);
        codeBuf = []; inCode = false; codeLang = '';
      } else {
        codeBuf.push(line);
      }
      continue;
    }
    if (line.startsWith('```')) {
      flushPara(); flushUl();
      inCode = true; codeLang = line.slice(3).trim();
      continue;
    }
    if (line.match(/^## /)) {
      flushPara(); flushUl();
      out.push(`<h2>${inlineMd(line.slice(3))}</h2>`);
      continue;
    }
    if (line.match(/^### /)) {
      flushPara(); flushUl();
      out.push(`<h3>${inlineMd(line.slice(4))}</h3>`);
      continue;
    }
    if (line.match(/^- /) || line.match(/^\d+\. /)) {
      flushPara();
      if (!inUl) { out.push('<ul>'); inUl = true; }
      out.push(`<li>${inlineMd(line.replace(/^(- |\d+\. )/, ''))}</li>`);
      continue;
    }
    if (line.trim() === '') {
      flushPara(); flushUl();
      continue;
    }
    paraBuf.push(line);
  }
  flushPara(); flushUl();
  return out.join('\n');
}

function inlineMd(text) {
  let out = htmlEscape(text);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
  return out;
}

function repoRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    return process.cwd();
  }
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open';
  try { execFileSync(cmd, [url], { stdio: 'ignore' }); } catch { /* ignore */ }
}

export function startServer({ port = 0, root = repoRoot(), open = true } = {}) {
  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/' || url.pathname === '/index.html') {
        const sel = url.searchParams.get('system') || null;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(renderPage(root, sel));
        return;
      }
      if (url.pathname === '/api/systems') {
        const systems = loadAll(root).map(s => ({
          name: s.name, summary: s.summary, globs: s.globs,
          detector_score: s.detector_score, detector_signals: s.detector_signals,
        }));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(systems, null, 2));
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(err));
    }
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      const url = `http://127.0.0.1:${actualPort}/`;
      process.stdout.write(`systems-registry view → ${url}\n`);
      if (open) openBrowser(url);
      resolve({ server, url, port: actualPort });
    });
  });
}

export const _internal = { renderPage, renderMarkdown, inlineMd };
