#!/usr/bin/env node
/**
 * systems-registry — manifest loader + glob matcher.
 *
 * Reads every docs/systems/*.md, parses the YAML front-matter (a tiny
 * subset — no real YAML parser needed; we only handle scalars, lists,
 * and one-level maps that match the manifest schema), and exposes:
 *
 *   loadAll(repoRoot)        → array of {name, summary, globs, inject, ...}
 *   match(systems, path)     → array of systems whose globs cover `path`
 *   renderInjection(system, repoRoot) → string to print on stdout
 *
 * Used by inject.mjs (the PreToolUse hook) and by cli.mjs.
 *
 * The glob matcher implements just enough of the gitignore-style language
 * to handle the patterns we actually write in manifests: `**`, `*`, `?`,
 * literal segments. Not minimatch-complete — but neither do we want a
 * dependency for something this small.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const SYSTEMS_DIR = 'docs/systems';

function readSafe(p) {
  try { return readFileSync(p, 'utf8'); } catch { return ''; }
}

/**
 * Tiny YAML front-matter parser. Recognises:
 *   key: value                     (scalar)
 *   key: true / false / number     (typed scalars)
 *   key:                           (start of list or map)
 *     - item                       (list item)
 *     subkey: subvalue             (map entry)
 *   "quoted: value"                (quoted strings)
 *
 * Returns { rest, frontMatter } where rest is everything after the
 * closing `---`. If no front-matter is present, returns { rest: input, frontMatter: null }.
 */
export function parseFrontMatter(text) {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) {
    return { rest: text, frontMatter: null };
  }
  const lines = text.split('\n');
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { end = i; break; }
  }
  if (end === -1) return { rest: text, frontMatter: null };

  const body = lines.slice(1, end);
  const fm = {};
  let currentKey = null;
  let currentList = null;
  let currentMap = null;

  // YAML block scalars, handled before the line loop so their continuation
  // lines are not mistaken for list items or map entries.
  //
  // Half of pbx-platform's system manifests (15 of 30) write `summary: >-`
  // and continue on indented lines. Without this the value parsed as the
  // literal ">-", and every consumer — the inject hook and the PR comment —
  // displayed ">-" where the system's one-line description belongs.
  const consumed = new Set();
  for (let i = 0; i < body.length; i++) {
    const bm = body[i].match(/^([a-zA-Z_][\w-]*):\s*([>|])[-+]?\s*$/);
    if (!bm) continue;
    const [, key, style] = bm;
    const parts = [];
    for (let j = i + 1; j < body.length; j++) {
      if (body[j].trim() && !/^\s/.test(body[j])) break; // dedent ends the block
      consumed.add(j);
      parts.push(body[j].trim());
    }
    // `>` folds newlines into spaces; `|` keeps them.
    fm[key] = (style === '>' ? parts.filter(Boolean).join(' ') : parts.join('\n')).trim();
    consumed.add(i);
  }

  for (let bi = 0; bi < body.length; bi++) {
    if (consumed.has(bi)) continue;
    const raw = body[bi];
    if (!raw.trim()) continue;
    if (raw.match(/^\s+- /)) {
      // list item
      const val = parseScalar(raw.replace(/^\s+- /, '').trim());
      if (currentList) currentList.push(val);
      continue;
    }
    if (raw.match(/^\s{2,}\S+:/)) {
      // map entry under currentKey
      const m = raw.match(/^\s+(\S+):\s*(.*)$/);
      if (m && currentMap) currentMap[m[1]] = parseScalar(m[2]);
      continue;
    }
    // Top-level key
    const m = raw.match(/^([a-zA-Z_][\w-]*):\s*(.*)$/);
    if (!m) continue;
    const [, key, rawVal] = m;
    currentKey = key;
    currentList = null;
    currentMap = null;
    if (rawVal === '') {
      // expect list or map on subsequent indented lines — start one of each;
      // first child line decides
      currentList = [];
      currentMap = {};
      fm[key] = currentList;
      // we'll swap to currentMap if we see a map entry instead
    } else {
      fm[key] = parseScalar(rawVal);
    }
  }

  // Promote map-typed keys where we saw map entries but emitted a list
  for (const [k, v] of Object.entries(fm)) {
    if (Array.isArray(v) && v.length === 0) {
      // it might have been a map — but we lost it; the parser above
      // is dumb. Re-run quickly looking for map entries under this key.
      const idx = body.findIndex(l => l.startsWith(`${k}:`));
      if (idx >= 0) {
        const child = {};
        for (let i = idx + 1; i < body.length; i++) {
          if (!body[i].startsWith(' ')) break;
          if (body[i].match(/^\s+- /)) break;
          const mm = body[i].match(/^\s+(\S+):\s*(.*)$/);
          if (mm) child[mm[1]] = parseScalar(mm[2]);
        }
        if (Object.keys(child).length > 0) fm[k] = child;
      }
    }
  }

  const rest = lines.slice(end + 1).join('\n');
  return { rest, frontMatter: fm };
}

function parseScalar(raw) {
  const v = raw.trim();
  if (v === '') return '';
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  // strip matching quotes
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

// ─── glob matcher ─────────────────────────────────────────────────────────

/**
 * Compile a glob to a RegExp. Supports `**` (any path including slashes),
 * `*` (no slash), `?` (single non-slash), and literal segments.
 *
 * Special case: `prefix/**` matches `prefix` itself AND any descendant —
 * the slash before `**` is treated as optional. So `tools/docgen/**`
 * matches both `tools/docgen` and `tools/docgen/x.ts`.
 */
export function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    // Look-ahead for the `/` + `**` pattern (with optional trailing `/`)
    if (c === '/' && glob[i + 1] === '*' && glob[i + 2] === '*') {
      // Make the slash-and-everything-after optional
      re += '(/.*)?';
      i += 2;  // consume the **
      if (glob[i + 1] === '/') i++;  // consume any trailing slash
      continue;
    }
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^$()|{}[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

export function matchGlob(path, glob) {
  return globToRegex(glob).test(path);
}

// ─── manifest loader ──────────────────────────────────────────────────────

export function loadAll(repoRoot) {
  const dir = resolve(repoRoot, SYSTEMS_DIR);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isFile() || !ent.name.endsWith('.md')) continue;
    if (ent.name === 'README.md') continue;  // registry overview, not a system
    const full = join(dir, ent.name);
    const text = readSafe(full);
    const { rest, frontMatter } = parseFrontMatter(text);
    if (!frontMatter || !frontMatter.name) continue;
    if (frontMatter.status === 'draft') continue;  // skip drafts at injection time
    out.push({
      ...frontMatter,
      _body: rest,
      _path: full,
      _relPath: relative(repoRoot, full),
    });
  }
  return out;
}

export function match(systems, path) {
  return systems.filter(s => {
    if (!Array.isArray(s.globs)) return false;
    return s.globs.some(g => matchGlob(path, g));
  });
}

/**
 * Extract the first Mermaid block from a system's body. Returns the
 * full ```mermaid …``` fenced block, or null if none.
 *
 * Kept for backward compatibility; new callers prefer extractAllMermaid.
 */
export function extractMermaid(body) {
  const m = body.match(/```mermaid\n[\s\S]*?\n```/);
  return m ? m[0] : null;
}

/**
 * Extract every Mermaid block from a system's body, paired with the
 * nearest preceding `##` heading. Used so subflow diagrams ride along
 * with the top-level Loop instead of being silently dropped.
 */
export function extractAllMermaid(body) {
  const matches = [...body.matchAll(/```mermaid\n[\s\S]*?\n```/g)];
  return matches.map(m => {
    const before = body.slice(0, m.index);
    const lastHeading = before.match(/(?:^|\n)## ([^\n]+)\n(?![\s\S]*\n## )/);
    return { heading: lastHeading ? lastHeading[1].trim() : '', block: m[0] };
  });
}

function buildInjection(system, mermaidBlocks, wantLink) {
  const parts = [];
  parts.push(`<!-- systems-registry: ${system.name} -->`);
  if (system.summary) parts.push(system.summary);
  for (const { heading, block } of mermaidBlocks) {
    if (heading) parts.push(`### ${heading}\n\n${block}`);
    else parts.push(block);
  }
  if (wantLink && system._relPath) parts.push(`Full page: ${system._relPath}`);
  return parts.join('\n\n') + '\n';
}

export function renderInjection(system, opts = {}) {
  // Default cap bumped 4KB → 10KB. Empirically the worst-case system
  // doc has ~4.3KB of total mermaid; the old 4KB ceiling forced
  // emitting only the first diagram, hiding subflows from the model.
  const cap = system.inject?.cap_bytes ?? 10240;
  const wantMermaid = system.inject?.mermaid !== false;
  const wantLink = system.inject?.page_link !== false;

  const blocks = wantMermaid ? extractAllMermaid(system._body || '') : [];
  let out = buildInjection(system, blocks, wantLink);
  if (out.length <= cap) return out;

  // Whole-block trim: drop trailing blocks one at a time until it fits.
  // Better than truncating mid-diagram (which produces invalid mermaid).
  for (let n = blocks.length - 1; n > 0; n--) {
    const trimmed = buildInjection(system, blocks.slice(0, n), wantLink);
    if (trimmed.length <= cap) return trimmed;
  }
  // Fallback only if a single block exceeds cap — hard truncate.
  return out.slice(0, cap) + '\n…(truncated)\n';
}
